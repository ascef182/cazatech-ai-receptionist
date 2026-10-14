# 5. Processamento de áudio

Código: `src/audio/inbound.ts`, `src/audio/ffmpeg.ts`, `src/audio/stt.ts`, `src/audio/tts.ts`.

## Entrada (nota de voz → texto)

```mermaid
flowchart LR
  A[webhook audio<br/>id + mime_type] --> B{mime permitido?<br/>aac, amr, mpeg, mp4, ogg}
  B -- não --> F[falha: pedir texto]
  B -- sim --> C[GET /media-id<br/>url válida 5 min]
  C --> D{file_size ≤ limite?}
  D -- não --> F
  D -- sim --> E[download com Bearer<br/>só hosts da Meta<br/>corte ao exceder bytes]
  E --> G{sha256 confere?}
  G -- não --> F
  G -- sim --> H[ffprobe no conteúdo real<br/>trilha de áudio, contêiner, duração]
  H -- inválido / longo --> F
  H -- ok --> I[ffmpeg → MP3 mono 16 kHz]
  I --> J[OpenAI /v1/audio/transcriptions]
  J --> K[transcrição gravada<br/>áudio descartado]
```

Detalhes verificados na documentação:

- **Obtenção segura:** `GET /{media-id}?phone_number_id=…` devolve `url`, `mime_type`, `sha256`, `file_size`. A URL expira em 5 minutos e o download exige o mesmo token Bearer. O campo `url` dentro do webhook está em liberação gradual, por isso usamos o fluxo pelo id.
- **Formatos aceitos pela Meta:** `audio/aac`, `audio/amr`, `audio/mpeg`, `audio/mp4`, `audio/ogg` (só Opus, mono), até 16 MB.
- **STT:** a API de transcrição da OpenAI aceita `mp3, mp4, mpeg, mpga, m4a, wav, webm` e até 25 MB — **não inclui OGG**, que é o formato das notas de voz do WhatsApp. Por isso todo áudio é convertido para MP3 mono antes do envio (teste confirma o codec e os canais do arquivo enviado).
- **Validação pelo conteúdo, não pelo cabeçalho:** `ffprobe` confirma que há trilha de áudio, rejeita vídeo e mede a duração real.

Limites: `AUDIO_MAX_BYTES` (padrão 16 MB) e `tenant_settings.max_audio_seconds` (padrão 120 s). Os arquivos temporários ficam num diretório privado (`0600`) apagado em seguida — necessário porque MP4/M4A não pode ser lido por *pipe*.

### Falhas

| Falha | Resultado |
|---|---|
| Tipo não suportado, corrompido, longo demais, grande demais, hash diferente, transcrição vazia | Mensagem marcada `failed` com o motivo; o cliente recebe "Não consegui ouvir seu áudio. Você pode escrever?" |
| STT temporariamente fora (5xx/429/timeout) | Job repetido; na última tentativa, mesma resposta de contingência |
| STT desligado (`STT_PROVIDER=disabled`) | Pede para escrever |

## Saída opcional (texto → voz)

Só acontece quando **a empresa habilitou** (`voice_reply_enabled`), **o cliente mandou áudio** na mensagem mais recente e o texto tem até `TTS_MAX_CHARS` (600) caracteres.

```mermaid
flowchart LR
  T[resposta em texto] --> E[ElevenLabs<br/>POST /v1/text-to-speech/voice_id<br/>output_format=mp3_44100_64]
  E --> N[ffmpeg → OGG/Opus mono 48 kHz]
  N --> P{ffprobe: opus + mono?}
  P -- sim --> U[POST /phone-number-id/media]
  U --> S[envio type=audio, voice=true]
  P -- não --> X[fallback: texto]
  E -- erro --> X
  U -- erro --> X
```

A Meta exige OGG com codec Opus para mensagens de voz. A ElevenLabs oferece formatos `opus_48000_*`, mas a documentação não especifica o contêiner nem os canais desses formatos; por isso pedimos MP3 e **normalizamos com ffmpeg**, validando o resultado antes do upload. Qualquer falha na voz cai para texto — o cliente sempre recebe resposta.

Observação da documentação da Meta: o ícone de reprodução da nota de voz só aparece para arquivos até 512 KB; com 24 kbps, 600 caracteres ficam bem abaixo disso.
