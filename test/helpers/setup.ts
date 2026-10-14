import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import pg from 'pg';
import { createPool, type Db } from '../../src/db/pool.js';
import { migrate } from '../../src/db/migrate.js';
import { encryptSecret, sha256Hex, signMetaBody } from '../../src/lib/crypto.js';
import { createLogger } from '../../src/lib/logger.js';
import { fixedClock } from '../../src/lib/clock.js';
import { FakeWhatsAppClient } from '../../src/whatsapp/fake-client.js';
import { ScriptedLlm } from '../../src/ai/llm.js';
import { FakeCalendarProvider } from '../../src/calendar/fake.js';
import { BookingService } from '../../src/calendar/booking-service.js';
import { RecordingNotifier } from '../../src/handoff/notifier.js';
import { FakeTranscriber } from '../../src/audio/stt.js';
import type { ProcessorDeps } from '../../src/worker/processor.js';

export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgresql://air:air@localhost:5432/air_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://127.0.0.1:6379';
export const APP_SECRET = 'test-app-secret';
export const VERIFY_TOKEN = 'verify-token-1234567890';
export const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
export const silentLog = createLogger('silent');

export async function freshDb(): Promise<Db> {
  const admin = new pg.Client({ connectionString: TEST_DB_URL });
  await admin.connect();
  await admin.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  const db = createPool(TEST_DB_URL, 20);
  await migrate(db);
  return db;
}

