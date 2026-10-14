import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { audit } from '../db/audit.js';
import type { Clock } from '../lib/clock.js';
import { isRetryable, PermanentError } from '../lib/errors.js';
import type { Logger } from '../lib/logger.js';
import { runAgent } from '../ai/agent.js';
import type { LlmClient, LlmMessage } from '../ai/llm.js';
import { AI_NOTICE, buildSystemPrompt } from '../ai/prompt.js';
import { AUDIO_FALLBACK_REPLY, FALLBACK_REPLY, HANDOFF_REPLY, wantsHuman, wrapCustomerText } from '../ai/guardrails.js';
import type { BookingService } from '../calendar/booking-service.js';
import { transcribeInboundAudio } from '../audio/inbound.js';
import type { Transcriber } from '../audio/stt.js';
import type { Synthesizer } from '../audio/tts.js';
import type { HandoffNotifier } from '../handoff/notifier.js';
import { loadTenantContext, type TenantContext } from '../tenant/context.js';
import type { WhatsAppClient } from '../whatsapp/client.js';
import { isTokenInvalidError, isWindowClosedError } from '../whatsapp/client.js';

export interface ProcessorConfig {
  DATA_ENCRYPTION_KEY: string;
  LEASE_MS: number;
  AGENT_MAX_ITERATIONS: number;
  AGENT_RUN_TIMEOUT_MS: number;
  AGENT_HISTORY_MESSAGES: number;
  LLM_MAX_OUTPUT_TOKENS: number;
  LLM_INPUT_MICROS_PER_MTOK: number;
  LLM_OUTPUT_MICROS_PER_MTOK: number;
  AUDIO_MAX_BYTES: number;
  TTS_MAX_CHARS: number;
}

export interface ProcessorDeps {
  db: Db;
  wa: WhatsAppClient;
  llm: LlmClient;
  stt: Transcriber | null;
  tts: Synthesizer | null;
  notifier: HandoffNotifier;
  booking: BookingService;
  clock: Clock;
  log: Logger;
  config: ProcessorConfig;
  workerId: string;
}

export interface ProcessResult {
  status: 'done' | 'busy' | 'missing';
  rounds: number;
  replies: number;
}

const STALE_INBOUND_MS = 24 * 3600_000;
const MAX_ROUNDS = 3;

export async function processConversation(
  d: ProcessorDeps,
  job: { tenantId: string; conversationId: string },
  opts: { finalAttempt: boolean } = { finalAttempt: false },
): Promise<ProcessResult> {
  // Token único por execução: dois jobs da mesma conversa no mesmo processo também se excluem.
  const leaseToken = `${d.workerId}:${randomUUID()}`;
  const lease = await d.db.query(
    `UPDATE conversations SET lease_owner = $3, lease_until = now() + make_interval(secs => $4::double precision / 1000)
     WHERE id = $1 AND tenant_id = $2 AND (lease_until IS NULL OR lease_until < now())
     RETURNING id`,
    [job.conversationId, job.tenantId, leaseToken, d.config.LEASE_MS],
  );
  if (!lease.rowCount) {
    const exists = await d.db.query(`SELECT 1 FROM conversations WHERE id = $1 AND tenant_id = $2`, [job.conversationId, job.tenantId]);
    return { status: exists.rowCount ? 'busy' : 'missing', rounds: 0, replies: 0 };
  }

  let rounds = 0;
  let replies = 0;
  try {
    const t = await loadTenantContext(d.db, job.tenantId, d.config.DATA_ENCRYPTION_KEY);
    await flushPendingOutbound(d, t, job.conversationId);

    for (; rounds < MAX_ROUNDS; ) {
      const pending = await d.db.query(
        `SELECT id, kind, body, transcript, media_id, media_mime, wa_message_id, status, created_at, wa_timestamp
         FROM messages WHERE conversation_id = $1 AND tenant_id = $2 AND direction = 'in' AND processed_at IS NULL
         ORDER BY created_at, id`,
        [job.conversationId, job.tenantId],
      );
      if (!pending.rowCount) break;
      rounds++;
      replies += await handleRound(d, t, job.conversationId, pending.rows, opts);
    }
    return { status: 'done', rounds, replies };
  } finally {
    await d.db
      .query(`UPDATE conversations SET lease_owner = NULL, lease_until = NULL WHERE id = $1 AND lease_owner = $2`, [job.conversationId, leaseToken])
      .catch(() => undefined);
  }
}

