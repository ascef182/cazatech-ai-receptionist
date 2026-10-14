import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/pool.js';
import { ingestWebhook } from '../../src/whatsapp/ingest.js';
import { processConversation } from '../../src/worker/processor.js';
import { llmText, llmTool, ScriptedLlm } from '../../src/ai/llm.js';
import { HttpError } from '../../src/lib/errors.js';
import { createHumanActions } from '../../src/handoff/human-actions.js';
import { ENC_KEY, freshDb, makeProcessorDeps, seedTenant, signed, textEvent, truncateAll, type SeededTenant } from '../helpers/setup.js';
import { purgeRetention } from '../../src/worker/retention.js';

let db: Db;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await truncateAll(db);
});

const CUSTOMER = '5511988887777';

async function send(t: SeededTenant, text: string, from = CUSTOMER) {
  const r = await ingestWebhook(db, signed(textEvent(t.phoneNumberId, from, text)).raw, { storePayload: false });
  return r.toProcess[0] ?? { tenantId: t.tenantId, conversationId: (await db.query(`SELECT id FROM conversations LIMIT 1`)).rows[0].id };
}

describe('processamento de conversa', () => {
  it('mensagens em sequência viram uma única chamada ao modelo e uma única resposta', async () => {
    const t = await seedTenant(db);
    const { deps, llm, wa } = makeProcessorDeps(db);
    (llm as ScriptedLlm).push(llmText('Olá, Carla! O corte feminino custa R$ 90.'));
    await send(t, 'oi');
    await send(t, 'tudo bem?');
    const job = await send(t, 'quanto custa o corte?');
    const r = await processConversation(deps, job);
    expect(r).toMatchObject({ status: 'done', replies: 1 });
    expect((llm as ScriptedLlm).calls).toHaveLength(1);
    const userTurn = (llm as ScriptedLlm).calls[0]!.messages[0]!.content as string;
    expect(userTurn).toContain('oi');
    expect(userTurn).toContain('quanto custa o corte?');
    expect(wa.texts(CUSTOMER)).toHaveLength(1);
    // primeira interação inclui o aviso de atendimento automatizado
    expect(wa.texts(CUSTOMER)[0]).toMatch(/assistente virtual.*atendente/s);
    const pending = await db.query(`SELECT count(*)::int AS n FROM messages WHERE direction = 'in' AND processed_at IS NULL`);
    expect(pending.rows[0].n).toBe(0);
  });

  it('dois workers na mesma conversa: só um processa (lease)', async () => {
    const t = await seedTenant(db);
    const a = makeProcessorDeps(db);
    const b = makeProcessorDeps(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (a.llm as ScriptedLlm).push(async () => {
      await gate;
      return llmText('resposta A');
    });
    (b.llm as ScriptedLlm).push(llmText('resposta B'));
    const job = await send(t, 'oi');
    const pa = processConversation(a.deps, job);
    await new Promise((r) => setTimeout(r, 100));
    const rb = await processConversation(b.deps, job);
    expect(rb.status).toBe('busy');
    release();
    expect((await pa).status).toBe('done');
    expect(a.wa.texts().length + b.wa.texts().length).toBe(1);
  });

  it('dois jobs da mesma conversa no MESMO processo também se excluem', async () => {
    const t = await seedTenant(db);
    const a = makeProcessorDeps(db);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    (a.llm as ScriptedLlm).push(async () => {
      await gate;
      return llmText('resposta');
    });
    const job = await send(t, 'oi');
    const p1 = processConversation(a.deps, job);
    await new Promise((r) => setTimeout(r, 100));
    const r2 = await processConversation(a.deps, job); // mesmo workerId
    expect(r2.status).toBe('busy');
    release();
    await p1;
    expect(a.wa.texts()).toHaveLength(1);
  });

  it('repetição de job após falha temporária do modelo não duplica resposta', async () => {
    const t = await seedTenant(db);
    const { deps, llm, wa } = makeProcessorDeps(db);
    (llm as ScriptedLlm).push(new HttpError('anthropic', 529, 'overloaded'), llmText('Olá!'));
    const job = await send(t, 'oi');
    await expect(processConversation(deps, job)).rejects.toThrow(/529/);
    expect(wa.texts()).toHaveLength(0);
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE direction='in' AND processed_at IS NULL`)).rows[0].n).toBe(1);
    const r2 = await processConversation(deps, job);
    expect(r2.replies).toBe(1);
    const r3 = await processConversation(deps, job); // job duplicado: nada pendente
    expect(r3.replies).toBe(0);
    expect(wa.texts()).toHaveLength(1);
  });

  it('última tentativa com o modelo fora do ar: resposta de contingência e transferência', async () => {
    const t = await seedTenant(db);
    const { deps, llm, wa, notifier } = makeProcessorDeps(db);
    (llm as ScriptedLlm).push(new HttpError('anthropic', 503, 'down'));
    const job = await send(t, 'oi');
    await processConversation(deps, job, { finalAttempt: true });
    expect(wa.texts()[0]).toMatch(/equipe/);
    expect((await db.query(`SELECT status, handoff_reason FROM conversations`)).rows[0]).toEqual({ status: 'human', handoff_reason: 'ai_unavailable' });
    expect(notifier.events[0]).toMatchObject({ reason: 'ai_unavailable' });
  });

  it('falha temporária no envio do WhatsApp: resposta fica pendente e é reenviada na nova tentativa', async () => {
    const t = await seedTenant(db);
    const { deps, llm, wa } = makeProcessorDeps(db);
    (llm as ScriptedLlm).push(llmText('Olá!'));
    wa.failNextSends = 1;
    const job = await send(t, 'oi');
    await expect(processConversation(deps, job)).rejects.toThrow();
    expect((await db.query(`SELECT status FROM messages WHERE direction='out'`)).rows[0].status).toBe('pending');
    await processConversation(deps, job);
    expect(wa.texts()).toHaveLength(1);
    expect((await db.query(`SELECT status FROM messages WHERE direction='out'`)).rows[0].status).toBe('sent');
    expect((llm as ScriptedLlm).calls).toHaveLength(1); // o modelo não foi chamado de novo
  });
});

describe('transferência para atendimento humano', () => {
  it('pedido explícito transfere sem chamar o modelo; mensagens seguintes não recebem resposta automática', async () => {
    const t = await seedTenant(db);
    const { deps, llm, wa, notifier } = makeProcessorDeps(db);
    const job = await send(t, 'quero falar com um atendente');
    await processConversation(deps, job);
    expect((llm as ScriptedLlm).calls).toHaveLength(0);
    expect(wa.texts()[0]).toMatch(/pessoa da equipe/);
    expect(notifier.events).toHaveLength(1);
    expect(notifier.events[0]).not.toHaveProperty('phone');

    await send(t, 'alô?');
    await processConversation(deps, job);
    expect(wa.texts()).toHaveLength(1);
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE direction='in' AND processed_at IS NULL`)).rows[0].n).toBe(0);
  });

  it('modelo pode transferir (ex.: reclamação); equipe responde pelo painel e devolve ao bot', async () => {
    const t = await seedTenant(db);
    const { deps, llm, wa } = makeProcessorDeps(db);
    (llm as ScriptedLlm).push(llmTool('handoff_to_human', { reason: 'complaint', note: 'cliente insatisfeito com o resultado' }), llmText('Sinto muito! Vou passar para a equipe.'));
    const job = await send(t, 'Meu cabelo ficou horrível, estou muito chateada');
    await processConversation(deps, job);
    expect((await db.query(`SELECT status, handoff_reason FROM conversations`)).rows[0]).toEqual({ status: 'human', handoff_reason: 'complaint' });

    const human = createHumanActions(db, wa, ENC_KEY);
    await human.sendHumanReply(t.tenantId, job.conversationId, 'Oi, aqui é a Ana. Vamos resolver!', 'admin:teste');
    expect(wa.texts().at(-1)).toBe('Oi, aqui é a Ana. Vamos resolver!');
    expect((await db.query(`SELECT author, status FROM messages WHERE direction='out' ORDER BY created_at DESC LIMIT 1`)).rows[0]).toEqual({ author: 'human', status: 'sent' });
  });

  it('limite de custo diário esgotado: não chama o modelo e transfere', async () => {
    const t = await seedTenant(db, { budgetMicros: 1000 });
    const { deps, llm, wa } = makeProcessorDeps(db);
    await db.query(`INSERT INTO agent_runs (tenant_id, conversation_id, model, cost_micros, outcome) VALUES ($1, gen_random_uuid(), 'm', 5000, 'reply')`, [t.tenantId]);
    const job = await send(t, 'oi');
    await processConversation(deps, job);
    expect((llm as ScriptedLlm).calls).toHaveLength(0);
    expect((await db.query(`SELECT handoff_reason FROM conversations`)).rows[0].handoff_reason).toBe('budget_exceeded');
    expect(wa.texts()).toHaveLength(1);
  });

  it('limite de iterações do agente: contingência + transferência e custo registrado', async () => {
    const t = await seedTenant(db);
    const { deps, llm } = makeProcessorDeps(db, {});
    deps.config = { ...deps.config, AGENT_MAX_ITERATIONS: 2 };
    (llm as ScriptedLlm).push(llmTool('list_services', {}), llmTool('list_services', {}));
    const job = await send(t, 'oi');
    await processConversation(deps, job);
    const run = (await db.query(`SELECT outcome, iterations, cost_micros FROM agent_runs`)).rows[0];
    expect(run.outcome).toBe('limit_iterations');
    expect(run.iterations).toBe(2);
    expect(Number(run.cost_micros)).toBeGreaterThan(0);
    expect((await db.query(`SELECT handoff_reason FROM conversations`)).rows[0].handoff_reason).toBe('agent_limit_iterations');
  });

  it('IA desligada pela empresa: registra mas não responde', async () => {
    const t = await seedTenant(db, { aiEnabled: false });
    const { deps, wa } = makeProcessorDeps(db);
    const job = await send(t, 'oi');
    await processConversation(deps, job);
    expect(wa.texts()).toHaveLength(0);
  });

  it('mensagens reentregues com mais de 24h de atraso não recebem resposta automática', async () => {
    const t = await seedTenant(db);
    const { deps, wa, notifier } = makeProcessorDeps(db);
    const ev = textEvent(t.phoneNumberId, CUSTOMER, 'oi', { ts: Math.floor(new Date('2026-10-10T10:00:00Z').getTime() / 1000) });
    const r = await ingestWebhook(db, signed(ev).raw, { storePayload: false });
    await processConversation(deps, r.toProcess[0]!);
    expect(wa.texts()).toHaveLength(0);
    expect(notifier.events[0]?.reason).toBe('stale_messages');
  });
});

