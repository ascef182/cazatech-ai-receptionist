import { httpJson, type FetchLike } from '../lib/http.js';
import { toMp3ForStt } from './ffmpeg.js';

export interface Transcriber {
  transcribe(audio: Buffer, opts: { maxSeconds: number }): Promise<string>;
}

/**
 * OpenAI POST /v1/audio/transcriptions (limite de 25 MB).
 * Os formatos aceitos não incluem OGG, que é o formato das notas de voz do WhatsApp,
 * por isso todo áudio é convertido para MP3 mono antes do envio.
 */
export class OpenAiTranscriber implements Transcriber {
  constructor(
    private readonly apiKey: string,
    private readonly model: string,
    private readonly baseUrl = 'https://api.openai.com',
    private readonly fetchImpl?: FetchLike,
  ) {}

  async transcribe(audio: Buffer, opts: { maxSeconds: number }) {
    const mp3 = await toMp3ForStt(audio, opts.maxSeconds);
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(mp3)], { type: 'audio/mpeg' }), 'audio.mp3');
    form.append('model', this.model);
    form.append('language', 'pt');
    form.append('response_format', 'json');
    const res = await httpJson<{ text: string }>(
      `${this.baseUrl}/v1/audio/transcriptions`,
      { method: 'POST', headers: { Authorization: `Bearer ${this.apiKey}` }, body: form },
      { service: 'openai-stt', timeoutMs: 45_000, fetchImpl: this.fetchImpl },
    );
    return res.text ?? '';
  }
}

export class FakeTranscriber implements Transcriber {
  calls = 0;
  constructor(public next: string | Error = 'texto transcrito') {}
  async transcribe() {
    this.calls++;
    if (this.next instanceof Error) throw this.next;
    return this.next;
  }
}
