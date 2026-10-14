import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/pool.js';
import { buildApp } from '../../src/http/app.js';
import { InMemoryConversationQueue } from '../../src/queue/conversation-queue.js';
import { APP_SECRET, VERIFY_TOKEN, freshDb, seedTenant, signed, silentLog, statusEvent, textEvent, truncateAll } from '../helpers/setup.js';

let db: Db;
let queue: InMemoryConversationQueue;
let app: Awaited<ReturnType<typeof buildApp>>;

const config = {
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN,
  ENQUEUE_TIMEOUT_MS: 300,
  RATE_LIMIT_PER_MINUTE: 1000,
  ADMIN_RATE_LIMIT_PER_MINUTE: 1000,
  STORE_WEBHOOK_PAYLOADS: true,
};

async function post(payload: unknown, sig?: string) {
  const s = signed(payload);
  return app.inject({
    method: 'POST',
    url: '/webhooks/whatsapp',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': sig ?? s.signature },
    payload: s.raw,
  });
}

beforeAll(async () => {
  db = await freshDb();
  queue = new InMemoryConversationQueue();
  app = await buildApp({ config, db, queue, logger: silentLog });
});
afterAll(async () => {
  await app.close();
  await db.end();
});
beforeEach(async () => {
  await truncateAll(db);
  queue.jobs = [];
  queue.down = false;
});