async function handleRound(d: ProcessorDeps, t: TenantContext, conversationId: string, pending: any[], opts: { finalAttempt: boolean }): Promise<number> {
  const conv = (
    await d.db.query(
      `SELECT c.status, c.contact_id, ct.wa_id, ct.display_name, ct.profile_name, ct.erased_at
       FROM conversations c JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
       WHERE c.id = $1 AND c.tenant_id = $2`,
      [conversationId, t.id],
    )
  ).rows[0];
  const ids = pending.map((m) => m.id);

  // IA desligada, empresa pausada ou conversa com a equipe: registra e não responde.
  if (t.status !== 'active' || !t.settings.ai_enabled || conv.status !== 'bot' || conv.erased_at) {
    await markProcessed(d.db, ids, 'processed');
    return 0;
  }

  // Mensagens antigas reentregues após uma indisponibilidade longa: não responder automaticamente.
  const newest = pending[pending.length - 1];
  if (d.clock.now().getTime() - new Date(newest.wa_timestamp ?? newest.created_at).getTime() > STALE_INBOUND_MS) {
    await markProcessed(d.db, ids, 'ignored');
    await handoff(d, t, conversationId, conv, 'stale_messages', 'mensagens recebidas com mais de 24h de atraso');
    return 0;
  }

  if (newest.wa_message_id) d.wa.markReadWithTyping(t.channel, newest.wa_message_id).catch(() => undefined);

  // Áudio -> texto
  let audioFailed = false;
  for (const m of pending) {
    if (m.kind !== 'audio' || m.transcript || m.status === 'failed') continue;
    if (!d.stt) {
      await d.db.query(`UPDATE messages SET status = 'failed', error = 'stt_disabled' WHERE id = $1`, [m.id]);
      m.status = 'failed';
      audioFailed = true;
      continue;
    }
    try {
      const r = await transcribeInboundAudio(d.wa, t.channel, { mediaId: m.media_id, mime: m.media_mime }, d.stt, {
        maxBytes: d.config.AUDIO_MAX_BYTES,
        maxSeconds: t.settings.max_audio_seconds,
      });
      await d.db.query(`UPDATE messages SET transcript = $2 WHERE id = $1`, [m.id, r.text]);
      m.transcript = r.text;
    } catch (err) {
      if (isRetryable(err) && !opts.finalAttempt) throw err;
      d.log.warn({ messageId: m.id, err: (err as Error).message }, 'áudio não processado');
      await d.db.query(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`, [m.id, (err as Error).message.slice(0, 200)]);
      m.status = 'failed';
      audioFailed = true;
    }
  }

  const usable = pending.filter((m) => (m.kind === 'text' && m.body) || (m.kind === 'audio' && m.transcript));
  if (!usable.length) {
    const reply = audioFailed ? AUDIO_FALLBACK_REPLY : 'Por enquanto consigo entender mensagens de texto e de áudio. Pode me escrever, por favor?';
    await replyAndMark(d, t, conversationId, conv, ids, reply, { asVoice: false });
    return 1;
  }

  const combined = usable.map((m) => m.body ?? m.transcript).join('\n');
  if (wantsHuman(combined)) {
    await handoff(d, t, conversationId, conv, 'customer_requested');
    await replyAndMark(d, t, conversationId, conv, ids, HANDOFF_REPLY, { asVoice: false });
    return 1;
  }

  // Limite de custo diário por empresa
  const spent = await d.db.query(
    `SELECT COALESCE(sum(cost_micros), 0)::bigint AS spent FROM agent_runs WHERE tenant_id = $1 AND started_at >= date_trunc('day', now())`,
    [t.id],
  );
  const remaining = t.settings.daily_llm_budget_micros - Number(spent.rows[0].spent);
  if (remaining <= 0) {
    await handoff(d, t, conversationId, conv, 'budget_exceeded');
    await replyAndMark(d, t, conversationId, conv, ids, FALLBACK_REPLY, { asVoice: false });
    return 1;
  }

  const history = await buildHistory(d.db, t.id, conversationId, d.config.AGENT_HISTORY_MESSAGES);
  const run = await d.db.query(`INSERT INTO agent_runs (tenant_id, conversation_id, model) VALUES ($1,$2,$3) RETURNING id`, [
    t.id,
    conversationId,
    d.llm.model,
  ]);
  const runId = run.rows[0].id;
  const scope = { tenant: t, conversationId, contactId: conv.contact_id };

  let result;
  try {
    result = await runAgent({
      llm: d.llm,
      system: buildSystemPrompt(t, d.clock.now()),
      history,
      bookingEnabled: t.settings.booking_enabled,
      tools: {
        scope,
        booking: d.booking,
        onHandoff: (reason, note) => handoff(d, t, conversationId, conv, reason, note),
      },
      limits: {
        maxIterations: d.config.AGENT_MAX_ITERATIONS,
        runTimeoutMs: d.config.AGENT_RUN_TIMEOUT_MS,
        maxOutputTokens: d.config.LLM_MAX_OUTPUT_TOKENS,
        toolTimeoutMs: 20_000,
        remainingBudgetMicros: remaining,
        inputMicrosPerMTok: d.config.LLM_INPUT_MICROS_PER_MTOK,
        outputMicrosPerMTok: d.config.LLM_OUTPUT_MICROS_PER_MTOK,
      },
      log: d.log,
    });
  } catch (err) {
    await d.db.query(`UPDATE agent_runs SET outcome = 'error', error = $2, finished_at = now() WHERE id = $1`, [runId, (err as Error).message.slice(0, 300)]);
    if (isRetryable(err) && !opts.finalAttempt) throw err; // mensagens continuam pendentes; o job será repetido
    await handoff(d, t, conversationId, conv, 'ai_unavailable');
    await replyAndMark(d, t, conversationId, conv, ids, FALLBACK_REPLY, { asVoice: false });
    return 1;
  }

  await d.db.query(
    `UPDATE agent_runs SET outcome = $2, iterations = $3, input_tokens = $4, output_tokens = $5, cost_micros = $6, error = $7, finished_at = now()
     WHERE id = $1`,
    [runId, result.outcome, result.iterations, result.usage.inputTokens, result.usage.outputTokens, result.usage.costMicros, result.error ?? null],
  );

  let reply: string;
  if (result.outcome === 'reply' && result.reply) reply = result.reply;
  else if (result.outcome === 'handoff') reply = result.reply || HANDOFF_REPLY;
  else {
    await handoff(d, t, conversationId, conv, `agent_${result.outcome}`);
    reply = FALLBACK_REPLY;
  }

  const lastWasVoice = newest.kind === 'audio' && !!newest.transcript;
  await replyAndMark(d, t, conversationId, conv, ids, reply, { asVoice: lastWasVoice && t.settings.voice_reply_enabled });
  return 1;
}

async function buildHistory(db: Db, tenantId: string, conversationId: string, limit: number): Promise<LlmMessage[]> {
  const r = await db.query(
    `SELECT * FROM (
       SELECT direction, author, kind, body, transcript, status, created_at, id FROM messages
       WHERE conversation_id = $1 AND tenant_id = $2 AND redacted_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT $3
     ) x ORDER BY created_at, id`,
    [conversationId, tenantId, limit],
  );
  const out: LlmMessage[] = [];
  for (const m of r.rows) {
    let text: string | null;
    if (m.direction === 'in') {
      if (m.kind === 'audio') text = m.transcript ? wrapCustomerText(`[áudio transcrito] ${m.transcript}`) : '[o cliente enviou um áudio que não pôde ser ouvido]';
      else if (m.kind === 'text') text = wrapCustomerText(m.body ?? '');
      else text = '[o cliente enviou um tipo de mensagem não suportado]';
    } else {
      if (m.status === 'failed') continue;
      text = m.author === 'human' ? `[resposta enviada pela equipe] ${m.body}` : m.body;
    }
    if (!text) continue;
    const role = m.direction === 'in' ? 'user' : 'assistant';
    const last = out[out.length - 1];
    if (last && last.role === role) last.content = `${last.content}\n${text}`;
    else out.push({ role, content: text });
  }
  // A API exige que a conversa comece com o usuário.
  while (out.length && out[0]!.role !== 'user') out.shift();
  return out;
}

async function markProcessed(q: Db | pg.PoolClient, ids: string[], status: 'processed' | 'ignored') {
  await q.query(
    `UPDATE messages SET processed_at = now(), status = CASE WHEN status = 'failed' THEN status ELSE $2 END WHERE id = ANY($1::uuid[])`,
    [ids, status],
  );
}

async function handoff(d: ProcessorDeps, t: TenantContext, conversationId: string, conv: any, reason: string, note?: string) {
  const r = await d.db.query(
    `UPDATE conversations SET status = 'human', handoff_reason = $3, handoff_at = now() WHERE id = $1 AND tenant_id = $2 AND status = 'bot' RETURNING id`,
    [conversationId, t.id, reason],
  );
  conv.status = 'human';
  if (!r.rowCount) return;
  await audit(d.db, { tenantId: t.id, actor: 'ai', action: 'conversation.handoff', entity: 'conversation', entityId: conversationId, data: { reason } });
  try {
    await d.notifier.notify(t.settings.handoff_webhook_url, {
      tenantId: t.id,
      conversationId,
      reason,
      note,
      customerName: conv.display_name ?? conv.profile_name ?? null,
      at: d.clock.now().toISOString(),
    });
  } catch (err) {
    // O handoff já está registrado no banco e visível no painel; o aviso é complementar.
    d.log.warn({ err: (err as Error).message }, 'falha ao notificar a equipe sobre o handoff');
  }
}

async function replyAndMark(
  d: ProcessorDeps,
  t: TenantContext,
  conversationId: string,
  conv: any,
  inboundIds: string[],
  text: string,
  opts: { asVoice: boolean },
) {
  const msgId = await withTx(d.db, async (c) => {
    let body = text;
    const consent = await c.query(`SELECT 1 FROM consents WHERE tenant_id = $1 AND contact_id = $2 AND kind = 'ai_processing' LIMIT 1`, [t.id, conv.contact_id]);
    if (!consent.rowCount) {
      // Primeira interação: aviso de que é um atendimento automatizado e como chegar a uma pessoa.
      body = `${AI_NOTICE(t.name)}\n\n${text}`;
      await c.query(`INSERT INTO consents (tenant_id, contact_id, kind, granted, source) VALUES ($1,$2,'ai_processing',true,'notice_first_message')`, [
        t.id,
        conv.contact_id,
      ]);
    }
    const m = await c.query(
      `INSERT INTO messages (tenant_id, conversation_id, direction, author, kind, body, status)
       VALUES ($1,$2,'out','ai',$3,$4,'pending') RETURNING id`,
      [t.id, conversationId, opts.asVoice ? 'audio' : 'text', body],
    );
    await markProcessed(c, inboundIds, 'processed');
    return m.rows[0].id as string;
  });
  await deliver(d, t, conv.wa_id, { id: msgId, body: text, fullBody: undefined, asVoice: opts.asVoice });
}

async function deliver(d: ProcessorDeps, t: TenantContext, to: string, m: { id: string; body: string; fullBody?: string; asVoice: boolean }) {
  const row = (await d.db.query(`SELECT body FROM messages WHERE id = $1`, [m.id])).rows[0];
  const body: string = row?.body ?? m.body;
  try {
    let wamid: string | null = null;
    if (m.asVoice && d.tts && body.length <= d.config.TTS_MAX_CHARS) {
      try {
        const audio = await d.tts.synthesize(body);
        const up = await d.wa.uploadMedia(t.channel, audio, 'audio/ogg', 'resposta.ogg');
        wamid = (await d.wa.sendAudio(t.channel, to, up.id, true)).wamid;
      } catch (err) {
        d.log.warn({ err: (err as Error).message }, 'voz indisponível; enviando texto');
        await d.db.query(`UPDATE messages SET kind = 'text' WHERE id = $1`, [m.id]);
      }
    } else if (m.asVoice) {
      await d.db.query(`UPDATE messages SET kind = 'text' WHERE id = $1`, [m.id]);
    }
    if (!wamid) wamid = (await d.wa.sendText(t.channel, to, body)).wamid;
    await d.db.query(`UPDATE messages SET status = 'sent', wa_message_id = $2 WHERE id = $1`, [m.id, wamid]);
  } catch (err) {
    if (isRetryable(err)) throw err; // permanece 'pending'; o próximo processamento reenvia
    const code = isWindowClosedError(err)
      ? 'outside_customer_service_window'
      : isTokenInvalidError(err)
        ? 'whatsapp_token_invalid'
        : (err as Error).message.slice(0, 200);
    await d.db.query(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`, [m.id, code]);
    d.log.error({ messageId: m.id, err: code }, 'falha permanente ao enviar resposta');
  }
}

async function flushPendingOutbound(d: ProcessorDeps, t: TenantContext, conversationId: string) {
  const r = await d.db.query(
    `SELECT m.id, m.body, m.kind, ct.wa_id FROM messages m
     JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id
     JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
     WHERE m.conversation_id = $1 AND m.tenant_id = $2 AND m.direction = 'out' AND m.status = 'pending' AND m.author IN ('ai','system')
     ORDER BY m.created_at`,
    [conversationId, t.id],
  );
  for (const m of r.rows) await deliver(d, t, m.wa_id, { id: m.id, body: m.body, asVoice: m.kind === 'audio' });
}

export { PermanentError };
