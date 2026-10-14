# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

WhatsApp AI receptionist for salons/barbershops/clinics (Brazil, PT-BR), built on the WhatsApp Business Cloud API, Anthropic Claude, and Google Calendar. Documentation and most domain/code comments are in Portuguese; match that when editing docs or user-facing strings. The full spec lives in `docs/01`–`docs/10` (numbered: discovery, architecture, data model, webhooks, audio, AI orchestration, calendar, security, tests, implementation plan) — read the relevant doc before changing that area, and update it if behavior changes. `STATUS.md` tracks what's actually been run (104 tests pass against real Postgres/Redis/ffmpeg; external providers — Meta, Anthropic, OpenAI, ElevenLabs, Google — are implemented per their docs but **not yet exercised with real credentials**).

## Commands

Requires Node 22+, PostgreSQL 16 (with `btree_gist` + `pgcrypto`), Redis 7, ffmpeg.

```bash
npm run typecheck                    # tsc --noEmit
npm test                             # vitest run (needs TEST_DATABASE_URL / TEST_REDIS_URL, see below)
npm test -- test/unit/calendar.test.ts     # single file
npm test -- -t "nome do teste"             # single test by name
npm run migrate                      # tsx src/db/migrate.ts
npm run start:api                    # Fastify API process, port 3000
npm run start:worker                 # BullMQ worker process
npm run smoke                        # tsx scripts/smoke.ts — runs api+worker together end-to-end with fakes
npm run seed:demo -- --phone-number-id <ID> --token <TOKEN>
npm run build                        # tsc -p tsconfig.build.json
```

Tests need real Postgres/Redis/ffmpeg — there are no mocked-infra test paths:

```bash
TEST_DATABASE_URL=postgresql://air:air@localhost:5432/air_test TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
```

Tests **drop and recreate the schema** on `TEST_DATABASE_URL` (`test/helpers/setup.ts::freshDb`) — always point it at a dedicated test database, never anything with real data. `vitest.config.ts` forces `fileParallelism: false` because integration/e2e tests share the same Postgres/Redis fixtures.

Without any provider credentials, run with `LLM_PROVIDER=fake` and `STT_PROVIDER=disabled` to see the stack work end to end.

## Architecture

**Modular monolith, two processes from the same codebase**: `main-api.ts` (Fastify; webhook intake + `/admin/*`) and `main-worker.ts` (BullMQ consumer + periodic reconciler). Postgres is the single source of truth; Redis/BullMQ is only a work-delivery bell — losing Redis never loses a message. Decision rationale for this and other architectural choices is in `docs/02-arquitetura.md`.

### Request flow

