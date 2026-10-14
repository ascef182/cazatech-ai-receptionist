import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

export const CONVERSATION_QUEUE = 'conversations';

export interface ConversationJob {
  tenantId: string;
  conversationId: string;
}

export interface ConversationQueue {
  /** Agenda o processamento com debounce: mensagens em sequência viram um único job. */
  enqueue(job: ConversationJob, opts?: { debounceMs?: number }): Promise<void>;
  close(): Promise<void>;
}

export function createRedis(url: string, opts: { forWorker?: boolean } = {}): Redis {
  return new Redis(url, {
    // Workers do BullMQ exigem maxRetriesPerRequest = null. No produtor (API) limitamos as tentativas;
    // o prazo curto de cada enfileiramento é garantido por withTimeout, então o webhook nunca fica preso.
    maxRetriesPerRequest: opts.forWorker ? null : 1,
    connectTimeout: 2_000,
    lazyConnect: false,
  });
}

export class BullConversationQueue implements ConversationQueue {
  readonly queue: Queue<ConversationJob>;

  constructor(
    connection: Redis,
    prefix: string,
    private readonly defaultDebounceMs: number,
    private readonly timeoutMs: number,
  ) {
    this.queue = new Queue<ConversationJob>(CONVERSATION_QUEUE, {
      connection,
      prefix,
      skipWaitingForReady: true,
      defaultJobOptions: {
        attempts: 6,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { count: 1_000 },
        removeOnFail: { count: 5_000 },
      },
    });
    // Erros de conexão são tratados pelo chamador (outbox); evita "unhandled error" no processo.
    this.queue.on('error', () => undefined);
  }

  async enqueue(job: ConversationJob, opts: { debounceMs?: number } = {}) {
    const debounce = opts.debounceMs ?? this.defaultDebounceMs;
    const add = this.queue.add('process', job, {
      deduplication: debounce > 0
        ? { id: `conv:${job.conversationId}`, ttl: debounce, extend: true, replace: true }
        : { id: `conv:${job.conversationId}` },
      delay: debounce,
    });
    await withTimeout(add, this.timeoutMs, 'enqueue');
  }

  async close() {
    await this.queue.close();
  }
}

export async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label}: timeout após ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, t]);
  } finally {
    clearTimeout(timer);
  }
}

/** Implementação síncrona para testes unitários. */
export class InMemoryConversationQueue implements ConversationQueue {
  jobs: ConversationJob[] = [];
  down = false;
  async enqueue(job: ConversationJob) {
    if (this.down) throw new Error('redis indisponível (simulado)');
    if (!this.jobs.some((j) => j.conversationId === job.conversationId)) this.jobs.push(job);
  }
  drain() {
    const j = this.jobs;
    this.jobs = [];
    return j;
  }
  async close() {}
}
