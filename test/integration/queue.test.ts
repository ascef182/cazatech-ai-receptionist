import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../src/db/pool.js';
import { BullConversationQueue, createRedis } from '../../src/queue/conversation-queue.js';
import { reconcileOnce } from '../../src/queue/reconciler.js';
import { buildApp } from '../../src/http/app.js';
import { APP_SECRET, TEST_REDIS_URL, VERIFY_TOKEN, freshDb, seedTenant, signed, silentLog, textEvent, truncateAll } from '../helpers/setup.js';

let db: Db;
const prefix = `airtest-${randomUUID().slice(0, 6)}`;
const redis = createRedis(TEST_REDIS_URL);
const queue = new BullConversationQueue(redis, prefix, 300, 1000);

beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await queue.queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  redis.disconnect();
  await db.end();
});
beforeEach(async () => {
  await truncateAll(db);
  await queue.queue.obliterate({ force: true });
});

describe('fila com debounce (BullMQ + Redis real)', () => {
  it('três mensagens em sequência geram um único job por conversa', async () => {
    const job = { tenantId: randomUUID(), conversationId: randomUUID() };
    await queue.enqueue(job);
    await queue.enqueue(job);
    await queue.enqueue(job);
    const other = { tenantId: job.tenantId, conversationId: randomUUID() };
    await queue.enqueue(other);
    const jobs = await queue.queue.getJobs(['delayed', 'waiting']);
    expect(jobs.filter((j) => j.data.conversationId === job.conversationId)).toHaveLength(1);
    expect(jobs).toHaveLength(2);
  });
});

describe('Redis indisponível', () => {
  it('enfileiramento falha rápido (sem travar o webhook)', async () => {
    const dead = createRedis('redis://127.0.0.1:6399');
    dead.on('error', () => undefined);
    const q = new BullConversationQueue(dead, prefix, 0, 300);
    const start = Date.now();
    await expect(q.enqueue({ tenantId: randomUUID(), conversationId: randomUUID() })).rejects.toThrow();
    expect(Date.now() - start).toBeLessThan(1500);
    await q.close().catch(() => undefined);
    dead.disconnect();
  });

  it('webhook responde 200 com Redis fora; reconciliador despacha quando o Redis volta', async () => {
    const t = await seedTenant(db);
    const dead = createRedis('redis://127.0.0.1:6399');
    dead.on('error', () => undefined);
    const deadQueue = new BullConversationQueue(dead, prefix, 0, 300);
    const app = await buildApp({
      config: { WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN, ENQUEUE_TIMEOUT_MS: 300, RATE_LIMIT_PER_MINUTE: 100, ADMIN_RATE_LIMIT_PER_MINUTE: 100, STORE_WEBHOOK_PAYLOADS: true },
      db,
      queue: deadQueue,
      logger: silentLog,
    });
    const s = signed(textEvent(t.phoneNumberId, '5511977776666', 'oi'));
    const start = Date.now();
    const r = await app.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': s.signature }, payload: s.raw });
    expect(r.statusCode).toBe(200);
    expect(Date.now() - start).toBeLessThan(2000);
    expect((await db.query(`SELECT count(*)::int AS n FROM outbox WHERE dispatched_at IS NULL`)).rows[0].n).toBe(1);

    // reconciliador ainda sem Redis: registra a tentativa e mantém pendente
    const r1 = await reconcileOnce(db, deadQueue, silentLog, { staleAfterMs: 60_000 });
    expect(r1.dispatched).toBe(0);
    const pending = await db.query(`SELECT attempts, last_error FROM outbox`);
    expect(pending.rows[0].attempts).toBe(1);
    expect(pending.rows[0].last_error).toBeTruthy();

    // Redis "volta": libera o backoff e despacha
    await db.query(`UPDATE outbox SET available_at = now()`);
    const r2 = await reconcileOnce(db, queue, silentLog, { staleAfterMs: 60_000 });
    expect(r2.dispatched).toBe(1);
    expect((await queue.queue.getJobs(['delayed', 'waiting'])).length).toBe(1);

    await app.close();
    await deadQueue.close().catch(() => undefined);
    dead.disconnect();
  });

  it('reenfileira conversas com mensagens paradas há mais tempo que o limite', async () => {
    const t = await seedTenant(db);
    const s = signed(textEvent(t.phoneNumberId, '5511977776666', 'oi'));
    const { ingestWebhook } = await import('../../src/whatsapp/ingest.js');
    await ingestWebhook(db, s.raw, { storePayload: false });
    await db.query(`UPDATE outbox SET dispatched_at = now()`); // simula job perdido
    await db.query(`UPDATE messages SET created_at = now() - interval '10 minutes'`);
    const r = await reconcileOnce(db, queue, silentLog, { staleAfterMs: 60_000 });
    expect(r.requeued).toBe(1);
  });

  it('reconciliador roda em uma instância por vez (advisory lock)', async () => {
    const c = await db.connect();
    await c.query(`SELECT pg_advisory_lock(727275)`);
    const r = await reconcileOnce(db, queue, silentLog, { staleAfterMs: 60_000 });
    expect(r.skipped).toBe(true);
    await c.query(`SELECT pg_advisory_unlock(727275)`);
    c.release();
  });
});
