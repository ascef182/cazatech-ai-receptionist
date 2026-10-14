import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { createLogger } from './lib/logger.js';
import { buildApp } from './http/app.js';
import { BullConversationQueue, createRedis } from './queue/conversation-queue.js';
import { createHumanActions } from './handoff/human-actions.js';
import { GraphWhatsAppClient } from './whatsapp/client.js';

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
const db = createPool(config.DATABASE_URL);
const redis = createRedis(config.REDIS_URL);
redis.on('error', (e) => logger.warn({ err: e.message }, 'redis indisponível'));
const queue = new BullConversationQueue(redis, config.QUEUE_PREFIX, config.DEBOUNCE_MS, config.ENQUEUE_TIMEOUT_MS);
const wa = new GraphWhatsAppClient(config.WHATSAPP_GRAPH_BASE_URL, config.WHATSAPP_GRAPH_VERSION);

const app = await buildApp({
  config,
  db,
  queue,
  logger,
  human: createHumanActions(db, wa, config.DATA_ENCRYPTION_KEY),
  redisPing: async () => (await Promise.race([redis.ping(), new Promise((r) => setTimeout(() => r('timeout'), 500))])) === 'PONG',
});

await app.listen({ host: '0.0.0.0', port: config.PORT });

const shutdown = async () => {
  logger.info('encerrando API');
  await app.close();
  await queue.close().catch(() => undefined);
  redis.disconnect();
  await db.end();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
