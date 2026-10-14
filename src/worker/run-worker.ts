import { DelayedError, Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Db } from '../db/pool.js';
import type { Logger } from '../lib/logger.js';
import { CONVERSATION_QUEUE, type ConversationJob, type ConversationQueue } from '../queue/conversation-queue.js';
import { reconcileOnce } from '../queue/reconciler.js';
import { processConversation, type ProcessorDeps } from './processor.js';
import { purgeRetention } from './retention.js';

export function startConversationWorker(
  deps: ProcessorDeps,
  connection: Redis,
  opts: { prefix: string; concurrency: number },
): Worker<ConversationJob> {
  const worker = new Worker<ConversationJob>(
    CONVERSATION_QUEUE,
    async (job: Job<ConversationJob>, token?: string) => {
      const finalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      const res = await processConversation(deps, job.data, { finalAttempt });
      if (res.status === 'busy') {
        // Outro worker está com a conversa: reagenda sem consumir tentativa.
        await job.moveToDelayed(Date.now() + 1_500, token);
        throw new DelayedError();
      }
      return res;
    },
    { connection, prefix: opts.prefix, concurrency: opts.concurrency },
  );
  worker.on('failed', (job, err) => deps.log.error({ jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, 'job falhou'));
  worker.on('error', (err) => deps.log.error({ err: err.message }, 'erro no worker'));
  return worker;
}

/** Laço de manutenção: outbox, conversas paradas e retenção. */
export function startMaintenance(db: Db, queue: ConversationQueue, log: Logger, opts: { intervalMs: number; staleAfterMs: number }) {
  let running = false;
  let lastRetention = 0;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await reconcileOnce(db, queue, log, { staleAfterMs: opts.staleAfterMs });
      if (Date.now() - lastRetention > 3600_000) {
        lastRetention = Date.now();
        const r = await purgeRetention(db);
        log.info(r, 'retenção aplicada');
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'manutenção falhou; nova tentativa no próximo ciclo');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(tick, opts.intervalMs);
  return { stop: () => clearInterval(timer), tick };
}
