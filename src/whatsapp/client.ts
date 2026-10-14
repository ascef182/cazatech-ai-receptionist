import { HttpError, PermanentError } from '../lib/errors.js';
import { httpJson, httpRequest, type FetchLike } from '../lib/http.js';

export interface WaChannel {
  phoneNumberId: string;
  accessToken: string;
}

export interface MediaInfo {
  url: string;
  mime_type: string;
  file_size?: number;
  sha256?: string;
}

export interface WhatsAppClient {
  sendText(ch: WaChannel, to: string, body: string): Promise<{ wamid: string }>;
  sendAudio(ch: WaChannel, to: string, mediaId: string, voice: boolean): Promise<{ wamid: string }>;
  markReadWithTyping(ch: WaChannel, messageId: string): Promise<void>;
  getMediaInfo(ch: WaChannel, mediaId: string): Promise<MediaInfo>;
  downloadMedia(ch: WaChannel, url: string, maxBytes: number): Promise<Buffer>;
  uploadMedia(ch: WaChannel, data: Buffer, mimeType: string, filename: string): Promise<{ id: string }>;
}

export const WA_TEXT_LIMIT = 4096;

/**
 * Cliente da WhatsApp Business Platform (Cloud API), conforme a documentação oficial:
 *  - POST /{phone-number-id}/messages (texto, áudio, leitura + indicador de digitação)
 *  - GET  /{media-id} -> url válida por 5 minutos; download exige Bearer token
 *  - POST /{phone-number-id}/media (multipart: file, type, messaging_product)
 */
export class GraphWhatsAppClient implements WhatsAppClient {
  constructor(
    private readonly baseUrl: string,
    private readonly version: string,
    private readonly timeoutMs = 10_000,
    private readonly fetchImpl?: FetchLike,
  ) {}

  private url(path: string) {
    return `${this.baseUrl}/${this.version}/${path}`;
  }

  private headers(ch: WaChannel, json = true): Record<string, string> {
    return { Authorization: `Bearer ${ch.accessToken}`, ...(json ? { 'Content-Type': 'application/json' } : {}) };
  }

  async sendText(ch: WaChannel, to: string, body: string) {
    if (body.length > WA_TEXT_LIMIT) throw new PermanentError('texto acima de 4096 caracteres', 'text_too_long');
    const res = await httpJson<{ messages: { id: string }[] }>(
      this.url(`${ch.phoneNumberId}/messages`),
      {
        method: 'POST',
        headers: this.headers(ch),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'text',
          text: { body, preview_url: false },
        }),
      },
      { service: 'whatsapp', timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl },
    );
    return { wamid: res.messages[0]!.id };
  }

  async sendAudio(ch: WaChannel, to: string, mediaId: string, voice: boolean) {
    const res = await httpJson<{ messages: { id: string }[] }>(
      this.url(`${ch.phoneNumberId}/messages`),
      {
        method: 'POST',
        headers: this.headers(ch),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to,
          type: 'audio',
          audio: { id: mediaId, voice },
        }),
      },
      { service: 'whatsapp', timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl },
    );
    return { wamid: res.messages[0]!.id };
  }

  async markReadWithTyping(ch: WaChannel, messageId: string) {
    await httpRequest(
      this.url(`${ch.phoneNumberId}/messages`),
      {
        method: 'POST',
        headers: this.headers(ch),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          status: 'read',
          message_id: messageId,
          typing_indicator: { type: 'text' },
        }),
      },
      { service: 'whatsapp', timeoutMs: 5_000, fetchImpl: this.fetchImpl },
    );
  }

  async getMediaInfo(ch: WaChannel, mediaId: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId)) throw new PermanentError('media id inválido', 'bad_media_id');
    const q = new URLSearchParams({ phone_number_id: ch.phoneNumberId });
    return httpJson<MediaInfo>(
      this.url(`${mediaId}?${q}`),
      { method: 'GET', headers: this.headers(ch, false) },
      { service: 'whatsapp', timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl },
    );
  }

  async downloadMedia(ch: WaChannel, url: string, maxBytes: number) {
    // Só baixamos de URLs https da própria Meta, nunca de um endereço arbitrário (proteção contra SSRF).
    const u = new URL(url);
    if (u.protocol !== 'https:' || !(u.hostname === 'lookaside.fbsbx.com' || u.hostname.endsWith('.fbcdn.net') || u.hostname.endsWith('.whatsapp.net') || u.hostname.endsWith('.facebook.com'))) {
      throw new PermanentError(`host de mídia não permitido: ${u.hostname}`, 'media_host_not_allowed');
    }
    const res = await httpRequest(url, { method: 'GET', headers: this.headers(ch, false), redirect: 'error' }, {
      service: 'whatsapp-media',
      timeoutMs: 20_000,
      fetchImpl: this.fetchImpl,
    });
    return readLimited(res, maxBytes);
  }

  async uploadMedia(ch: WaChannel, data: Buffer, mimeType: string, filename: string) {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimeType);
    form.append('file', new Blob([new Uint8Array(data)], { type: mimeType }), filename);
    return httpJson<{ id: string }>(
      this.url(`${ch.phoneNumberId}/media`),
      { method: 'POST', headers: this.headers(ch, false), body: form },
      { service: 'whatsapp', timeoutMs: 20_000, fetchImpl: this.fetchImpl },
    );
  }
}

/** Lê o corpo da resposta interrompendo assim que o limite de bytes for ultrapassado. */
export async function readLimited(res: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) throw new PermanentError(`mídia com ${declared} bytes excede o limite`, 'media_too_large');
  if (!res.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PermanentError('mídia excede o limite de bytes', 'media_too_large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export function isWindowClosedError(err: unknown): boolean {
  // Fora da janela de atendimento a Meta recusa mensagens livres; só templates aprovados passam.
  return err instanceof HttpError && err.status === 400 && /131047|re-engagement/i.test(err.bodySnippet);
}
