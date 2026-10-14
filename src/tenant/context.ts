import type { Queryable } from '../db/pool.js';
import { decryptSecret } from '../lib/crypto.js';
import { PermanentError } from '../lib/errors.js';
import type { WaChannel } from '../whatsapp/client.js';

export interface BusinessHours {
  [weekday: string]: [string, string][];
}

export interface TenantSettings {
  ai_enabled: boolean;
  booking_enabled: boolean;
  voice_reply_enabled: boolean;
  business_info: Record<string, unknown>;
  business_hours: BusinessHours;
  slot_step_minutes: number;
  min_notice_minutes: number;
  booking_horizon_days: number;
  daily_llm_budget_micros: number;
  max_audio_seconds: number;
  message_retention_days: number;
  handoff_webhook_url: string | null;
}

export interface ServiceRow {
  id: string;
  name: string;
  duration_min: number;
  price_text: string | null;
}

export interface ResourceRow {
  id: string;
  name: string;
  external_calendar_id: string | null;
  service_ids: string[];
}

export interface TenantContext {
  id: string;
  name: string;
  timezone: string;
  status: string;
  settings: TenantSettings;
  services: ServiceRow[];
  resources: ResourceRow[];
  channel: WaChannel;
}

export async function loadTenantContext(q: Queryable, tenantId: string, encKey: string): Promise<TenantContext> {
  const t = await q.query(
    `SELECT t.id, t.name, t.timezone, t.status, row_to_json(s) AS settings, w.phone_number_id, w.access_token_ciphertext
     FROM tenants t
     JOIN tenant_settings s ON s.tenant_id = t.id
     JOIN whatsapp_numbers w ON w.tenant_id = t.id
     WHERE t.id = $1
     LIMIT 1`,
    [tenantId],
  );
  if (!t.rowCount) throw new PermanentError('empresa sem configuração completa', 'tenant_not_configured');
  const row = t.rows[0];
  if (!row.access_token_ciphertext) throw new PermanentError('número sem token de acesso', 'no_whatsapp_token');

  const services = await q.query(
    `SELECT id, name, duration_min, price_text FROM services WHERE tenant_id = $1 AND active ORDER BY name`,
    [tenantId],
  );
  const resources = await q.query(
    `SELECT r.id, r.name, r.external_calendar_id,
            COALESCE(array_agg(rs.service_id) FILTER (WHERE rs.service_id IS NOT NULL), '{}') AS service_ids
     FROM resources r LEFT JOIN resource_services rs ON rs.resource_id = r.id AND rs.tenant_id = r.tenant_id
     WHERE r.tenant_id = $1 AND r.active
     GROUP BY r.id ORDER BY r.name`,
    [tenantId],
  );

  return {
    id: row.id,
    name: row.name,
    timezone: row.timezone,
    status: row.status,
    settings: { ...row.settings, daily_llm_budget_micros: Number(row.settings.daily_llm_budget_micros) },
    services: services.rows,
    resources: resources.rows,
    channel: { phoneNumberId: row.phone_number_id, accessToken: decryptSecret(row.access_token_ciphertext, encKey) },
  };
}
