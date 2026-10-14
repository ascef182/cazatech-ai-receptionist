import { hostname } from 'node:os';
import type { Config } from './config.js';
import { createPool, type Db } from './db/pool.js';
import { createLogger, type Logger } from './lib/logger.js';
import { systemClock } from './lib/clock.js';
import { decryptSecret } from './lib/crypto.js';
import { AnthropicClient, DemoLlm, type LlmClient } from './ai/llm.js';
import { GraphWhatsAppClient } from './whatsapp/client.js';
import { FakeTranscriber, OpenAiTranscriber, type Transcriber } from './audio/stt.js';
import { ElevenLabsSynthesizer, type Synthesizer } from './audio/tts.js';
import { BookingService } from './calendar/booking-service.js';
import { FakeCalendarProvider } from './calendar/fake.js';
import { GoogleCalendarProvider, serviceAccountTokenSource, type ServiceAccountCredentials } from './calendar/google.js';
import type { CalendarProvider } from './calendar/provider.js';
import { WebhookHandoffNotifier } from './handoff/notifier.js';
import type { ProcessorDeps } from './worker/processor.js';

export function calendarFactory(db: Db, encKey: string) {
  const cache = new Map<string, { provider: CalendarProvider; at: number }>();
  const fake = new FakeCalendarProvider();
  return async (tenantId: string): Promise<CalendarProvider | null> => {
    const hit = cache.get(tenantId);
    if (hit && Date.now() - hit.at < 5 * 60_000) return hit.provider;
    const r = await db.query(`SELECT provider, auth_type, credentials_ciphertext FROM calendar_connections WHERE tenant_id = $1 AND status = 'active'`, [tenantId]);
    if (!r.rowCount) return null;
    const row = r.rows[0];
    let provider: CalendarProvider;
    if (row.provider === 'fake') provider = fake;
    else if (row.auth_type === 'service_account') {
      const creds = JSON.parse(decryptSecret(row.credentials_ciphertext, encKey)) as ServiceAccountCredentials;
      provider = new GoogleCalendarProvider(serviceAccountTokenSource(creds));
    } else return null; // OAuth de usuário ainda não implementado (ver plano)
    cache.set(tenantId, { provider, at: Date.now() });
    return provider;
  };
}

export function buildProcessorDeps(config: Config, overrides: Partial<ProcessorDeps> = {}): ProcessorDeps & { logger: Logger } {
  const log = overrides.log ?? createLogger(config.LOG_LEVEL);
  const db = overrides.db ?? createPool(config.DATABASE_URL);
  const llm: LlmClient =
    overrides.llm ??
    (config.LLM_PROVIDER === 'fake' ? new DemoLlm() : null) ??
    new AnthropicClient(config.ANTHROPIC_API_KEY!, config.LLM_MODEL, config.ANTHROPIC_BASE_URL, config.ANTHROPIC_VERSION, config.LLM_TIMEOUT_MS);
  const stt: Transcriber | null =
    overrides.stt !== undefined ? overrides.stt : config.STT_PROVIDER === 'openai'
        ? new OpenAiTranscriber(config.OPENAI_API_KEY!, config.STT_MODEL, config.OPENAI_BASE_URL)
        : config.STT_PROVIDER === 'fake'
          ? new FakeTranscriber('(modo demonstração) áudio recebido')
          : null;
  const tts: Synthesizer | null =
    overrides.tts !== undefined
      ? overrides.tts
      : config.TTS_PROVIDER === 'elevenlabs'
        ? new ElevenLabsSynthesizer(config.ELEVENLABS_API_KEY!, config.ELEVENLABS_VOICE_ID!, config.ELEVENLABS_MODEL_ID, config.ELEVENLABS_BASE_URL)
        : null;
  const clock = overrides.clock ?? systemClock;
  return {
    db,
    log,
    logger: log,
    clock,
    llm,
    stt,
    tts,
    wa: overrides.wa ?? new GraphWhatsAppClient(config.WHATSAPP_GRAPH_BASE_URL, config.WHATSAPP_GRAPH_VERSION),
    notifier: overrides.notifier ?? new WebhookHandoffNotifier(config.HANDOFF_SIGNING_SECRET),
    booking: overrides.booking ?? new BookingService({ db, clock, log, calendarFor: calendarFactory(db, config.DATA_ENCRYPTION_KEY) }),
    config,
    workerId: overrides.workerId ?? `${hostname()}:${process.pid}`,
  };
}
