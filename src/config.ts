import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().default('redis://127.0.0.1:6379'),
  QUEUE_PREFIX: z.string().default('air'),

  // Meta / WhatsApp Business Platform (Cloud API)
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_VERIFY_TOKEN: z.string().min(16),
  WHATSAPP_GRAPH_VERSION: z.string().regex(/^v\d+\.\d+$/).default('v25.0'),
  WHATSAPP_GRAPH_BASE_URL: z.string().url().default('https://graph.facebook.com'),

  // chave de 32 bytes em base64 para cifrar tokens e credenciais armazenados no banco
  DATA_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'DATA_ENCRYPTION_KEY deve ter 32 bytes em base64'),

  // assina os avisos de handoff enviados ao webhook da empresa (ex.: n8n)
  HANDOFF_SIGNING_SECRET: z.string().min(16),

  // LLM
  LLM_PROVIDER: z.enum(['anthropic', 'fake']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  ANTHROPIC_VERSION: z.string().default('2023-06-01'),
  LLM_MODEL: z.string().default('claude-sonnet-5-5'),
  LLM_INPUT_MICROS_PER_MTOK: z.coerce.number().int().default(2_000_000), // US$ 2 / MTok
  LLM_OUTPUT_MICROS_PER_MTOK: z.coerce.number().int().default(10_000_000), // US$ 10 / MTok
  LLM_MAX_OUTPUT_TOKENS: z.coerce.number().int().default(800),
  LLM_TIMEOUT_MS: z.coerce.number().int().default(30_000),
  AGENT_MAX_ITERATIONS: z.coerce.number().int().min(1).max(12).default(6),
  AGENT_RUN_TIMEOUT_MS: z.coerce.number().int().default(60_000),
  AGENT_HISTORY_MESSAGES: z.coerce.number().int().default(20),

  // Speech-to-text
  STT_PROVIDER: z.enum(['openai', 'fake', 'disabled']).default('openai'),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com'),
  STT_MODEL: z.string().default('gpt-4o-mini-transcribe'),
  AUDIO_MAX_BYTES: z.coerce.number().int().default(16 * 1024 * 1024),

  // Text-to-speech (opcional)
  TTS_PROVIDER: z.enum(['elevenlabs', 'fake', 'disabled']).default('disabled'),
  ELEVENLABS_API_KEY: z.string().optional(),
  ELEVENLABS_BASE_URL: z.string().url().default('https://api.elevenlabs.io'),
  ELEVENLABS_VOICE_ID: z.string().optional(),
  ELEVENLABS_MODEL_ID: z.string().default('eleven_multilingual_v2'),
  TTS_MAX_CHARS: z.coerce.number().int().default(600),

  // Processamento
  DEBOUNCE_MS: z.coerce.number().int().min(0).default(2500),
  LEASE_MS: z.coerce.number().int().default(90_000),
  WORKER_CONCURRENCY: z.coerce.number().int().default(8),
  OUTBOX_RELAY_INTERVAL_MS: z.coerce.number().int().default(2000),
  ENQUEUE_TIMEOUT_MS: z.coerce.number().int().default(300),

  // HTTP
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(600),
  ADMIN_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().default(60),
  STORE_WEBHOOK_PAYLOADS: z.enum(['true', 'false', '1', '0']).default('true').transform((v) => v === 'true' || v === '1'),
});

export type Config = z.infer<typeof EnvSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Configuração inválida:\n${issues}`);
  }
  const c = parsed.data;
  if (c.LLM_PROVIDER === 'anthropic' && !c.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY é obrigatório com LLM_PROVIDER=anthropic');
  if (c.STT_PROVIDER === 'openai' && !c.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY é obrigatório com STT_PROVIDER=openai');
  if (c.TTS_PROVIDER === 'elevenlabs' && (!c.ELEVENLABS_API_KEY || !c.ELEVENLABS_VOICE_ID))
    throw new Error('ELEVENLABS_API_KEY e ELEVENLABS_VOICE_ID são obrigatórios com TTS_PROVIDER=elevenlabs');
  return c;
}
