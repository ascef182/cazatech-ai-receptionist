import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PermanentError } from '../lib/errors.js';

// Entrada vai para um arquivo temporário privado (0600) porque MP4/M4A não é legível por pipe
// (o índice "moov" pode estar no fim do arquivo). O diretório é apagado logo em seguida.
async function withInputFile<T>(data: Buffer, fn: (file: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'air-audio-'));
  const file = path.join(dir, 'input');
  try {
    await writeFile(file, data, { mode: 0o600 });
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function run(cmd: string, args: string[], input: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const timer = setTimeout(() => {
      p.kill('SIGKILL');
      reject(new PermanentError(`${cmd}: tempo esgotado`, 'audio_timeout'));
    }, timeoutMs);
    p.stdout.on('data', (d) => out.push(d));
    p.stderr.on('data', (d) => (err += d.toString().slice(0, 2000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(new PermanentError(`${cmd} falhou (código ${code}): ${err.split('\n').slice(-3).join(' ')}`, 'audio_decode'));
    });
    p.stdin.on('error', () => undefined); // processo pode encerrar antes de ler tudo
    p.stdin.end(input);
  });
}

export interface ProbeResult {
  formatName: string;
  durationSec: number;
  codec: string;
  channels: number;
}

/** Lê o conteúdo real do arquivo (não confia no mime-type declarado). */
export async function probeAudio(data: Buffer): Promise<ProbeResult> {
  const out = await withInputFile(data, (f) =>
    run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', f], Buffer.alloc(0), 10_000),
  );
  const j = JSON.parse(out.toString('utf8'));
  const audio = (j.streams ?? []).find((s: any) => s.codec_type === 'audio');
  if (!audio) throw new PermanentError('arquivo sem trilha de áudio', 'no_audio_stream');
  if ((j.streams ?? []).some((s: any) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1))
    throw new PermanentError('arquivo contém vídeo', 'unexpected_video');
  const duration = Number(j.format?.duration ?? audio.duration);
  return {
    formatName: String(j.format?.format_name ?? ''),
    durationSec: Number.isFinite(duration) ? duration : NaN,
    codec: String(audio.codec_name ?? ''),
    channels: Number(audio.channels ?? 0),
  };
}

/** Converte qualquer entrada suportada para MP3 mono 16 kHz (formato aceito pelo STT). */
export function toMp3ForStt(data: Buffer, maxSeconds: number): Promise<Buffer> {
  return withInputFile(data, (f) =>
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-t', String(maxSeconds), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', 'pipe:1'], Buffer.alloc(0), 30_000),
  );
}

/** Converte para OGG/Opus mono, formato exigido pelo WhatsApp para mensagens de voz. */
export function toOggOpusVoice(data: Buffer): Promise<Buffer> {
  return withInputFile(data, (f) =>
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', f, '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'libopus', '-b:a', '24k', '-application', 'voip', '-f', 'ogg', 'pipe:1'], Buffer.alloc(0), 30_000),
  );
}