describe('agenda pelo agente', () => {
  async function bookingFlow(t: SeededTenant, ctx: ReturnType<typeof makeProcessorDeps>, from = CUSTOMER) {
    const llm = ctx.llm as ScriptedLlm;
    let slotCode = '';
    let proposalId = '';
    // turno 1: consulta e propõe
    llm.push(
      llmTool('check_availability', { service_id: t.serviceId, date: '2026-10-13' }),
      (req) => {
        const res = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content);
        slotCode = res.slots[0].slot_code;
        return llmTool('propose_booking', { slot_code: slotCode, customer_name: 'Carla' });
      },
      (req) => {
        proposalId = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content).proposal_id;
        return llmText('Posso confirmar o corte amanhã às 9h com a Ana?');
      },
    );
    const job = await send(t, 'Quero cortar o cabelo amanhã de manhã, sou a Carla', from);
    await processConversation(ctx.deps, job);
    return { job, slotCode: () => slotCode, proposalId: () => proposalId };
  }

  it('fluxo completo: consulta, proposta, confirmação do cliente e evento criado na agenda', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    const f = await bookingFlow(t, ctx);
    expect(ctx.calendar.activeEvents(t.calendarId)).toHaveLength(0); // nada criado sem confirmação

    const llm = ctx.llm as ScriptedLlm;
    let toolResult: any;
    llm.push(llmTool('confirm_proposal', { proposal_id: f.proposalId() }), (req) => {
      toolResult = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content);
      return llmText('Pronto! Seu corte está agendado para amanhã às 9h.');
    });
    await send(t, 'sim, pode marcar');
    await processConversation(ctx.deps, f.job);
    expect(toolResult).toMatchObject({ ok: true, confirmed_by_calendar: true });
    const b = (await db.query(`SELECT status, external_event_id, starts_at FROM bookings`)).rows;
    expect(b).toHaveLength(1);
    expect(b[0].status).toBe('confirmed');
    expect(b[0].starts_at.toISOString()).toBe('2026-10-13T12:00:00.000Z'); // 09:00 em São Paulo
    expect(ctx.calendar.activeEvents(t.calendarId)).toHaveLength(1);
    expect((await db.query(`SELECT action FROM audit_log WHERE action LIKE 'booking%'`)).rows[0].action).toBe('booking.created');
  });

  it('confirmação sem nova mensagem do cliente é recusada', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    const llm = ctx.llm as ScriptedLlm;
    let slot = '';
    let res: any;
    llm.push(
      llmTool('check_availability', { service_id: t.serviceId, date: '2026-10-13' }),
      (req) => {
        slot = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content).slots[0].slot_code;
        return llmTool('propose_booking', { slot_code: slot, customer_name: 'Carla' });
      },
      (req) => llmTool('confirm_proposal', { proposal_id: JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content).proposal_id }),
      (req) => {
        res = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content);
        return llmText('Posso confirmar?');
      },
    );
    const job = await send(t, 'quero marcar amanhã');
    await processConversation(ctx.deps, job);
    expect(res).toMatchObject({ ok: false, error: 'not_confirmed_by_customer' });
    expect((await db.query(`SELECT count(*)::int AS n FROM bookings`)).rows[0].n).toBe(0);
  });

  it('duas solicitações para o mesmo horário: apenas uma reserva é criada', async () => {
    const t = await seedTenant(db);
    const c1 = makeProcessorDeps(db);
    const c2 = makeProcessorDeps(db);
    c2.deps.booking = c1.deps.booking; // mesma agenda externa simulada
    const f1 = await bookingFlow(t, c1, '5511900000001');
    const f2 = await bookingFlow(t, c2, '5511900000002');
    const results: any[] = [];
    for (const [ctx, f] of [
      [c1, f1],
      [c2, f2],
    ] as const) {
      (ctx.llm as ScriptedLlm).push(llmTool('confirm_proposal', { proposal_id: f.proposalId() }), (req) => {
        results.push(JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content));
        return llmText('ok');
      });
    }
    await send(t, 'sim', '5511900000001');
    await send(t, 'sim', '5511900000002');
    // atraso no freeBusy faz os dois workers passarem pela revalidação antes de qualquer evento existir:
    // quem decide é a constraint de exclusão do Postgres
    c1.calendar.busyDelayMs = 150;
    await Promise.all([processConversation(c1.deps, f1.job), processConversation(c2.deps, f2.job)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({ error: 'slot_taken' });
    expect((await db.query(`SELECT count(*)::int AS n FROM bookings WHERE status IN ('pending','confirmed')`)).rows[0].n).toBe(1);
    expect(c1.calendar.activeEvents(t.calendarId)).toHaveLength(1);
  });

  it('horário ocupado manualmente na agenda entre a oferta e a confirmação: recusa e não cria evento', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    const f = await bookingFlow(t, ctx);
    ctx.calendar.externalBusy.set(t.calendarId, [{ start: new Date('2026-10-13T12:00:00Z'), end: new Date('2026-10-13T13:00:00Z') }]);
    let res: any;
    (ctx.llm as ScriptedLlm).push(llmTool('confirm_proposal', { proposal_id: f.proposalId() }), (req) => {
      res = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content);
      return llmText('Esse horário acabou de ser ocupado.');
    });
    await send(t, 'sim');
    await processConversation(ctx.deps, f.job);
    expect(res).toMatchObject({ ok: false, error: 'slot_taken' });
    expect(ctx.calendar.activeEvents(t.calendarId)).toHaveLength(0);
    expect((await db.query(`SELECT status FROM bookings`)).rows[0].status).toBe('failed');
  });

  it('falha permanente na criação do evento: reserva marcada como falha e nada confirmado', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    const f = await bookingFlow(t, ctx);
    ctx.calendar.failCreate = 'permanent';
    let res: any;
    (ctx.llm as ScriptedLlm).push(llmTool('confirm_proposal', { proposal_id: f.proposalId() }), (req) => {
      res = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content);
      return llmText('Não consegui registrar agora. Vou chamar a equipe.');
    });
    await send(t, 'sim');
    await processConversation(ctx.deps, f.job);
    expect(res).toMatchObject({ ok: false, error: 'calendar_error' });
    expect((await db.query(`SELECT status FROM bookings`)).rows[0].status).toBe('failed');
    // a reserva com falha libera o horário (a constraint só vale para pending/confirmed)
    await db.query(
      `INSERT INTO bookings (tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, status, created_by)
       SELECT tenant_id, resource_id, service_id, contact_id, starts_at, ends_at, 'confirmed', 'human' FROM bookings LIMIT 1`,
    );
  });

  it('falha temporária na criação do evento é repetida e confirmada', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    const f = await bookingFlow(t, ctx);
    ctx.calendar.failCreate = 'retryable_once';
    let res: any;
    (ctx.llm as ScriptedLlm).push(llmTool('confirm_proposal', { proposal_id: f.proposalId() }), (req) => {
      res = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content);
      return llmText('Agendado!');
    });
    await send(t, 'sim');
    await processConversation(ctx.deps, f.job);
    expect(res.ok).toBe(true);
    expect(ctx.calendar.calls.filter((c) => c === 'create')).toHaveLength(2);
  });

  it('timeout depois de o evento ser criado: detecta o evento existente e não duplica', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    const f = await bookingFlow(t, ctx);
    ctx.calendar.failCreate = 'timeout_after_create';
    let res: any;
    (ctx.llm as ScriptedLlm).push(llmTool('confirm_proposal', { proposal_id: f.proposalId() }), (req) => {
      res = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content);
      return llmText('Agendado!');
    });
    await send(t, 'sim');
    await processConversation(ctx.deps, f.job);
    expect(res.ok).toBe(true);
    expect(ctx.calendar.activeEvents(t.calendarId)).toHaveLength(1);
  });

  it('confirmar a mesma proposta duas vezes é idempotente', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    const f = await bookingFlow(t, ctx);
    await send(t, 'sim');
    const scope = {
      tenant: await (await import('../../src/tenant/context.js')).loadTenantContext(db, t.tenantId, ENC_KEY),
      conversationId: f.job.conversationId,
      contactId: (await db.query(`SELECT contact_id FROM conversations WHERE id = $1`, [f.job.conversationId])).rows[0].contact_id,
    };
    const a = await ctx.booking.confirmProposal(scope, { proposal_id: f.proposalId() });
    const b = await ctx.booking.confirmProposal(scope, { proposal_id: f.proposalId() });
    expect(a.ok && b.ok).toBe(true);
    expect(b).toMatchObject({ already_confirmed: true });
    expect(ctx.calendar.activeEvents(t.calendarId)).toHaveLength(1);
  });

  it('isolamento: cliente não consegue cancelar reserva de outro cliente nem de outra empresa', async () => {
    const t = await seedTenant(db, { slug: 'empresa-a' });
    const other = await seedTenant(db, { slug: 'empresa-b' });
    const ctx = makeProcessorDeps(db);
    const f = await bookingFlow(t, ctx);
    await send(t, 'sim');
    (ctx.llm as ScriptedLlm).push(llmTool('confirm_proposal', { proposal_id: f.proposalId() }), llmText('ok'));
    await processConversation(ctx.deps, f.job);
    const bookingId = (await db.query(`SELECT id FROM bookings WHERE status = 'confirmed'`)).rows[0].id;

    // outro cliente da mesma empresa
    let res: any;
    (ctx.llm as ScriptedLlm).push(llmTool('propose_cancellation', { booking_id: bookingId }), (req) => {
      res = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content);
      return llmText('Não encontrei.');
    });
    const j2 = await send(t, 'cancela a reserva', '5511911112222');
    await processConversation(ctx.deps, j2);
    expect(res).toMatchObject({ ok: false, error: 'unknown_booking' });

    // cliente de outra empresa
    let res2: any;
    (ctx.llm as ScriptedLlm).push(llmTool('propose_cancellation', { booking_id: bookingId }), (req) => {
      res2 = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content);
      return llmText('Não encontrei.');
    });
    const j3 = await send(other, 'cancela a reserva', CUSTOMER);
    await processConversation(ctx.deps, j3);
    expect(res2).toMatchObject({ ok: false, error: 'unknown_booking' });
    expect((await db.query(`SELECT status FROM bookings WHERE id = $1`, [bookingId])).rows[0].status).toBe('confirmed');
  });

  it('cancelamento confirmado remove o evento da agenda', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    const f = await bookingFlow(t, ctx);
    await send(t, 'sim');
    (ctx.llm as ScriptedLlm).push(llmTool('confirm_proposal', { proposal_id: f.proposalId() }), llmText('ok'));
    await processConversation(ctx.deps, f.job);
    const bookingId = (await db.query(`SELECT id FROM bookings`)).rows[0].id;
    let pid = '';
    (ctx.llm as ScriptedLlm).push(llmTool('propose_cancellation', { booking_id: bookingId }), (req) => {
      pid = JSON.parse(((req.messages.at(-1)!.content as any[])[0]).content).proposal_id;
      return llmText('Confirma o cancelamento?');
    });
    await send(t, 'preciso cancelar');
    await processConversation(ctx.deps, f.job);
    (ctx.llm as ScriptedLlm).push(llmTool('confirm_proposal', { proposal_id: pid }), llmText('Cancelado.'));
    await send(t, 'confirmo');
    await processConversation(ctx.deps, f.job);
    expect((await db.query(`SELECT status FROM bookings`)).rows[0].status).toBe('cancelled');
    expect(ctx.calendar.activeEvents(t.calendarId)).toHaveLength(0);
  });

  it('empresa sem agenda autorizada: ferramentas de agenda não são oferecidas ao modelo', async () => {
    const t = await seedTenant(db, { booking: false });
    const ctx = makeProcessorDeps(db);
    (ctx.llm as ScriptedLlm).push(llmText('Vou passar para a equipe marcar.'));
    const job = await send(t, 'quero marcar');
    await processConversation(ctx.deps, job);
    const names = (ctx.llm as ScriptedLlm).calls[0]!.tools.map((x) => x.name);
    expect(names).not.toContain('check_availability');
    expect(names).not.toContain('confirm_proposal');
  });
});