1. **Webhook (sync, target: tens of ms)** — `src/http/app.ts` → `src/whatsapp/ingest.ts`: verify `X-Hub-Signature-256` (HMAC-SHA256 of the *raw* body) in constant time → one transaction writes `webhook_events` (dedup by `body_sha256`), upserts contact/conversation/message (dedup by `UNIQUE(tenant_id, wa_message_id)`), and inserts an `outbox` row → commit → best-effort BullMQ enqueue with a short timeout (`ENQUEUE_TIMEOUT_MS`). The webhook never waits on transcription, the LLM, or TTS. If Postgres fails, respond 500 (Meta retries); if only Redis fails, still respond 200 — the outbox row covers it.
2. **Worker (async)** — `src/worker/processor.ts` takes a `{tenantId, conversationId}` job (content-free by design: it always re-reads *all* unprocessed messages from Postgres, so it doesn't matter which queued job "wins"). Acquires a per-conversation **lease in Postgres** (not a Redis lock — survives Redis instability; expires automatically if the worker dies). Loops up to 3 rounds per job: optional audio download/ffprobe/STT, then deterministic human-handoff shortcuts, else routes to the agent loop, then writes the outbound message (`pending`) and sends to WhatsApp in the same flow.
3. **Reconciler** (`src/queue/reconciler.ts`), gated by `pg_try_advisory_lock` so only one instance runs it: redispatches stuck `outbox` rows, re-enqueues conversations whose messages have sat longer than `DEBOUNCE_MS + LEASE_MS`, and hourly applies retention (`src/worker/retention.ts`).

Message grouping uses BullMQ's debounce pattern (`deduplication: { id: conv:<id>, ttl: DEBOUNCE_MS, extend: true, replace: true }` + `delay`) so a burst of messages in one conversation collapses into a single agent turn.

### AI agent (`src/ai/*`)

The model **only** converses and picks tools; code decides and executes everything. 9 zod-defined tools in `src/ai/tools.ts` (`ToolSchemas` is the single source — generates the JSON Schema sent to Anthropic via `z.toJSONSchema` and validates returned args with `.strict()`). Tools receive `tenant`/`conversation`/`contact` injected from the job context — **never** from model-supplied arguments. Booking tools (`propose_booking`, `confirm_proposal`, etc.) never let the model invent a time slot: it can only confirm a `slot_code` the system already offered in that conversation, and `confirm_proposal` only executes if a customer message postdates the proposal (defends against prompt injection skipping the confirmation step). Limits enforced per turn: `AGENT_MAX_ITERATIONS`, `AGENT_RUN_TIMEOUT_MS` (AbortController), per-tool 20s timeout, and a `tenant_settings.daily_llm_budget_micros` spend cap tracked in `agent_runs`. See `docs/06-orquestracao-ia.md` for the full tool table, prompt-injection layering, and handoff trigger matrix.

### Multi-tenancy

Every domain table carries `tenant_id`; cross-table FKs are composite (`(id, tenant_id)`) so a row can't be joined across tenants even by accident. `src/tenant/context.ts::loadTenantContext` is the one place that assembles a tenant's full operating context (settings, services, resources, decrypted WhatsApp token) and is scoped by `tenant_id` throughout. Admin endpoints authenticate with a per-tenant API key (SHA-256 hash stored, bearer compared). Third-party credentials (WhatsApp token, calendar credentials) are stored AES-256-GCM-encrypted via `src/lib/crypto.ts`, keyed by `DATA_ENCRYPTION_KEY`.

### Calendar (`src/calendar/*`)

`BookingService` is the only caller of the Google Calendar provider; the model never talks to Calendar directly. Booking flow is propose → verified-confirm → Postgres `EXCLUDE` constraint (via `btree_gist`) prevents double-booking at the DB level regardless of application logic. Google event IDs are deterministic (derived from a uuid) so retrying after a timeout doesn't duplicate the event — the service checks existence first.

### Config

`src/config.ts` is the only source of environment config — a zod schema (`loadConfig`) with cross-field validation (e.g. `ANTHROPIC_API_KEY` required when `LLM_PROVIDER=anthropic`). Don't read `process.env` elsewhere.

### Test fixtures

`test/helpers/setup.ts` provides `freshDb` (drop/recreate schema + migrate), `seedTenant` (minimal tenant + service + resource + admin key), fake adapters (`FakeWhatsAppClient`, `ScriptedLlm`, `FakeCalendarProvider`, `FakeTranscriber`, `RecordingNotifier`), and `makeProcessorDeps` for wiring `ProcessorDeps` in isolation. `makeAudio()` shells out to the real system `ffmpeg` to generate test audio — ffmpeg must be installed locally, not just mocked.

## Notable constraints

- `fetch` is used directly against provider APIs instead of SDKs (uniform timeout/error handling, easy to fake) — the one exception is `google-auth-library` for the service-account JWT flow. Keep new integrations consistent with this unless there's a strong reason not to.
- Plain SQL via `pg`, no ORM — exclusion constraints, partial unique indexes, advisory locks, and `UPDATE ... RETURNING` leases are relied on directly and are part of the correctness story, not incidental.
- LGPD (Brazilian data protection) matters here: first-contact AI-disclosure notice recorded in `consents`, `/admin/contacts/:id/erase` for deletion requests, append-only `audit_log`, retention policy enforced by the reconciler, and logs must not contain conversation content.
