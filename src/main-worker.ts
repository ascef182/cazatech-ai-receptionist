import { loadConfig } from './config.js';
import { buildProcessorDeps } from './deps.js';
import { BullConversationQueue, createRedis } from './queue/conversation-queue.js';
import { startConversationWorker, startMaintenance } from './worker/run-worker.js';

const config = loadConfig();
const deps = buildProcessorDeps(config);
const workerRedis = createRedis(config.REDIS_URL, { forWorker: true });
const producerRedis = createRedis(config.REDIS_URL);
producerRedis.on('error', (e) => deps.log.warn({ err: e.message }, 'redis indisponível'));
const queue = new BullConversationQueue(producerRedis, config.QUEUE_PREFIX, config.DEBOUNCE_MS, config.ENQUEUE_TIMEOUT_MS);

const worker = startConversationWorker(deps, workerRedis, { prefix: config.QUEUE_PREFIX, concurrency: config.WORKER_CONCURRENCY });
const maintenance = startMaintenance(deps.db, queue, deps.log, {
  intervalMs: config.OUTBOX_RELAY_INTERVAL_MS,
  staleAfterMs: config.DEBOUNCE_MS + config.LEASE_MS,
});
deps.log.info({ concurrency: config.WORKER_CONCURRENCY }, 'worker iniciado');

const shutdown = async () => {
  deps.log.info('encerrando worker');
  maintenance.stop();
  await worker.close();
  await queue.close().catch(() => undefined);
  workerRedis.disconnect();
  producerRedis.disconnect();
  await deps.db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
