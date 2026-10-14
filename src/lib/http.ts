import { HttpError } from './errors.js';

export type FetchLike = typeof fetch;

export interface RequestOptions {
  service: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}

/** fetch com timeout e erro tipado; nunca inclui o corpo inteiro da resposta no erro. */
export async function httpRequest(url: string, init: RequestInit, opts: RequestOptions): Promise<Response> {
  const f = opts.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  const res = await f(url, { ...init, signal });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new HttpError(opts.service, res.status, text.slice(0, 300));
  }
  return res;
}

export async function httpJson<T>(url: string, init: RequestInit, opts: RequestOptions): Promise<T> {
  const res = await httpRequest(url, init, opts);
  return (await res.json()) as T;
}
