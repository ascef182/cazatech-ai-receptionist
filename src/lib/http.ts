import { HttpError } from './errors.js';

export type FetchLike = typeof fetch;

export interface RequestOptions {
  service: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

/** Extrai `error.code`/`error.error_subcode` de um corpo de erro no formato da Graph API da Meta, se reconhecível. */
function parseProviderErrorCode(text: string): { code?: number; subcode?: number } {
  try {
    const body = JSON.parse(text) as { error?: { code?: unknown; error_subcode?: unknown } };
    const code = typeof body.error?.code === 'number' ? body.error.code : undefined;
    const subcode = typeof body.error?.error_subcode === 'number' ? body.error.error_subcode : undefined;
    return { code, subcode };
  } catch {
    return {};
  }
}

/** fetch com timeout e erro tipado; nunca inclui o corpo inteiro da resposta no erro. */
export async function httpRequest(url: string, init: RequestInit, opts: RequestOptions): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await f(url, { ...init, signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const { code, subcode } = parseProviderErrorCode(text);
    throw new HttpError(opts.service, res.status, text.slice(0, 300), code, subcode);
  }
  return res;
}

export async function httpJson<T>(url: string, init: RequestInit, opts: RequestOptions): Promise<T> {
  const res = await httpRequest(url, init, opts);
  return (await res.json()) as T;
}
