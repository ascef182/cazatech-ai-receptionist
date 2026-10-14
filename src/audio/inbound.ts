import { PermanentError } from '../lib/errors.js';
import { sha256Hex } from '../lib/crypto.js';
import type { WaChannel, WhatsAppClient } from '../whatsapp/client.js';
import { probeAudio } from './ffmpeg.js';
import type { Transcriber } from './stt.js';

// Tipos de áudio aceitos pela WhatsApp Business Platform (documentação de mídia).
export const ALLOWED_AUDIO_MIME = ['audio/aac', 'audio/amr', 'audio/mpeg', 'audio/mp4', 'audio/ogg'];
const ALLOWED_CONTAINERS = ['ogg', 'mp3', 'aac', 'amr', 'mov,mp4,m4a,3gp,3g2,mj2', 'adts'];

export function baseMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0]!.trim().toLowerCase();
}

export interface AudioLimits {
  maxBytes: number;
  maxSeconds: number;
}

/**
 * Obtém e valida o áudio recebido e devolve a transcrição.
 * O arquivo só existe em memória durante o processamento; nada é gravado em disco ou no banco.
 */
export async function transcribeInboundAudio(
  wa: WhatsAppClient,
  ch: WaChannel,
  media: { mediaId: string; mime: string | null },
  stt: Transcriber,
  limits: AudioLimits,
): Promise<{ text: string; durationSec: number }> {
  if (!ALLOWED_AUDIO_MIME.includes(baseMime(media.mime))) throw new PermanentError(`tipo de áudio não suportado: ${media.mime}`, 'unsupported_mime');

  const info = await wa.getMediaInfo(ch, media.mediaId); // URL válida por 5 minutos
  if (info.file_size && info.file_size > limits.maxBytes) throw new PermanentError('áudio acima do limite de tamanho', 'media_too_large');
  const data = await wa.downloadMedia(ch, info.url, limits.maxBytes);
  if (data.length === 0) throw new PermanentError('áudio vazio', 'empty_media');
  if (info.sha256 && /^[0-9a-f]{64}$/i.test(info.sha256) && sha256Hex(data) !== info.sha256.toLowerCase())
    throw new PermanentError('hash da mídia não confere', 'media_hash_mismatch');

  const probe = await probeAudio(data);
  if (!ALLOWED_CONTAINERS.some((c) => probe.formatName.includes(c.split(',')[0]!))) throw new PermanentError(`contêiner inesperado: ${probe.formatName}`, 'bad_container');
  if (!Number.isFinite(probe.durationSec) || probe.durationSec <= 0.3) throw new PermanentError('áudio sem duração válida', 'bad_duration');
  if (probe.durationSec > limits.maxSeconds) throw new PermanentError(`áudio com ${Math.round(probe.durationSec)}s excede o limite`, 'audio_too_long');

  const text = (await stt.transcribe(data, { maxSeconds: limits.maxSeconds })).trim();
  if (!text) throw new PermanentError('transcrição vazia', 'empty_transcript');
  return { text, durationSec: probe.durationSec };
}
