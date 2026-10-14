import type pg from 'pg';
import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { sha256Hex } from '../lib/crypto.js';
import { ChangeValueSchema, WebhookPayloadSchema, type InboundMessage } from './webhook-schema.js';

export interface IngestResult {
  duplicate: boolean;
  eventId: number | null;
  status: 'ingested' | 'ignored' | 'invalid' | 'duplicate';
  newMessages: number;
  statusUpdates: number;
  /** conversas que receberam mensagens novas e precisam ser processadas */
  toProcess: { tenantId: string; conversationId: string; outboxId: number }[];
}

const STATUS_RANK: Record<string, number> = { pending: 0, sent: 1, delivered: 2, read: 3, failed: 4 };

/**
 * Persiste o evento do webhook e tudo o que dele deriva numa única transação:
 * evento bruto (dedupe por hash do corpo), contato, conversa, mensagens (dedupe por wamid),
 * status de entrega e linhas de outbox. Nada aqui chama serviços externos.
 */
export async function ingestWebhook(db: Db, rawBody: Buffer, opts: { storePayload: boolean }): Promise<IngestResult> {
  const bodyHash = sha256Hex(rawBody);
  let json: unknown;
  try {
    json = JSON.parse(rawBody.toString('utf8'));
  } catch {
    json = null;
  }

  return withTx(db, async (c) => {
    const parsed = WebhookPayloadSchema.safeParse(json);
    const ins = await c.query(
      `INSERT INTO webhook_events (body_sha256, payload, status, error)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (body_sha256) DO NOTHING RETURNING id`,
      [
        bodyHash,
        opts.storePayload && json !== null ? json : null,
        parsed.success ? 'stored' : 'invalid',
        parsed.success ? null : parsed.error.issues.slice(0, 3).map((i) => i.path.join('.') + ': ' + i.message).join('; '),
      ],
    );
    if (ins.rowCount === 0) {
      return { duplicate: true, eventId: null, status: 'duplicate', newMessages: 0, statusUpdates: 0, toProcess: [] };
    }
    const eventId = Number(ins.rows[0].id);
    if (!parsed.success) {
      return { duplicate: false, eventId, status: 'invalid', newMessages: 0, statusUpdates: 0, toProcess: [] };
    }

    let newMessages = 0;
    let statusUpdates = 0;
    let anyKnownTenant = false;
    const toProcess = new Map<string, { tenantId: string; conversationId: string; outboxId: number }>();
    let firstPhoneNumberId: string | null = null;
    let firstTenant: string | null = null;

    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;
        const v = ChangeValueSchema.safeParse(change.value);
        if (!v.success) continue;
        const value = v.data;
        const phoneNumberId = value.metadata.phone_number_id;
        firstPhoneNumberId ??= phoneNumberId;
        const t = await c.query(`SELECT tenant_id FROM whatsapp_numbers WHERE phone_number_id = $1`, [phoneNumberId]);
        if (t.rowCount === 0) continue; // número que não pertence a nenhuma empresa cadastrada
        const tenantId: string = t.rows[0].tenant_id;
        anyKnownTenant = true;
        firstTenant ??= tenantId;

        const names = new Map<string, string | undefined>();
        for (const ct of value.contacts ?? []) names.set(ct.wa_id, ct.profile?.name);

        for (const m of value.messages ?? []) {
          const r = await storeInbound(c, tenantId, m, names.get(m.from));
          if (r) {
            newMessages++;
            if (!toProcess.has(r.conversationId)) {
              const ob = await c.query(
                `INSERT INTO outbox (tenant_id, conversation_id, kind) VALUES ($1,$2,'process_conversation') RETURNING id`,
                [tenantId, r.conversationId],
              );
              toProcess.set(r.conversationId, { tenantId, conversationId: r.conversationId, outboxId: Number(ob.rows[0].id) });
            }
          }
        }

        for (const s of value.statuses ?? []) {
          const rank = STATUS_RANK[s.status];
          if (rank === undefined) continue;
          const u = await c.query(
            `UPDATE messages SET status = $3, error = COALESCE($4, error)
             WHERE tenant_id = $1 AND wa_message_id = $2 AND direction = 'out'
               AND (CASE status WHEN 'pending' THEN 0 WHEN 'sent' THEN 1 WHEN 'delivered' THEN 2 WHEN 'read' THEN 3 ELSE 4 END) < $5`,
            [tenantId, s.id, s.status, s.errors?.[0]?.title ?? null, rank],
          );
          statusUpdates += u.rowCount ?? 0;
        }
      }
    }

    const status = anyKnownTenant ? 'ingested' : 'ignored';
    await c.query(`UPDATE webhook_events SET status = $2, phone_number_id = $3, tenant_id = $4 WHERE id = $1`, [
      eventId,
      status,
      firstPhoneNumberId,
      firstTenant,
    ]);
    return { duplicate: false, eventId, status, newMessages, statusUpdates, toProcess: [...toProcess.values()] };
  });
}

async function storeInbound(
  c: pg.PoolClient,
  tenantId: string,
  m: InboundMessage,
  profileName: string | undefined,
): Promise<{ conversationId: string } | null> {
  const waTime = new Date(Number(m.timestamp) * 1000);

  const contact = await c.query(
    `INSERT INTO contacts (tenant_id, wa_id, profile_name, last_inbound_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (tenant_id, wa_id) DO UPDATE
       SET profile_name = COALESCE(EXCLUDED.profile_name, contacts.profile_name),
           last_inbound_at = GREATEST(contacts.last_inbound_at, EXCLUDED.last_inbound_at)
     RETURNING id`,
    [tenantId, m.from, profileName ?? null, waTime],
  );
  const contactId: string = contact.rows[0].id;

  const conv = await c.query(
    `INSERT INTO conversations (tenant_id, contact_id, last_inbound_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (tenant_id, contact_id) WHERE status <> 'closed' DO UPDATE
       SET last_inbound_at = GREATEST(conversations.last_inbound_at, EXCLUDED.last_inbound_at)
     RETURNING id`,
    [tenantId, contactId, waTime],
  );
  const conversationId: string = conv.rows[0].id;

  let kind: 'text' | 'audio' | 'unsupported' = 'unsupported';
  let body: string | null = null;
  let mediaId: string | null = null;
  let mediaMime: string | null = null;
  if (m.type === 'text' && m.text) {
    kind = 'text';
    body = m.text.body;
  } else if (m.type === 'audio' && m.audio) {
    kind = 'audio';
    mediaId = m.audio.id;
    mediaMime = m.audio.mime_type ?? null;
  }

  const msg = await c.query(
    `INSERT INTO messages (tenant_id, conversation_id, direction, author, wa_message_id, kind, body, media_id, media_mime, status, wa_timestamp)
     VALUES ($1,$2,'in','contact',$3,$4,$5,$6,$7,'received',$8)
     ON CONFLICT (tenant_id, wa_message_id) WHERE wa_message_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [tenantId, conversationId, m.id, kind, body, mediaId, mediaMime, waTime],
  );
  return msg.rowCount ? { conversationId } : null;
}
