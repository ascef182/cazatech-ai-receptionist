/** Falha temporária: o job deve ser repetido (timeout, 429, 5xx, rede). */
export class RetryableError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'RetryableError';
  }
}

/** Falha definitiva: repetir não ajuda (4xx de validação, credencial revogada, entrada inválida). */
export class PermanentError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

export class HttpError extends Error {
  constructor(
    public readonly service: string,
    public readonly status: number,
    public readonly bodySnippet: string,
  ) {
    super(`${service} respondeu HTTP ${status}`);
    this.name = 'HttpError';
  }
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500;
  }
}

export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryableError) return true;
  if (err instanceof PermanentError) return false;
  if (err instanceof HttpError) return err.retryable;
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) return true;
  // erros de rede do fetch (undici) chegam como TypeError("fetch failed")
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return true;
  return false;
}
