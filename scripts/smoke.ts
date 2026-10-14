/**
 * Teste de fumaça dos processos reais (API + worker) sem credenciais externas:
 *  - sobe um servidor local que imita a Graph API da Meta (só para receber os envios)
 *  - aplica migrações e cria uma empresa de demonstração
 *  - inicia `src/main-api.ts` e `src/main-worker.ts` como processos separados (LLM em modo demonstração)
 *  - envia um webhook assinado por HTTP e espera a resposta chegar ao servidor simulado
 * Requer Postgres e Redis acessíveis (DATABASE_URL, REDIS_URL).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { encryptSecret, signMetaBody } from '../src/lib/crypto.js';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://air:air@localhost:5432/air_smoke';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const APP_SECRET = 'smoke-app-secret';
const KEY = randomBytes(32).toString('base64');
const API_PORT = 3199;
const GRAPH_PORT = 3198;

const sent: any[] = [];
const graph = Fastify();
graph.post('/v25.0/:pn/messages', async (req) => {
  sent.push(req.body);
  return { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: `wamid.smoke.${sent.length}` }] };
});
await graph.listen({ port: GRAPH_PORT, host: '127.0.0.1' });

const db = createPool(DATABASE_URL);
await db.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
await migrate(db);
const t = await db.query(`INSERT INTO tenants (name, slug) VALUES ('Studio Smoke','studio-smoke') RETURNING id`);
const tenantId = t.rows[0].id;
await db.query(`INSERT INTO tenant_settings (tenant_id, booking_enabled) VALUES ($1, false)`, [tenantId]);
await db.query(`INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, access_token_ciphertext) VALUES ($1,'PN_SMOKE',$2)`, [tenantId, encryptSecret('token', KEY)]);

const env = {
  ...process.env,
  DATABASE_URL,
  REDIS_URL,
  QUEUE_PREFIX: `smoke-${Date.now()}`,
  PORT: String(API_PORT),
  LOG_LEVEL: 'warn',
  WHATSAPP_APP_SECRET: APP_SECRET,
  WHATSAPP_VERIFY_TOKEN: 'smoke-verify-token-123',
  WHATSAPP_GRAPH_BASE_URL: `http://127.0.0.1:${GRAPH_PORT}`,
  DATA_ENCRYPTION_KEY: KEY,
  HANDOFF_SIGNING_SECRET: 'smoke-handoff-secret',
  LLM_PROVIDER: 'fake',
  STT_PROVIDER: 'disabled',
  DEBOUNCE_MS: '300',
};
const procs: ChildProcess[] = [];
const start = (file: string) => {
  const p = spawn(process.execPath, ['--import', 'tsx', file], { env, stdio: ['ignore', 'inherit', 'inherit'] });
  procs.push(p);
  return p;
};
const cleanup = async () => {
  procs.forEach((p) => p.kill('SIGTERM'));
  await graph.close();
  await db.end();
};

try {
  start('src/main-api.ts');
  start('src/main-worker.ts');
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${API_PORT}/health/ready`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const ready = await (await fetch(`http://127.0.0.1:${API_PORT}/health/ready`)).json();
  console.log('readiness:', ready);

  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'W', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: 'PN_SMOKE' }, contacts: [{ wa_id: '5511900000000', profile: { name: 'Teste' } }], messages: [{ from: '5511900000000', id: 'wamid.in.smoke', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Olá, teste de fumaça' } }] } }] }],
  });
  const res = await fetch(`http://127.0.0.1:${API_PORT}/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signMetaBody(body, APP_SECRET) },
    body,
  });
  console.log('webhook HTTP', res.status);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !sent.some((s) => s.type === 'text')) await new Promise((r) => setTimeout(r, 200));
  const reply = sent.find((s) => s.type === 'text');
  if (!reply) throw new Error('nenhuma resposta chegou à Graph API simulada');
  console.log('resposta enviada para', reply.to, '->', reply.text.body.replace(/\n/g, ' ').slice(0, 160));
  const out = await db.query(`SELECT status, wa_message_id FROM messages WHERE direction = 'out'`);
  console.log('mensagem de saída no banco:', out.rows[0]);
  console.log('SMOKE OK');
  await cleanup();
  process.exit(0);
} catch (err) {
  console.error('SMOKE FALHOU:', (err as Error).message);
  await cleanup();
  process.exit(1);
}