describe('privacidade', () => {
  it('apagamento do contato remove identificação e conteúdo, mantendo a auditoria', async () => {
    const t = await seedTenant(db);
    const { deps, llm, wa } = makeProcessorDeps(db);
    (llm as ScriptedLlm).push(llmText('Olá!'));
    const job = await send(t, 'meu nome é Carla, telefone 11 98888-7777');
    await processConversation(deps, job);
    const contactId = (await db.query(`SELECT id FROM contacts`)).rows[0].id;
    await createHumanActions(db, wa, ENC_KEY).eraseContact(t.tenantId, contactId, 'admin:teste');
    const c = (await db.query(`SELECT wa_id, profile_name, erased_at FROM contacts`)).rows[0];
    expect(c.wa_id).toMatch(/^erased:/);
    expect(c.profile_name).toBeNull();
    expect((await db.query(`SELECT count(*)::int AS n FROM messages WHERE body IS NOT NULL`)).rows[0].n).toBe(0);
    expect((await db.query(`SELECT action FROM audit_log WHERE action = 'contact.erased'`)).rowCount).toBe(1);
  });

  it('retenção apaga conteúdo antigo e a auditoria não aceita alteração fora do job', async () => {
    const t = await seedTenant(db);
    await send(t, 'mensagem antiga');
    await db.query(`UPDATE messages SET created_at = now() - interval '200 days'`);
    const r = await purgeRetention(db);
    expect(r.messagesRedacted).toBe(1);
    expect((await db.query(`SELECT body, redacted_at FROM messages`)).rows[0].body).toBeNull();
    await db.query(`INSERT INTO audit_log (tenant_id, actor, action) VALUES ($1, 'system', 'x')`, [t.tenantId]);
    await expect(db.query(`UPDATE audit_log SET action = 'y'`)).rejects.toThrow(/somente inserção/);
  });
});