export async function truncateAll(db: Db) {
  const r = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`);
  await db.query(`SET app.retention_job = 'on'`);
  await db.query(`TRUNCATE ${r.rows.map((x) => `"${x.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export interface SeededTenant {
  tenantId: string;
  phoneNumberId: string;
  serviceId: string;
  resourceId: string;
  calendarId: string;
  adminKey: string;
}

export const BUSINESS_HOURS = {
  mon: [['09:00', '18:00']],
  tue: [['09:00', '18:00']],
  wed: [['09:00', '18:00']],
  thu: [['09:00', '18:00']],
  fri: [['09:00', '18:00']],
  sat: [['09:00', '13:00']],
};

export async function seedTenant(
  db: Db,
  opts: { slug?: string; booking?: boolean; voice?: boolean; budgetMicros?: number; tz?: string; aiEnabled?: boolean } = {},
): Promise<SeededTenant> {
  const slug = opts.slug ?? `salao-${randomUUID().slice(0, 6)}`;
  const t = await db.query(`INSERT INTO tenants (name, slug, timezone) VALUES ($1,$2,$3) RETURNING id`, [
    `Studio ${slug}`,
    slug,
    opts.tz ?? 'America/Sao_Paulo',
  ]);
  const tenantId = t.rows[0].id;
  await db.query(
    `INSERT INTO tenant_settings (tenant_id, ai_enabled, booking_enabled, voice_reply_enabled, business_info, business_hours, daily_llm_budget_micros, handoff_webhook_url)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'https://n8n.example.com/webhook/handoff')`,
    [
      tenantId,
      opts.aiEnabled ?? true,
      opts.booking ?? true,
      opts.voice ?? false,
      { address: 'Rua das Flores, 100', payment: 'Pix e cartão' },
      BUSINESS_HOURS,
      opts.budgetMicros ?? 2_000_000,
    ],
  );
  const phoneNumberId = `pn-${slug}`;
  await db.query(`INSERT INTO whatsapp_numbers (tenant_id, phone_number_id, access_token_ciphertext) VALUES ($1,$2,$3)`, [
    tenantId,
    phoneNumberId,
    encryptSecret(`token-${slug}`, ENC_KEY),
  ]);
  const s = await db.query(`INSERT INTO services (tenant_id, name, duration_min, price_text) VALUES ($1,'Corte feminino',60,'R$ 90') RETURNING id`, [tenantId]);
  const calendarId = `cal-${slug}@group.calendar.google.com`;
  const r = await db.query(`INSERT INTO resources (tenant_id, name, external_calendar_id) VALUES ($1,'Ana',$2) RETURNING id`, [tenantId, calendarId]);
  await db.query(`INSERT INTO resource_services (tenant_id, resource_id, service_id) VALUES ($1,$2,$3)`, [tenantId, r.rows[0].id, s.rows[0].id]);
  await db.query(`INSERT INTO calendar_connections (tenant_id, provider, auth_type) VALUES ($1,'fake','service_account')`, [tenantId]);
  const adminKey = randomBytes(24).toString('hex');
  await db.query(`INSERT INTO admin_api_keys (tenant_id, key_hash, label) VALUES ($1,$2,'teste')`, [tenantId, sha256Hex(adminKey)]);
  return { tenantId, phoneNumberId, serviceId: s.rows[0].id, resourceId: r.rows[0].id, calendarId, adminKey };
}

let wamidSeq = 0;
export function textEvent(phoneNumberId: string, from: string, body: string, opts: { id?: string; ts?: number; name?: string } = {}) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '5511999990000', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: opts.name ?? 'Carla' }, wa_id: from }],
              messages: [
                {
                  from,
                  id: opts.id ?? `wamid.test.${++wamidSeq}.${randomUUID().slice(0, 8)}`,
                  timestamp: String(opts.ts ?? Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function audioEvent(phoneNumberId: string, from: string, mediaId: string, mime = 'audio/ogg; codecs=opus', opts: { ts?: number } = {}) {
  const ev = textEvent(phoneNumberId, from, 'x', opts);
  const msg = ev.entry[0]!.changes[0]!.value.messages[0]! as any;
  delete msg.text;
  msg.type = 'audio';
  msg.audio = { id: mediaId, mime_type: mime, voice: true };
  return ev;
}

export function statusEvent(phoneNumberId: string, wamid: string, status: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: phoneNumberId },
              statuses: [{ id: wamid, status, timestamp: String(Math.floor(Date.now() / 1000)), recipient_id: '5511' }],
            },
          },
        ],
      },
    ],
  };
}

export function signed(payload: unknown) {
  const raw = Buffer.from(JSON.stringify(payload));
  return { raw, signature: signMetaBody(raw, APP_SECRET) };
}

export const processorConfig = {
  DATA_ENCRYPTION_KEY: ENC_KEY,
  LEASE_MS: 30_000,
  AGENT_MAX_ITERATIONS: 6,
  AGENT_RUN_TIMEOUT_MS: 5_000,
  AGENT_HISTORY_MESSAGES: 20,
  LLM_MAX_OUTPUT_TOKENS: 500,
  LLM_INPUT_MICROS_PER_MTOK: 2_000_000,
  LLM_OUTPUT_MICROS_PER_MTOK: 10_000_000,
  AUDIO_MAX_BYTES: 16 * 1024 * 1024,
  TTS_MAX_CHARS: 600,
};

export function makeProcessorDeps(db: Db, overrides: Partial<ProcessorDeps> = {}) {
  // segunda-feira, 12/10/2026, 10:00 em São Paulo
  const clock = fixedClock('2026-10-12T13:00:00Z');
  const calendar = new FakeCalendarProvider();
  const wa = new FakeWhatsAppClient();
  const llm = new ScriptedLlm([]);
  const notifier = new RecordingNotifier();
  const stt = new FakeTranscriber();
  const booking = new BookingService({ db, clock, log: silentLog, calendarFor: async () => calendar, retryDelayMs: 1 });
  const deps: ProcessorDeps = {
    db,
    wa,
    llm,
    stt,
    tts: null,
    notifier,
    booking,
    clock,
    log: silentLog,
    config: processorConfig,
    workerId: `test-${randomUUID().slice(0, 6)}`,
    ...overrides,
  };
  return { deps, clock, calendar, wa, llm, notifier, stt, booking };
}

/** Gera um áudio real (tom senoidal) com o ffmpeg do sistema. */
export function makeAudio(seconds: number, format: 'ogg' | 'mp3' | 'm4a' = 'ogg'): Buffer {
  const codec = format === 'ogg' ? ['-c:a', 'libopus', '-ac', '1'] : format === 'mp3' ? ['-c:a', 'libmp3lame'] : ['-c:a', 'aac'];
  const fmt = format === 'm4a' ? ['-f', 'ipod'] : ['-f', format];
  const tmp = `/tmp/air-test-${randomUUID()}.${format}`;
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, ...codec, ...fmt, '-y', tmp]);
  const buf = execFileSync('cat', [tmp], { maxBuffer: 64 * 1024 * 1024 });
  execFileSync('rm', ['-f', tmp]);
  return buf;
}

export async function waitFor(fn: () => Promise<boolean> | boolean, timeoutMs = 10_000, stepMs = 50) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('waitFor: condição não satisfeita a tempo');
}
