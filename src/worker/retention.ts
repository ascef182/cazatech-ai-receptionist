import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';

export interface RetentionReport {
  messagesRedacted: number;
  webhookPayloadsCleared: number;
  webhookEventsDeleted: number;
  offersDeleted: number;
  auditDeleted: number;
}

/**
 * Política de retenção (padrões; ver docs/08-seguranca-e-privacidade.md):
 *  - conteúdo de mensagens (texto e transcrição): tenant_settings.message_retention_days (padrão 90)
 *  - payload bruto de webhook: limpo após 7 dias; linha removida após 30 dias
 *  - códigos de horário oferecidos: removidos 1 dia após expirar
 *  - auditoria: 365 dias
 * Áudios nunca são armazenados (só processados em memória).
 */
export async function purgeRetention(db: Db): Promise<RetentionReport> {
  return withTx(db, async (c) => {
    const m = await c.query(
      `UPDATE messages m SET body = NULL, transcript = NULL, media_id = NULL, redacted_at = now()
       FROM tenant_settings s
       WHERE m.tenant_id = s.tenant_id AND m.redacted_at IS NULL
         AND m.created_at < now() - make_interval(days => s.message_retention_days)`,
    );
    const wp = await c.query(`UPDATE webhook_events SET payload = NULL WHERE payload IS NOT NULL AND received_at < now() - interval '7 days'`);
    const wd = await c.query(`DELETE FROM webhook_events WHERE received_at < now() - interval '30 days'`);
    const so = await c.query(`DELETE FROM slot_offers WHERE expires_at < now() - interval '1 day'`);
    await c.query(`SET LOCAL app.retention_job = 'on'`);
    const au = await c.query(`DELETE FROM audit_log WHERE created_at < now() - interval '365 days'`);
    return {
      messagesRedacted: m.rowCount ?? 0,
      webhookPayloadsCleared: wp.rowCount ?? 0,
      webhookEventsDeleted: wd.rowCount ?? 0,
      offersDeleted: so.rowCount ?? 0,
      auditDeleted: au.rowCount ?? 0,
    };
  });
}
