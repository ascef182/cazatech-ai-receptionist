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
    /** código numérico de `error.code` (formato Graph API da Meta), quando o corpo é um JSON reconhecível */
    public readonly providerErrorCode?: number,
    public readonly providerErrorSubcode?: number,
  ) {
    super(`${service} respondeu HTTP ${status}`);
    this.name = 'HttpError';
  }
  get retryable(): boolean {
    if (this.status === 408 || this.status === 429 || this.status >= 500) return true;
    // A Meta nem sempre usa 429 para limite de taxa (ex.: código 4 "Application request limit reached",
    // 17 "User request limit reached", 80007 "WhatsApp Business API rate limit"); esses chegam como 4xx.
    if (this.service === 'whatsapp' && (this.providerErrorCode === 4 || this.providerErrorCode === 17 || this.providerErrorCode === 80007)) return true;
    return false;
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
