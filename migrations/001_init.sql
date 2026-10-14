-- CazaTech AI Receptionist — schema inicial
-- Convenções:
--  * Toda tabela de negócio tem tenant_id. Relações filhas usam FK composta (id, tenant_id)
--    para que o banco impeça, por construção, referências entre empresas diferentes.
--  * Datas em timestamptz (UTC). O fuso de exibição vem de tenants.timezone.
--  * Segredos nunca ficam em texto puro: apenas *_ciphertext (AES-256-GCM, chave fora do banco)
--    ou referências a um cofre (secret_ref).

CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------- empresas
CREATE TABLE tenants (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9-]{3,60}$'),
  timezone    text NOT NULL DEFAULT 'America/Sao_Paulo',
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deleted')),
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenant_settings (
  tenant_id               uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  ai_enabled              boolean NOT NULL DEFAULT true,
  booking_enabled         boolean NOT NULL DEFAULT false,  -- só agenda quando a empresa autoriza
  voice_reply_enabled     boolean NOT NULL DEFAULT false,
  business_info           jsonb   NOT NULL DEFAULT '{}'::jsonb, -- endereço, políticas, FAQ aprovada
  business_hours          jsonb   NOT NULL DEFAULT '{}'::jsonb, -- {"mon":[["09:00","18:00"]], ...}
  slot_step_minutes       int     NOT NULL DEFAULT 30 CHECK (slot_step_minutes BETWEEN 5 AND 120),
  min_notice_minutes      int     NOT NULL DEFAULT 120 CHECK (min_notice_minutes >= 0),
  booking_horizon_days    int     NOT NULL DEFAULT 30 CHECK (booking_horizon_days BETWEEN 1 AND 180),
  daily_llm_budget_micros bigint  NOT NULL DEFAULT 2000000 CHECK (daily_llm_budget_micros >= 0), -- US$ 2,00
  max_audio_seconds       int     NOT NULL DEFAULT 120 CHECK (max_audio_seconds BETWEEN 5 AND 600),
  message_retention_days  int     NOT NULL DEFAULT 90 CHECK (message_retention_days BETWEEN 1 AND 3650),
  handoff_webhook_url     text,   -- ex.: webhook do n8n que avisa a equipe
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE services (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name          text NOT NULL,
  duration_min  int  NOT NULL CHECK (duration_min BETWEEN 5 AND 600),
  price_text    text,             -- texto aprovado pela empresa ("a partir de R$ 80")
  active        boolean NOT NULL DEFAULT true,
  UNIQUE (id, tenant_id)
);
CREATE UNIQUE INDEX services_tenant_name_uq ON services (tenant_id, lower(name));

-- profissional / cadeira / sala: cada recurso tem a sua agenda
CREATE TABLE resources (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name                text NOT NULL,
  external_calendar_id text,       -- id da agenda no Google Calendar
  active              boolean NOT NULL DEFAULT true,
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, external_calendar_id)
);

CREATE TABLE resource_services (
  tenant_id   uuid NOT NULL,
  resource_id uuid NOT NULL,
  service_id  uuid NOT NULL,
  PRIMARY KEY (resource_id, service_id),
  FOREIGN KEY (resource_id, tenant_id) REFERENCES resources(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (service_id, tenant_id)  REFERENCES services(id, tenant_id)  ON DELETE CASCADE
);

-- ---------------------------------------------------------------- canais e credenciais
CREATE TABLE whatsapp_numbers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  phone_number_id  text NOT NULL UNIQUE,  -- roteia o webhook para a empresa
  display_phone    text,
  waba_id          text,
  access_token_ciphertext bytea,          -- token de sistema da Meta, cifrado
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE calendar_connections (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id              uuid NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE CASCADE,
  provider               text NOT NULL CHECK (provider IN ('google','fake')),
  auth_type              text NOT NULL CHECK (auth_type IN ('service_account','oauth_refresh_token')),
  credentials_ciphertext bytea,
  scopes                 text[] NOT NULL DEFAULT '{}',
  status                 text NOT NULL DEFAULT 'active' CHECK (status IN ('active','revoked','error')),
  last_error             text,
  created_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hash    text NOT NULL UNIQUE,     -- sha256 da chave; a chave em si nunca é salva
  label       text NOT NULL,
  revoked_at  timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- contatos e conversas
CREATE TABLE contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  wa_id            text NOT NULL,
  profile_name     text,
  display_name     text,   -- nome confirmado pelo próprio cliente
  last_inbound_at  timestamptz,  -- usado para a janela de 24h de atendimento
  erased_at        timestamptz,  -- pedido de exclusão (LGPD) atendido
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, wa_id)
);

CREATE TABLE consents (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL,
  contact_id  uuid NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('ai_processing','voice_reply','marketing')),
  granted     boolean NOT NULL,
  source      text NOT NULL,   -- 'notice_first_message', 'customer_request', 'admin'
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts(id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX consents_lookup_idx ON consents (tenant_id, contact_id, kind, created_at DESC);

CREATE TABLE conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  contact_id       uuid NOT NULL,
  status           text NOT NULL DEFAULT 'bot' CHECK (status IN ('bot','human','closed')),
  handoff_reason   text,
  handoff_at       timestamptz,
  lease_owner      text,          -- lease de processamento: 1 worker por conversa
  lease_until      timestamptz,
  last_inbound_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts(id, tenant_id) ON DELETE CASCADE
);
-- no máximo uma conversa aberta por contato
CREATE UNIQUE INDEX conversations_one_open_uq ON conversations (tenant_id, contact_id) WHERE status <> 'closed';

