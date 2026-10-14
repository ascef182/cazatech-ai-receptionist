import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Db } from '../db/pool.js';
import { audit } from '../db/audit.js';
import { safeEqual, sha256Hex, verifyMetaSignature } from '../lib/crypto.js';
import type { Logger } from '../lib/logger.js';
import type { ConversationQueue } from '../queue/conversation-queue.js';
import { withTimeout } from '../queue/conversation-queue.js';
import { ingestWebhook } from '../whatsapp/ingest.js';
import { FixedWindowLimiter } from './rate-limit.js';
import type { HumanActions } from '../handoff/human-actions.js';

export interface AppDeps {
  config: Pick<
    Config,
    | 'WHATSAPP_APP_SECRET'
    | 'WHATSAPP_VERIFY_TOKEN'
    | 'ENQUEUE_TIMEOUT_MS'
    | 'RATE_LIMIT_PER_MINUTE'
    | 'ADMIN_RATE_LIMIT_PER_MINUTE'
    | 'STORE_WEBHOOK_PAYLOADS'
  >;
  db: Db;
  queue: ConversationQueue;
  logger: Logger;
  human?: HumanActions;
  redisPing?: () => Promise<boolean>;
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBody?: Buffer;
    adminTenantId?: string;
    adminKeyId?: string;
  }
}

export async function buildApp(deps: AppDeps) {
  const app = Fastify({ loggerInstance: deps.logger, bodyLimit: 3 * 1024 * 1024 + 1024, trustProxy: true });
  const webhookLimiter = new FixedWindowLimiter(deps.config.RATE_LIMIT_PER_MINUTE);
  const adminLimiter = new FixedWindowLimiter(deps.config.ADMIN_RATE_LIMIT_PER_MINUTE);

  // Corpo bruto: a assinatura da Meta é calculada sobre os bytes exatos recebidos.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as FastifyRequest).rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch {
      done(null, null);
    }
  });

  app.get('/health/live', async () => ({ ok: true }));
  app.get('/health/ready', async (_req, reply) => {
    let db = false;
    try {
      await deps.db.query('SELECT 1');
      db = true;
    } catch {}
    let redis: boolean | null = null;
    if (deps.redisPing) redis = await deps.redisPing().catch(() => false);
    // Redis fora do ar degrada, mas não derruba a recepção: o outbox segura os eventos.
    return reply.code(db ? 200 : 503).send({ db, redis, degraded: redis === false });
  });

  // ---------------------------------------------------------------- webhook da Meta
  app.get('/webhooks/whatsapp', async (req, reply) => {
    const q = req.query as Record<string, string | undefined>;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] && safeEqual(q['hub.verify_token'], deps.config.WHATSAPP_VERIFY_TOKEN)) {
      return reply.code(200).type('text/plain').send(q['hub.challenge'] ?? '');
    }
    return reply.code(403).send();
  });

  app.post('/webhooks/whatsapp', async (req, reply) => {
    if (!webhookLimiter.take(req.ip)) return reply.code(429).send();
    const raw = req.rawBody;
    if (!raw || !verifyMetaSignature(raw, req.headers['x-hub-signature-256'] as string | undefined, deps.config.WHATSAPP_APP_SECRET)) {
      req.log.warn({ ip: req.ip }, 'webhook com assinatura inválida');
      return reply.code(401).send();
    }

    // Se o Postgres falhar aqui, respondemos 500 e a Meta reentrega: nada foi perdido.
    const result = await ingestWebhook(deps.db, raw, { storePayload: deps.config.STORE_WEBHOOK_PAYLOADS });

    // Enfileiramento é "melhor esforço" e com prazo curto. Se o Redis estiver fora,
    // as linhas do outbox continuam pendentes e o reconciliador despacha depois.
    await Promise.all(
      result.toProcess.map(async (t) => {
        try {
          await withTimeout(deps.queue.enqueue({ tenantId: t.tenantId, conversationId: t.conversationId }), deps.config.ENQUEUE_TIMEOUT_MS, 'enqueue');
          await deps.db.query(`UPDATE outbox SET dispatched_at = now(), attempts = attempts + 1 WHERE id = $1`, [t.outboxId]);
        } catch (err) {
          req.log.warn({ err: (err as Error).message, outboxId: t.outboxId }, 'enfileiramento adiado para o outbox');
        }
      }),
    );
    req.log.info({ eventId: result.eventId, status: result.status, newMessages: result.newMessages }, 'webhook processado');
    return reply.code(200).send();
  });

  // ---------------------------------------------------------------- administração (por empresa)
  const adminAuth = async (req: FastifyRequest) => {
    const h = req.headers.authorization;
    if (!h?.startsWith('Bearer ')) return false;
    const r = await deps.db.query(
      `SELECT id, tenant_id FROM admin_api_keys WHERE key_hash = $1 AND revoked_at IS NULL`,
      [sha256Hex(h.slice(7).trim())],
    );
    if (r.rowCount === 0) return false;
    req.adminTenantId = r.rows[0].tenant_id;
    req.adminKeyId = r.rows[0].id;
    return true;
  };

  app.register(async (admin) => {
    admin.addHook('onRequest', async (req, reply) => {
      if (!adminLimiter.take(`admin:${req.ip}`)) return reply.code(429).send();
      if (!(await adminAuth(req))) return reply.code(401).send();
    });

    admin.get('/admin/conversations', async (req) => {
      const status = z.enum(['bot', 'human', 'closed']).default('human').parse((req.query as any)?.status);
      const r = await deps.db.query(
        `SELECT c.id, c.status, c.handoff_reason, c.handoff_at, c.last_inbound_at, ct.display_name, ct.profile_name
         FROM conversations c JOIN contacts ct ON ct.id = c.contact_id AND ct.tenant_id = c.tenant_id
         WHERE c.tenant_id = $1 AND c.status = $2 ORDER BY c.last_inbound_at DESC NULLS LAST LIMIT 100`,
        [req.adminTenantId, status],
      );
      return r.rows;
    });

    admin.post('/admin/conversations/:id/release', async (req, reply) => {
      const id = z.uuid().parse((req.params as any).id);
      const r = await deps.db.query(
        `UPDATE conversations SET status = 'bot', handoff_reason = NULL WHERE id = $1 AND tenant_id = $2 AND status = 'human' RETURNING id`,
        [id, req.adminTenantId],
      );
      if (!r.rowCount) return reply.code(404).send();
      await audit(deps.db, { tenantId: req.adminTenantId!, actor: `admin:${req.adminKeyId}`, action: 'conversation.release_to_bot', entity: 'conversation', entityId: id });
      return { ok: true };
    });

    admin.post('/admin/conversations/:id/messages', async (req, reply) => {
      if (!deps.human) return reply.code(501).send();
      const id = z.uuid().parse((req.params as any).id);
      const body = z.object({ text: z.string().min(1).max(4096) }).parse(req.body);
      const ok = await deps.human.sendHumanReply(req.adminTenantId!, id, body.text, `admin:${req.adminKeyId}`);
      return ok ? { ok: true } : reply.code(404).send();
    });

    admin.post('/admin/contacts/:id/erase', async (req, reply) => {
      if (!deps.human) return reply.code(501).send();
      const id = z.uuid().parse((req.params as any).id);
      const ok = await deps.human.eraseContact(req.adminTenantId!, id, `admin:${req.adminKeyId}`);
      return ok ? { ok: true } : reply.code(404).send();
    });
  });

  app.setErrorHandler((err: Error, req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: 'entrada inválida' });
    req.log.error({ err: err.message }, 'erro não tratado');
    return reply.code(500).send();
  });

  return app;
}