describe('verificação do endpoint (GET)', () => {
  it('devolve hub.challenge com o token correto', async () => {
    const r = await app.inject({ url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=12345` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toBe('12345');
  });
  it('recusa token errado', async () => {
    const r = await app.inject({ url: `/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=errado&hub.challenge=1` });
    expect(r.statusCode).toBe(403);
  });
});

describe('recebimento de eventos (POST)', () => {
  it('recusa assinatura inválida sem gravar nada', async () => {
    const t = await seedTenant(db);
    const r = await post(textEvent(t.phoneNumberId, '5511988887777', 'oi'), 'sha256=' + '0'.repeat(64));
    expect(r.statusCode).toBe(401);
    expect((await db.query('SELECT count(*)::int AS n FROM webhook_events')).rows[0].n).toBe(0);
  });

  it('grava contato, conversa, mensagem e outbox, e enfileira a conversa', async () => {
    const t = await seedTenant(db);
    const r = await post(textEvent(t.phoneNumberId, '5511988887777', 'Oi, quanto custa o corte?'));
    expect(r.statusCode).toBe(200);
    const m = await db.query(`SELECT body, status, direction FROM messages`);
    expect(m.rows).toEqual([{ body: 'Oi, quanto custa o corte?', status: 'received', direction: 'in' }]);
    expect(queue.jobs).toHaveLength(1);
    expect((await db.query(`SELECT dispatched_at FROM outbox`)).rows[0].dispatched_at).not.toBeNull();
  });

  it('webhook duplicado (mesmo corpo reentregue pela Meta) não duplica mensagem', async () => {
    const t = await seedTenant(db);
    const ev = textEvent(t.phoneNumberId, '5511988887777', 'oi');
    expect((await post(ev)).statusCode).toBe(200);
    expect((await post(ev)).statusCode).toBe(200);
    expect((await db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM webhook_events')).rows[0].n).toBe(1);
  });

  it('mesmo wamid em corpos diferentes também é deduplicado', async () => {
    const t = await seedTenant(db);
    await post(textEvent(t.phoneNumberId, '5511988887777', 'oi', { id: 'wamid.X1', ts: 1_800_000_000 }));
    await post(textEvent(t.phoneNumberId, '5511988887777', 'oi', { id: 'wamid.X1', ts: 1_800_000_001 }));
    expect((await db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(1);
    expect((await db.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n).toBe(1);
  });

  it('mensagens em sequência ficam na mesma conversa aberta', async () => {
    const t = await seedTenant(db);
    for (const txt of ['oi', 'tudo bem?', 'queria marcar um corte']) await post(textEvent(t.phoneNumberId, '5511988887777', txt));
    const r = await db.query(`SELECT count(DISTINCT conversation_id)::int AS convs, count(*)::int AS msgs FROM messages`);
    expect(r.rows[0]).toEqual({ convs: 1, msgs: 3 });
  });

  it('número desconhecido é registrado como ignorado e não cria dados', async () => {
    const r = await post(textEvent('numero-desconhecido', '5511988887777', 'oi'));
    expect(r.statusCode).toBe(200);
    expect((await db.query(`SELECT status FROM webhook_events`)).rows[0].status).toBe('ignored');
    expect((await db.query('SELECT count(*)::int AS n FROM contacts')).rows[0].n).toBe(0);
  });

  it('payload malformado é aceito (200) e marcado como inválido, sem reentrega infinita', async () => {
    const r = await post({ object: 'outra_coisa' });
    expect(r.statusCode).toBe(200);
    expect((await db.query(`SELECT status FROM webhook_events`)).rows[0].status).toBe('invalid');
  });

  it('status de entrega só avança (sent -> delivered -> read), nunca regride', async () => {
    const t = await seedTenant(db);
    await post(textEvent(t.phoneNumberId, '5511988887777', 'oi'));
    const conv = (await db.query(`SELECT id FROM conversations`)).rows[0].id;
    await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, author, kind, body, status, wa_message_id) VALUES ($1,$2,'out','ai','text','olá','sent','wamid.OUT1')`,
      [t.tenantId, conv],
    );
    await post(statusEvent(t.phoneNumberId, 'wamid.OUT1', 'read'));
    await post(statusEvent(t.phoneNumberId, 'wamid.OUT1', 'delivered'));
    expect((await db.query(`SELECT status FROM messages WHERE wa_message_id = 'wamid.OUT1'`)).rows[0].status).toBe('read');
  });

  it('isolamento: o mesmo cliente em duas empresas gera contatos separados', async () => {
    const a = await seedTenant(db, { slug: 'empresa-a' });
    const b = await seedTenant(db, { slug: 'empresa-b' });
    await post(textEvent(a.phoneNumberId, '5511988887777', 'oi A'));
    await post(textEvent(b.phoneNumberId, '5511988887777', 'oi B'));
    const r = await db.query(`SELECT tenant_id, count(*)::int AS n FROM contacts GROUP BY tenant_id ORDER BY tenant_id`);
    expect(r.rows).toHaveLength(2);
    const m = await db.query(`SELECT m.body, c.tenant_id FROM messages m JOIN conversations c ON c.id = m.conversation_id ORDER BY m.body`);
    expect(m.rows.map((x) => [x.body, x.tenant_id])).toEqual([
      ['oi A', a.tenantId],
      ['oi B', b.tenantId],
    ]);
  });

  it('o banco impede mensagem apontando para conversa de outra empresa (FK composta)', async () => {
    const a = await seedTenant(db, { slug: 'empresa-a' });
    const b = await seedTenant(db, { slug: 'empresa-b' });
    await post(textEvent(a.phoneNumberId, '5511988887777', 'oi'));
    const convA = (await db.query(`SELECT id FROM conversations WHERE tenant_id = $1`, [a.tenantId])).rows[0].id;
    await expect(
      db.query(`INSERT INTO messages (tenant_id, conversation_id, direction, author, kind, body, status) VALUES ($1,$2,'in','contact','text','x','received')`, [
        b.tenantId,
        convA,
      ]),
    ).rejects.toThrow(/foreign key/);
  });
});

describe('Redis indisponível', () => {
  it('webhook continua respondendo 200 e o evento fica no outbox para despacho posterior', async () => {
    const t = await seedTenant(db);
    queue.down = true;
    const r = await post(textEvent(t.phoneNumberId, '5511988887777', 'oi'));
    expect(r.statusCode).toBe(200);
    expect((await db.query('SELECT count(*)::int AS n FROM messages')).rows[0].n).toBe(1);
    const ob = await db.query(`SELECT dispatched_at FROM outbox`);
    expect(ob.rows[0].dispatched_at).toBeNull();
  });
});

describe('administração', () => {
  it('exige chave válida e só enxerga conversas da própria empresa', async () => {
    const a = await seedTenant(db, { slug: 'empresa-a' });
    const b = await seedTenant(db, { slug: 'empresa-b' });
    await post(textEvent(a.phoneNumberId, '5511988887777', 'oi'));
    const convA = (await db.query(`SELECT id FROM conversations WHERE tenant_id = $1`, [a.tenantId])).rows[0].id;
    await db.query(`UPDATE conversations SET status = 'human' WHERE id = $1`, [convA]);

    expect((await app.inject({ method: 'GET', url: '/admin/conversations' })).statusCode).toBe(401);
    const asB = await app.inject({ method: 'POST', url: `/admin/conversations/${convA}/release`, headers: { authorization: `Bearer ${b.adminKey}` } });
    expect(asB.statusCode).toBe(404);
    const listB = await app.inject({ method: 'GET', url: '/admin/conversations', headers: { authorization: `Bearer ${b.adminKey}` } });
    expect(listB.json()).toEqual([]);
    const asA = await app.inject({ method: 'POST', url: `/admin/conversations/${convA}/release`, headers: { authorization: `Bearer ${a.adminKey}` } });
    expect(asA.statusCode).toBe(200);
    expect((await db.query(`SELECT status FROM conversations WHERE id = $1`, [convA])).rows[0].status).toBe('bot');
    expect((await db.query(`SELECT action FROM audit_log`)).rows.map((r) => r.action)).toContain('conversation.release_to_bot');
  });
});
