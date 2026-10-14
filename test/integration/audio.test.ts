import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../../src/db/pool.js';
import { ingestWebhook } from '../../src/whatsapp/ingest.js';
import { processConversation } from '../../src/worker/processor.js';
import { llmText, ScriptedLlm } from '../../src/ai/llm.js';
import { FakeTranscriber, OpenAiTranscriber } from '../../src/audio/stt.js';
import { ElevenLabsSynthesizer, FakeSynthesizer } from '../../src/audio/tts.js';
import { probeAudio } from '../../src/audio/ffmpeg.js';
import { RetryableError } from '../../src/lib/errors.js';
import { audioEvent, freshDb, makeAudio, makeProcessorDeps, seedTenant, signed, truncateAll, type SeededTenant } from '../helpers/setup.js';

let db: Db;
let ogg: Buffer;
let mp3: Buffer;
let m4a: Buffer;
beforeAll(async () => {
  db = await freshDb();
  ogg = makeAudio(3, 'ogg');
  mp3 = makeAudio(2, 'mp3');
  m4a = makeAudio(2, 'm4a');
});
afterAll(async () => {
  await db.end();
});
beforeEach(async () => {
  await truncateAll(db);
});

const CUSTOMER = '5511988887777';
async function sendAudio(t: SeededTenant, mediaId: string, mime?: string) {
  const r = await ingestWebhook(db, signed(audioEvent(t.phoneNumberId, CUSTOMER, mediaId, mime)).raw, { storePayload: false });
  return r.toProcess[0]!;
}

describe('áudio recebido', () => {
  it('nota de voz OGG/Opus válida é transcrita e respondida pelo agente', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    ctx.wa.media.set('m1', { data: ogg, mime: 'audio/ogg' });
    (ctx.stt as FakeTranscriber).next = 'quanto custa o corte feminino?';
    (ctx.llm as ScriptedLlm).push(llmText('O corte feminino custa R$ 90.'));
    const job = await sendAudio(t, 'm1');
    await processConversation(ctx.deps, job);
    const m = (await db.query(`SELECT transcript, status FROM messages WHERE direction='in'`)).rows[0];
    expect(m).toEqual({ transcript: 'quanto custa o corte feminino?', status: 'processed' });
    const userTurn = (ctx.llm as ScriptedLlm).calls[0]!.messages[0]!.content as string;
    expect(userTurn).toContain('[áudio transcrito] quanto custa o corte feminino?');
    expect(ctx.wa.texts()[0]).toContain('R$ 90');
  });

  it('M4A (AAC em MP4) também é aceito', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    ctx.wa.media.set('m2', { data: m4a, mime: 'audio/mp4' });
    (ctx.llm as ScriptedLlm).push(llmText('ok'));
    await processConversation(ctx.deps, await sendAudio(t, 'm2', 'audio/mp4'));
    expect((ctx.stt as FakeTranscriber).calls).toBe(1);
  });

  it('arquivo corrompido: não chama STT nem modelo e pede para escrever', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    ctx.wa.media.set('bad', { data: Buffer.from('isto não é um áudio'.repeat(50)), mime: 'audio/ogg' });
    await processConversation(ctx.deps, await sendAudio(t, 'bad'));
    expect((ctx.stt as FakeTranscriber).calls).toBe(0);
    expect((ctx.llm as ScriptedLlm).calls).toHaveLength(0);
    expect(ctx.wa.texts()[0]).toMatch(/escrever/);
    expect((await db.query(`SELECT status, error FROM messages WHERE direction='in'`)).rows[0].status).toBe('failed');
  });

  it('áudio acima da duração máxima é recusado', async () => {
    const t = await seedTenant(db);
    await db.query(`UPDATE tenant_settings SET max_audio_seconds = 5`);
    const ctx = makeProcessorDeps(db);
    ctx.wa.media.set('long', { data: makeAudio(8, 'ogg'), mime: 'audio/ogg' });
    await processConversation(ctx.deps, await sendAudio(t, 'long'));
    expect((ctx.stt as FakeTranscriber).calls).toBe(0);
    expect((await db.query(`SELECT error FROM messages WHERE direction='in'`)).rows[0].error).toMatch(/excede o limite/);
  });

  it('áudio acima do limite de bytes é recusado sem baixar tudo', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    ctx.deps.config = { ...ctx.deps.config, AUDIO_MAX_BYTES: 1000 };
    ctx.wa.media.set('big', { data: ogg, mime: 'audio/ogg' });
    await processConversation(ctx.deps, await sendAudio(t, 'big'));
    expect((await db.query(`SELECT error FROM messages WHERE direction='in'`)).rows[0].error).toMatch(/limite/);
  });

  it('tipo de mídia não suportado é recusado antes do download', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    await processConversation(ctx.deps, await sendAudio(t, 'x', 'audio/wav'));
    expect((await db.query(`SELECT error FROM messages WHERE direction='in'`)).rows[0].error).toMatch(/não suportado/);
  });

  it('falha temporária do STT: job é repetido; na repetição o áudio é transcrito', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db);
    ctx.wa.media.set('m1', { data: ogg, mime: 'audio/ogg' });
    (ctx.stt as FakeTranscriber).next = new RetryableError('STT 503');
    const job = await sendAudio(t, 'm1');
    await expect(processConversation(ctx.deps, job)).rejects.toThrow(/STT/);
    (ctx.stt as FakeTranscriber).next = 'oi';
    (ctx.llm as ScriptedLlm).push(llmText('Olá!'));
    await processConversation(ctx.deps, job);
    expect(ctx.wa.texts()).toHaveLength(1);
  });

  it('STT desativado: responde pedindo texto', async () => {
    const t = await seedTenant(db);
    const ctx = makeProcessorDeps(db, { stt: null });
    ctx.wa.media.set('m1', { data: ogg, mime: 'audio/ogg' });
    await processConversation(ctx.deps, await sendAudio(t, 'm1'));
    expect(ctx.wa.texts()[0]).toMatch(/escrever/);
  });
});

