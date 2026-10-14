# Referências consultadas (13/10/2026)

## Meta — WhatsApp Business Platform
- Webhooks overview (reentregas por até 7 dias, duplicatas, payload até 3 MB): https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
- Create a webhook endpoint (`hub.mode`, `hub.verify_token`, `hub.challenge`; `X-Hub-Signature-256`): https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
- Messages webhook reference: https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages
- Audio messages webhook (`id`, `mime_type`, `sha256`, `voice`, `url` em rollout): https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/audio
- Media (GET /{media-id}, URL expira em 5 min, formatos e limites de áudio, upload): https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
- Text messages (limite de 4096 caracteres): https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/text-messages
- Audio messages (envio, `voice: true`, OGG/Opus, ícone de play até 512 KB; exemplos em v25.0): https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/audio-messages
- Typing indicators (leitura + digitação, até 25 s): https://developers.facebook.com/documentation/business-messaging/whatsapp/typing-indicators
- About the WhatsApp Business Platform (templates, opt-in, janela de atendimento): https://developers.facebook.com/documentation/business-messaging/whatsapp/about-the-platform

## Google Calendar API v3
- Events: insert (escopos aceitos; regras do `id` base32hex 5–1024): https://developers.google.com/workspace/calendar/api/v3/reference/events/insert
- Freebusy: query (escopos aceitos; corpo e resposta): https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query

## Anthropic — Claude API
- Define tools (`name`, `description`, `input_schema`, `tool_choice`, `strict`): https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
- Handle tool calls (`tool_result`, ordem dos blocos, `stop_reason: tool_use`): https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls
- Models overview (IDs e preços): https://platform.claude.com/docs/en/models/overview

## OpenAI
- Speech to text (endpoint, modelos, 25 MB, formatos aceitos): https://developers.openai.com/api/docs/guides/speech-to-text

## ElevenLabs
- Create speech (`POST /v1/text-to-speech/:voice_id`, `xi-api-key`, `output_format`): https://elevenlabs.io/docs/api-reference/text-to-speech/convert

## BullMQ
- Deduplication (simple, throttle, debounce, keepLastIfActive): https://docs.bullmq.io/guide/jobs/deduplication
- Migrate from v5 to v6: https://docs.bullmq.io/guide/migrations/migrate-from-v5-to-v6

## LGPD
- Lei nº 13.709/2018: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm
- ANPD — Guia de segurança para agentes de tratamento de pequeno porte: https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-sobre-seguranca-da-informacao-para-agentes-de-tratamento-de-pequeno-porte