CREATE TABLE messages (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('in','out')),
  author           text NOT NULL CHECK (author IN ('contact','ai','human','system')),
  wa_message_id    text,
  kind             text NOT NULL CHECK (kind IN ('text','audio','unsupported')),
  body             text,
  transcript       text,
  media_id         text,
  media_mime       text,
  status           text NOT NULL,
  error            text,
  wa_timestamp     timestamptz,
  processed_at     timestamptz,
  redacted_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id) ON DELETE CASCADE,
  CHECK (
    (direction = 'in'  AND status IN ('received','processed','ignored','failed')) OR
    (direction = 'out' AND status IN ('pending','sent','delivered','read','failed'))
  )
);
-- deduplicação: a Meta pode reentregar o mesmo evento por até 7 dias
CREATE UNIQUE INDEX messages_wamid_uq ON messages (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL;
CREATE INDEX messages_conv_time_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_pending_in_idx ON messages (conversation_id, created_at) WHERE direction = 'in' AND processed_at IS NULL;

-- ---------------------------------------------------------------- webhooks e outbox
CREATE TABLE webhook_events (
  id               bigserial PRIMARY KEY,
  body_sha256      text NOT NULL UNIQUE,     -- reentrega idêntica = mesma linha
  phone_number_id  text,
  tenant_id        uuid REFERENCES tenants(id) ON DELETE SET NULL,
  payload          jsonb,                    -- apagado pela política de retenção
  status           text NOT NULL DEFAULT 'stored' CHECK (status IN ('stored','ingested','ignored','invalid')),
  error            text,
  received_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_events_received_idx ON webhook_events (received_at);

-- outbox transacional: gravado na mesma transação das mensagens; um relay leva ao Redis
CREATE TABLE outbox (
  id               bigserial PRIMARY KEY,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('process_conversation')),
  available_at     timestamptz NOT NULL DEFAULT now(),
  dispatched_at    timestamptz,
  attempts         int NOT NULL DEFAULT 0,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX outbox_pending_idx ON outbox (available_at) WHERE dispatched_at IS NULL;

-- ---------------------------------------------------------------- agenda
-- horários oferecidos ao cliente: o modelo só pode reservar um código que o sistema ofereceu
CREATE TABLE slot_offers (
  code             text NOT NULL CHECK (code ~ '^[A-Z0-9]{4,8}$'),
  tenant_id        uuid NOT NULL,
  conversation_id  uuid NOT NULL,
  service_id       uuid NOT NULL,
  resource_id      uuid NOT NULL,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  expires_at       timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, code),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (service_id, tenant_id) REFERENCES services(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (resource_id, tenant_id) REFERENCES resources(id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE booking_proposals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL,
  conversation_id   uuid NOT NULL,
  contact_id        uuid NOT NULL,
  action            text NOT NULL CHECK (action IN ('create','reschedule','cancel')),
  service_id        uuid,
  resource_id       uuid,
  starts_at         timestamptz,
  ends_at           timestamptz,
  target_booking_id uuid,
  customer_name     text,
  status            text NOT NULL DEFAULT 'open' CHECK (status IN ('open','confirmed','expired','superseded','failed')),
  expires_at        timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (conversation_id, tenant_id) REFERENCES conversations(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (contact_id, tenant_id) REFERENCES contacts(id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (service_id, tenant_id) REFERENCES services(id, tenant_id),
  FOREIGN KEY (resource_id, tenant_id) REFERENCES resources(id, tenant_id)
);
CREATE INDEX booking_proposals_conv_idx ON booking_proposals (conversation_id, created_at DESC);

CREATE TABLE bookings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL,
  resource_id        uuid NOT NULL,
  service_id         uuid NOT NULL,
  contact_id         uuid NOT NULL,
  conversation_id    uuid,
  proposal_id        uuid UNIQUE,      -- idempotência: uma proposta gera no máximo uma reserva
  starts_at          timestamptz NOT NULL,
  ends_at            timestamptz NOT NULL,
  status             text NOT NULL CHECK (status IN ('pending','confirmed','cancelled','failed')),
  external_event_id  text,
  customer_name      text,
  created_by         text NOT NULL CHECK (created_by IN ('ai','human')),
  error              text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (resource_id, tenant_id) REFERENCES resources(id, tenant_id),
  FOREIGN KEY (service_id, tenant_id)  REFERENCES services(id, tenant_id),
  FOREIGN KEY (contact_id, tenant_id)  REFERENCES contacts(id, tenant_id) ON DELETE CASCADE,
  -- duas reservas ativas nunca se sobrepõem no mesmo recurso, mesmo com workers concorrentes
  CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  ) WHERE (status IN ('pending','confirmed'))
);
CREATE INDEX bookings_contact_idx ON bookings (tenant_id, contact_id, starts_at);

-- ---------------------------------------------------------------- IA, custo e auditoria
CREATE TABLE agent_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  conversation_id  uuid NOT NULL,
  model            text NOT NULL,
  iterations       int NOT NULL DEFAULT 0,
  input_tokens     int NOT NULL DEFAULT 0,
  output_tokens    int NOT NULL DEFAULT 0,
  cost_micros      bigint NOT NULL DEFAULT 0,
  outcome          text NOT NULL DEFAULT 'running',
  error            text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz
);
CREATE INDEX agent_runs_budget_idx ON agent_runs (tenant_id, started_at);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid,
  actor       text NOT NULL,         -- 'ai', 'system', 'admin:<key_id>'
  action      text NOT NULL,
  entity      text,
  entity_id   text,
  data        jsonb NOT NULL DEFAULT '{}'::jsonb,  -- sem conteúdo de mensagens
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_tenant_idx ON audit_log (tenant_id, created_at);

-- a auditoria é somente inserção
CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.retention_job', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_log é somente inserção';
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();

CREATE TABLE schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
