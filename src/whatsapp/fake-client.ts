import { randomUUID } from 'node:crypto';
import type { MediaInfo, WaChannel, WhatsAppClient } from './client.js';
import { PermanentError, RetryableError } from '../lib/errors.js';

export interface SentRecord {
  kind: 'text' | 'audio' | 'read';
  to?: string;
  body?: string;
  mediaId?: string;
  messageId?: string;
  phoneNumberId: string;
}

/** Cliente em memória para testes: registra envios e simula mídia e falhas. */
export class FakeWhatsAppClient implements WhatsAppClient {
  sent: SentRecord[] = [];
  media = new Map<string, { data: Buffer; mime: string }>();
  uploads: { data: Buffer; mime: string }[] = [];
  failNextSends = 0;
  failMode: 'retryable' | 'permanent' = 'retryable';

  private maybeFail() {
    if (this.failNextSends > 0) {
      this.failNextSends--;
      if (this.failMode === 'retryable') throw new RetryableError('falha simulada do WhatsApp');
      throw new PermanentError('falha permanente simulada');
    }
  }

  async sendText(ch: WaChannel, to: string, body: string) {
    this.maybeFail();
    this.sent.push({ kind: 'text', to, body, phoneNumberId: ch.phoneNumberId });
    return { wamid: `wamid.fake.${randomUUID()}` };
  }
  async sendAudio(ch: WaChannel, to: string, mediaId: string) {
    this.maybeFail();
    this.sent.push({ kind: 'audio', to, mediaId, phoneNumberId: ch.phoneNumberId });
    return { wamid: `wamid.fake.${randomUUID()}` };
  }
  async markReadWithTyping(ch: WaChannel, messageId: string) {
    this.sent.push({ kind: 'read', messageId, phoneNumberId: ch.phoneNumberId });
  }
  async getMediaInfo(_ch: WaChannel, mediaId: string): Promise<MediaInfo> {
    const m = this.media.get(mediaId);
    if (!m) throw new PermanentError('mídia não encontrada', 'media_not_found');
    return { url: `https://lookaside.fbsbx.com/fake/${mediaId}`, mime_type: m.mime, file_size: m.data.length };
  }
  async downloadMedia(_ch: WaChannel, url: string, maxBytes: number) {
    const id = url.split('/').pop()!;
    const m = this.media.get(id);
    if (!m) throw new PermanentError('mídia não encontrada', 'media_not_found');
    if (m.data.length > maxBytes) throw new PermanentError('mídia excede o limite de bytes', 'media_too_large');
    return m.data;
  }
  async uploadMedia(_ch: WaChannel, data: Buffer, mime: string) {
    this.uploads.push({ data, mime });
    return { id: `media-${this.uploads.length}` };
  }
  texts(to?: string) {
    return this.sent.filter((s) => s.kind === 'text' && (!to || s.to === to)).map((s) => s.body!);
  }
}
