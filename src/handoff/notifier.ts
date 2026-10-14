import { hmacHex } from '../lib/crypto.js';
import { httpRequest, type FetchLike } from '../lib/http.js';

export interface HandoffEvent {
  tenantId: string;
  conversationId: string;
  reason: string;
  note?: string;
  customerName?: string | null;
  at: string;
}

export interface HandoffNotifier {
  notify(url: string | null, ev: HandoffEvent): Promise<void>;
}

/**
 * Avisa a equipe por um webhook configurado pela empresa (por exemplo, um fluxo do n8n
 * que repassa para Telegram, e-mail ou WhatsApp pessoal). O corpo é assinado com HMAC-SHA256
 * no cabeçalho X-AIR-Signature para o receptor validar a origem.
 * Não inclui conteúdo da conversa nem telefone do cliente: só o necessário para alguém abrir o painel.
 */
export class WebhookHandoffNotifier implements HandoffNotifier {
  constructor(private readonly signingSecret: string, private readonly fetchImpl?: FetchLike) {}

  async notify(url: string | null, ev: HandoffEvent) {
    if (!url) return;
    const u = new URL(url);
    if (u.protocol !== 'https:') throw new Error('webhook de handoff precisa ser https');
    const body = JSON.stringify({ type: 'conversation.handoff', ...ev });
    await httpRequest(
      url,
      { method: 'POST', headers: { 'content-type': 'application/json', 'x-air-signature': 'sha256=' + hmacHex(body, this.signingSecret) }, body },
      { service: 'handoff-webhook', timeoutMs: 5_000, fetchImpl: this.fetchImpl },
    );
  }
}

export class RecordingNotifier implements HandoffNotifier {
  events: HandoffEvent[] = [];
  async notify(_url: string | null, ev: HandoffEvent) {
    this.events.push(ev);
  }
}
