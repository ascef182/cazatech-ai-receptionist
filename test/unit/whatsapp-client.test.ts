import { describe, expect, it } from 'vitest';
import { GraphWhatsAppClient } from '../../src/whatsapp/client.js';

function recorder(response: unknown = { messages: [{ id: 'wamid.1' }] }) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(response));
  }) as any;
  return { calls, fetchImpl };
}

const ch = { phoneNumberId: '1065', accessToken: 'tok' };

describe('cliente da WhatsApp Cloud API', () => {
  it('envia texto no formato documentado', async () => {
    const r = recorder();
    const c = new GraphWhatsAppClient('https://graph.facebook.com', 'v25.0', 1000, r.fetchImpl);
    const out = await c.sendText(ch, '5511988887777', 'Olá');
    expect(out.wamid).toBe('wamid.1');
    expect(r.calls[0]!.url).toBe('https://graph.facebook.com/v25.0/1065/messages');
    expect((r.calls[0]!.init.headers as any).Authorization).toBe('Bearer tok');
    expect(JSON.parse(r.calls[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '5511988887777',
      type: 'text',
      text: { body: 'Olá', preview_url: false },
    });
  });

  it('recusa texto acima de 4096 caracteres', async () => {
    const c = new GraphWhatsAppClient('https://graph.facebook.com', 'v25.0', 1000, recorder().fetchImpl);
    await expect(c.sendText(ch, '55', 'x'.repeat(4097))).rejects.toThrow(/4096/);
  });

  it('nota de voz usa audio.id e voice=true', async () => {
    const r = recorder();
    const c = new GraphWhatsAppClient('https://graph.facebook.com', 'v25.0', 1000, r.fetchImpl);
    await c.sendAudio(ch, '55', 'media-9', true);
    expect(JSON.parse(r.calls[0]!.init.body as string).audio).toEqual({ id: 'media-9', voice: true });
  });

  it('marca como lida com indicador de digitação', async () => {
    const r = recorder({ success: true });
    const c = new GraphWhatsAppClient('https://graph.facebook.com', 'v25.0', 1000, r.fetchImpl);
    await c.markReadWithTyping(ch, 'wamid.in');
    expect(JSON.parse(r.calls[0]!.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: 'wamid.in',
      typing_indicator: { type: 'text' },
    });
  });

  it('consulta de mídia restringe ao phone_number_id e valida o id', async () => {
    const r = recorder({ url: 'https://lookaside.fbsbx.com/x', mime_type: 'audio/ogg' });
    const c = new GraphWhatsAppClient('https://graph.facebook.com', 'v25.0', 1000, r.fetchImpl);
    await c.getMediaInfo(ch, '123456');
    expect(r.calls[0]!.url).toBe('https://graph.facebook.com/v25.0/123456?phone_number_id=1065');
    await expect(c.getMediaInfo(ch, '../../me')).rejects.toThrow(/inválido/);
  });

  it('download de mídia só aceita hosts da Meta (proteção contra SSRF)', async () => {
    const c = new GraphWhatsAppClient('https://graph.facebook.com', 'v25.0', 1000, recorder().fetchImpl);
    await expect(c.downloadMedia(ch, 'http://169.254.169.254/latest/meta-data', 1000)).rejects.toThrow(/não permitido/);
    await expect(c.downloadMedia(ch, 'https://evil.example.com/a.ogg', 1000)).rejects.toThrow(/não permitido/);
  });
});