describe('resposta em voz (opcional)', () => {
  it('com voz habilitada e mensagem de áudio, envia nota de voz', async () => {
    const t = await seedTenant(db, { voice: true });
    const ctx = makeProcessorDeps(db, { tts: new FakeSynthesizer(null, ogg) });
    ctx.wa.media.set('m1', { data: ogg, mime: 'audio/ogg' });
    (ctx.llm as ScriptedLlm).push(llmText('O corte custa R$ 90.'));
    await processConversation(ctx.deps, await sendAudio(t, 'm1'));
    expect(ctx.wa.sent.filter((s) => s.kind === 'audio')).toHaveLength(1);
    expect(ctx.wa.uploads[0]!.mime).toBe('audio/ogg');
    expect((await db.query(`SELECT kind, status FROM messages WHERE direction='out'`)).rows[0]).toEqual({ kind: 'audio', status: 'sent' });
  });

  it('falha na síntese: cai para texto', async () => {
    const t = await seedTenant(db, { voice: true });
    const ctx = makeProcessorDeps(db, { tts: new FakeSynthesizer(new Error('TTS fora')) });
    ctx.wa.media.set('m1', { data: ogg, mime: 'audio/ogg' });
    (ctx.llm as ScriptedLlm).push(llmText('O corte custa R$ 90.'));
    await processConversation(ctx.deps, await sendAudio(t, 'm1'));
    expect(ctx.wa.sent.filter((s) => s.kind === 'audio')).toHaveLength(0);
    expect(ctx.wa.texts()).toHaveLength(1);
    expect((await db.query(`SELECT kind FROM messages WHERE direction='out'`)).rows[0].kind).toBe('text');
  });
});

describe('adaptadores de áudio (fetch simulado, ffmpeg real)', () => {
  it('OpenAI STT recebe MP3 mono convertido a partir do OGG do WhatsApp', async () => {
    let form: FormData | null = null;
    let url = '';
    const fetchImpl = (async (u: string, init: RequestInit) => {
      url = u;
      form = init.body as FormData;
      return new Response(JSON.stringify({ text: 'olá' }));
    }) as any;
    const stt = new OpenAiTranscriber('sk-test', 'gpt-4o-mini-transcribe', 'https://api.openai.com', fetchImpl);
    expect(await stt.transcribe(ogg, { maxSeconds: 60 })).toBe('olá');
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    const file = form!.get('file') as File;
    expect(file.type).toBe('audio/mpeg');
    expect(form!.get('model')).toBe('gpt-4o-mini-transcribe');
    const probe = await probeAudio(Buffer.from(await file.arrayBuffer()));
    expect(probe.codec).toBe('mp3');
    expect(probe.channels).toBe(1);
  });

  it('ElevenLabs: pede MP3 e entrega OGG/Opus mono para o WhatsApp', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (u: string, init: RequestInit) => {
      captured = { url: u, init };
      return new Response(new Uint8Array(mp3), { headers: { 'content-type': 'audio/mpeg' } });
    }) as any;
    const tts = new ElevenLabsSynthesizer('xi-key', 'voice123', 'eleven_multilingual_v2', 'https://api.elevenlabs.io', fetchImpl);
    const out = await tts.synthesize('Olá, tudo bem?');
    expect(captured!.url).toBe('https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_64');
    expect((captured!.init.headers as any)['xi-api-key']).toBe('xi-key');
    const p = await probeAudio(out);
    expect(p.codec).toBe('opus');
    expect(p.channels).toBe(1);
    expect(p.formatName).toContain('ogg');
  });
});
