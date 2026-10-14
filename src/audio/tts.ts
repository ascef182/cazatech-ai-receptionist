import { httpRequest, type FetchLike } from '../lib/http.js';
import { PermanentError } from '../lib/errors.js';
import { probeAudio, toOggOpusVoice } from './ffmpeg.js';

export interface Synthesizer {
  /** Devolve OGG/Opus mono pronto para envio como mensagem de voz. */
  synthesize(text: string): Promise<Buffer>;
}

/**
 * ElevenLabs POST /v1/text-to-speech/{voice_id} (cabeçalho xi-api-key).
 * Pedimos MP3 e normalizamos com ffmpeg para OGG/Opus mono, que é o que o WhatsApp exige para voz.
 */
export class ElevenLabsSynthesizer implements Synthesizer {
  constructor(
    private readonly apiKey: string,
    private readonly voiceId: string,
    private readonly modelId: string,
    private readonly baseUrl = 'https://api.elevenlabs.io',
    private readonly fetchImpl?: FetchLike,
  ) {}

  async synthesize(text: string) {
    const q = new URLSearchParams({ output_format: 'mp3_44100_64' });
    const res = await httpRequest(
      `${this.baseUrl}/v1/text-to-speech/${encodeURIComponent(this.voiceId)}?${q}`,
      {
        method: 'POST',
        headers: { 'xi-api-key': this.apiKey, 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({ text, model_id: this.modelId }),
      },
      { service: 'elevenlabs', timeoutMs: 30_000, fetchImpl: this.fetchImpl },
    );
    const mp3 = Buffer.from(await res.arrayBuffer());
    return normalizeVoice(mp3);
  }
}

export async function normalizeVoice(input: Buffer): Promise<Buffer> {
  const ogg = await toOggOpusVoice(input);
  const p = await probeAudio(ogg);
  if (p.codec !== 'opus' || p.channels !== 1) throw new PermanentError('áudio sintetizado fora do formato de voz', 'bad_tts_format');
  return ogg;
}

export class FakeSynthesizer implements Synthesizer {
  calls = 0;
  constructor(public fail: Error | null = null, private readonly sample?: Buffer) {}
  async synthesize() {
    this.calls++;
    if (this.fail) throw this.fail;
    return this.sample ?? Buffer.from('OggS-fake');
  }
}
