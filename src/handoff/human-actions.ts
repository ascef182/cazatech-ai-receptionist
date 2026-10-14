import type { Db } from '../db/pool.js';
import { withTx } from '../db/pool.js';
import { audit } from '../db/audit.js';
import { loadTenantContext } from '../tenant/context.js';
import type { WhatsAppClient } from '../whatsapp/client.js';

export interface HumanActions {
  sendHumanReply(tenantId: string, conversationId: string, text: string, actor: string): Promise<boolean>;
  eraseContact(tenantId: string, contactId: string, actor: string): Promise<boolean>;
}

export function createHumanActions(db: Db, wa: WhatsAppClient, encKey: string): HumanActions {
  return {
    async sendHumanReply(tenantId, conversationId, text, actor) {
      const r = await db.query(
        `SELECT c.id, ct.wa_id FROM conversations c JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
         WHERE c.id = $1 AND c.tenant_id = $2 AND ct.erased_at IS NULL`,
        [conversationId, tenantId],
      );
      if (!r.rowCount) return false;
      const t = await loadTenantContext(db, tenantId, encKey);
      // Resposta humana coloca a conversa em modo humano: a IA não responde por cima da equipe.
      const msg = await withTx(db, async (c) => {
        await c.query(`UPDATE conversations SET status = 'human', handoff_at = COALESCE(handoff_at, now()), handoff_reason = COALESCE(handoff_reason, 'human_took_over') WHERE id = $1`, [conversationId]);
        const m = await c.query(
          `INSERT INTO messages (tenant_id, conversation_id, direction, author, kind, body, status)
           VALUES ($1,$2,'out','human','text',$3,'pending') RETURNING id`,
          [tenantId, conversationId, text],
        );
        await audit(c, { tenantId, actor, action: 'message.human_reply', entity: 'conversation', entityId: conversationId });
        return m.rows[0].id as string;
      });
      try {
        const sent = await wa.sendText(t.channel, r.rows[0].wa_id, text);
        await db.query(`UPDATE messages SET status = 'sent', wa_message_id = $2 WHERE id = $1`, [msg, sent.wamid]);
      } catch (err) {
        await db.query(`UPDATE messages SET status = 'failed', error = $2 WHERE id = $1`, [msg, (err as Error).message.slice(0, 200)]);
        throw err;
      }
      return true;
    },

    async eraseContact(tenantId, contactId, actor) {
      return withTx(db, async (c) => {
        const r = await c.query(`SELECT id FROM contacts WHERE id = $1 AND tenant_id = $2 FOR UPDATE`, [contactId, tenantId]);
        if (!r.rowCount) return false;
        // Mantém registros de agenda (obrigação operacional), mas remove identificação e conteúdo.
        await c.query(
          `UPDATE messages m SET body = NULL, transcript = NULL, media_id = NULL, redacted_at = now()
           FROM conversations cv WHERE m.conversation_id = cv.id AND cv.contact_id = $1 AND m.tenant_id = $2`,
          [contactId, tenantId],
        );
        await c.query(`UPDATE bookings SET customer_name = NULL WHERE contact_id = $1 AND tenant_id = $2`, [contactId, tenantId]);
        await c.query(
          `UPDATE contacts SET wa_id = 'erased:' || id::text, profile_name = NULL, display_name = NULL, erased_at = now() WHERE id = $1`,
          [contactId],
        );
        await c.query(`UPDATE conversations SET status = 'closed' WHERE contact_id = $1 AND tenant_id = $2`, [contactId, tenantId]);
        await audit(c, { tenantId, actor, action: 'contact.erased', entity: 'contact', entityId: contactId });
        return true;
      });
    },
  };
}
