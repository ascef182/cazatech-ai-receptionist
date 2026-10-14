import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../src/db/pool.js';
import { buildApp } from '../../src/http/app.js';
import { BullConversationQueue, createRedis } from '../../src/queue/conversation-queue.js';
import { startConversationWorker, startMaintenance } from '../../src/worker/run-worker.js';
import { llmText, llmTool, ScriptedLlm } from '../../src/ai/llm.js';
import { APP_SECRET, TEST_REDIS_URL, VERIFY_TOKEN, freshDb, makeProcessorDeps, seedTenant, signed, silentLog, textEvent, truncateAll, waitFor } from '../helpers/setup.js';

// Ponta a ponta: HTTP real (Fastify escutando numa porta) -> Postgres -> BullMQ/Redis real -> worker -> WhatsApp simulado.
// Externos simulados: Meta (envio), LLM e Google Calendar.

let db: Db;
const prefix = `aire2e-${randomUUID().slice(0, 6)}`;
const producer = createRedis(TEST_REDIS_URL);
const workerConn = createRedis(TEST_REDIS_URL, { forWorker: true });
const queue = new BullConversationQueue(producer, prefix, 400, 1000);
const config = { WHATSAPP_APP_SECRET: APP_SECRET, WHATSAPP_VERIFY_TOKEN: VERIFY_TOKEN, ENQUEUE_TIMEOUT_MS: 500, RATE_LIMIT_PER_MINUTE: 1000, ADMIN_RATE_LIMIT_PER_MINUTE: 100, STORE_WEBHOOK_PAYLOADS: true };

let app: Awaited<ReturnType<typeof buildApp>>;
let baseUrl = '';
let ctx: ReturnType<typeof makeProcessorDeps>;
let worker: ReturnType<typeof startConversationWorker>;

async function postWebhook(payload: unknown) {
  const s = signed(payload);
  return fetch(`${baseUrl}/webhooks/whatsapp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': s.signature }, body: s.raw });
}

beforeAll(async () => {
  db = await freshDb();
  app = await buildApp({ config, db, queue, logger: silentLog });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

beforeEach(async () => {
  await truncateAll(db);
  await queue.queue.obliterate({ force: true });
  ctx = makeProcessorDeps(db);
  worker = startConversationWorker(ctx.deps, workerConn, { prefix, concurrency: 4 });
});

afterAll(async () => {
  await worker?.close();
  await app.close();
  await queue.queue.obliterate({ force: true }).catch(() => undefined);
  await queue.close();
  producer.disconnect();
  workerConn.disconnect();
  await db.end();
});

describe('fluxo ponta a ponta', () => {
  it('rajada de mensagens -> um job (debounce) -> uma resposta enviada', async () => {
    const t = await seedTenant(db);
    (ctx.llm as ScriptedLlm).push(llmText('Olá! O corte feminino custa R$ 90. Quer agendar?'));
    for (const txt of ['oi', 'boa tarde', 'quanto custa o corte?']) expect((await postWebhook(textEvent(t.phoneNumberId, '5511988887777', txt))).status).toBe(200);
    await waitFor(() => ctx.wa.texts().length >= 1);
    await new Promise((r) => setTimeout(r, 800));
    expect(ctx.wa.texts()).toHaveLength(1);
    expect((ctx.llm as ScriptedLlm).calls).toHaveLength(1);
    await worker.close();
  });

  it('webhook duplicado pela Meta não gera resposta duplicada', async () => {
    const t = await seedTenant(db);
    (ctx.llm as ScriptedLlm).push(llmText('Olá!'));
    const ev = textEvent(t.phoneNumberId, '5511988887777', 'oi');
    await postWebhook(ev);
    await postWebhook(ev);
    await waitFor(() => ctx.wa.texts().length >= 1);
    await new Promise((r) => setTimeout(r, 800));
    expect(ctx.wa.texts()).toHaveLength(1);
    await worker.close();
  });

  it('agendamento completo em duas mensagens do cliente', async () => {
    const t = await seedTenant(db);
    const llm = ctx.llm as ScriptedLlm;
    let proposalId = '';
    llm.push(
      llmTool('check_availability', { service_id: t.serviceId, date: '2026-10-13', part_of_day: 'morning' }),
      (req) => llmTool('propose_booking', { slot_code: JSON.parse((req.messages.at(-1)!.content as any[])[0].content).slots[1].slot_code, customer_name: 'Carla' }),
      (req) => {
        proposalId = JSON.parse((req.messages.at(-1)!.content as any[])[0].content).proposal_id;
        return llmText('Tenho amanhã às 9h30 com a Ana. Posso confirmar?');
      },
    );
    await postWebhook(textEvent(t.phoneNumberId, '5511988887777', 'Quero cortar amanhã de manhã. Carla.'));
    await waitFor(() => ctx.wa.texts().length >= 1);

    llm.push(
      () => llmTool('confirm_proposal', { proposal_id: proposalId }),
      (req) => {
        const r = JSON.parse((req.messages.at(-1)!.content as any[])[0].content);
        return llmText(r.ok ? `Agendado: ${r.when}.` : 'Não consegui agendar.');
      },
    );
    await postWebhook(textEvent(t.phoneNumberId, '5511988887777', 'Sim, pode confirmar'));
    await waitFor(() => ctx.wa.texts().length >= 2);
    expect(ctx.wa.texts()[1]).toMatch(/Agendado: terça-feira, 13\/10, 09:30/);
    expect(ctx.calendar.activeEvents(t.calendarId)).toHaveLength(1);
    expect((await db.query(`SELECT status FROM bookings`)).rows[0].status).toBe('confirmed');
    await worker.close();
  });

  it('Redis fora do ar na API: mensagem guardada no outbox e respondida depois pelo reconciliador', async () => {
    const t = await seedTenant(db);
    const dead = createRedis('redis://127.0.0.1:6399');
    dead.on('error', () => undefined);
    const deadQueue = new BullConversationQueue(dead, prefix, 0, 300);
    const apiDown = await buildApp({ config, db, queue: deadQueue, logger: silentLog });
    const s = signed(textEvent(t.phoneNumberId, '5511988887777', 'oi'));
    const r = await apiDown.inject({ method: 'POST', url: '/webhooks/whatsapp', headers: { 'content-type': 'application/json', 'x-hub-signature-256': s.signature }, payload: s.raw });
    expect(r.statusCode).toBe(200);
    expect(ctx.wa.texts()).toHaveLength(0);

    (ctx.llm as ScriptedLlm).push(llmText('Olá! Desculpe a demora.'));
    const maint = startMaintenance(db, queue, silentLog, { intervalMs: 100, staleAfterMs: 60_000 });
    await waitFor(() => ctx.wa.texts().length >= 1);
    maint.stop();
    expect((await db.query(`SELECT count(*)::int AS n FROM outbox WHERE dispatched_at IS NULL`)).rows[0].n).toBe(0);
    await apiDown.close();
    await deadQueue.close().catch(() => undefined);
    dead.disconnect();
    await worker.close();
  });
});
