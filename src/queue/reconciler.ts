import type { Db } from '../db/pool.js';
import type { Logger } from '../lib/logger.js';
import type { ConversationQueue } from './conversation-queue.js';

/**
 * Rede de segurança entre Postgres (fonte da verdade) e Redis (fila):
 *  1. despacha linhas de outbox que o webhook não conseguiu enfileirar (Redis fora do ar);
 *  2. reenfileira conversas com mensagens recebidas há tempo demais sem processamento
 *     (job perdido, worker que caiu, deduplicação que engoliu um gatilho).
 * Usa um advisory lock para rodar em uma única instância por vez.
 */
export async function reconcileOnce(
  db: Db,
  queue: ConversationQueue,
  log: Logger,
  opts: { staleAfterMs: number; batch?: number } ,
): Promise<{ dispatched: number; requeued: number; skipped: boolean }> {
  const client = await db.connect();
  let dispatched = 0;
  let requeued = 0;
  try {
    const lock = await client.query(`SELECT pg_try_advisory_lock(727275) AS ok`);
    if (!lock.rows[0].ok) return { dispatched, requeued, skipped: true };
    try {
      const pending = await client.query(
        `SELECT id, tenant_id, conversation_id FROM outbox
         WHERE dispatched_at IS NULL AND available_at <= now()
         ORDER BY id LIMIT $1`,
        [opts.batch ?? 200],
      );
      for (const row of pending.rows) {
        try {
          await queue.enqueue({ tenantId: row.tenant_id, conversationId: row.conversation_id });
          await client.query(`UPDATE outbox SET dispatched_at = now(), attempts = attempts + 1 WHERE id = $1`, [row.id]);
          dispatched++;
        } catch (err) {
          await client.query(
            `UPDATE outbox SET attempts = attempts + 1, last_error = $2,
               available_at = now() + make_interval(secs => LEAST(60, power(2, attempts)::int))
             WHERE id = $1`,
            [row.id, (err as Error).message.slice(0, 200)],
          );
          log.warn({ err: (err as Error).message }, 'outbox: falha ao enfileirar; Redis indisponível?');
          break; // se o Redis caiu, não adianta insistir agora
        }
      }

      const stale = await client.query(
        `SELECT DISTINCT c.tenant_id, c.id AS conversation_id
         FROM conversations c
         JOIN messages m ON m.conversation_id = c.id AND m.tenant_id = c.tenant_id
         WHERE m.direction = 'in' AND m.processed_at IS NULL
           AND m.created_at < now() - make_interval(secs => $1::double precision / 1000)
           AND (c.lease_until IS NULL OR c.lease_until < now())
         LIMIT 100`,
        [opts.staleAfterMs],
      );
      for (const row of stale.rows) {
        try {
          await queue.enqueue({ tenantId: row.tenant_id, conversationId: row.conversation_id }, { debounceMs: 0 });
          requeued++;
        } catch {
          break;
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(727275)`);
    }
  } finally {
    client.release();
  }
  if (dispatched || requeued) log.info({ dispatched, requeued }, 'reconciliação executada');
  return { dispatched, requeued, skipped: false };
}
