# 10. Plano de implementação

Legenda: ✅ feito e testado · 🟡 feito, mas sem validação real (depende de credencial) · ⬜ pendente

## Etapa 1 — Fundação, webhook e fila ✅

| # | Tarefa | Arquivos | Depende de | Testes | Concluída quando | Status |
|---|---|---|---|---|---|---|
| 1.1 | Projeto TS, config validada, logger com redação | `package.json`, `tsconfig*.json`, `src/config.ts`, `src/lib/logger.ts` | — | `security.test.ts` (config) | `npm run typecheck` limpo; config inválida falha com mensagem clara | ✅ |
| 1.2 | Schema e migração | `migrations/001_init.sql`, `src/db/*` | 1.1 | todos os de integração | migração aplica do zero; constraints exercitadas | ✅ |
| 1.3 | Verificação GET e assinatura HMAC | `src/http/app.ts`, `src/lib/crypto.ts` | 1.1 | `webhook.test.ts`, `security.test.ts` | 401 para assinatura inválida; challenge devolvido | ✅ |
| 1.4 | Ingestão transacional + deduplicação | `src/whatsapp/ingest.ts`, `webhook-schema.ts` | 1.2 | `webhook.test.ts` | reentrega não duplica; status monotônico | ✅ |
| 1.5 | Fila com debounce | `src/queue/conversation-queue.ts` | 1.4 | `queue.test.ts`, e2e | 3 adds → 1 job | ✅ |
| 1.6 | Outbox + reconciliador | `src/queue/reconciler.ts` | 1.5 | `queue.test.ts`, e2e | Redis fora não perde mensagem | ✅ |

## Etapa 2 — Agente, agenda e handoff ✅ (🟡 integrações reais)

| # | Tarefa | Arquivos | Depende de | Testes | Concluída quando | Status |
|---|---|---|---|---|---|---|
| 2.1 | Processor com lease e rodadas | `src/worker/processor.ts`, `run-worker.ts` | 1.x | `processor.test.ts` | 2 workers → 1 processa; repetição idempotente | ✅ |
| 2.2 | Cliente LLM + laço com limites | `src/ai/llm.ts`, `agent.ts` | — | `agent.test.ts` | limites de iteração/tempo/custo testados | ✅ / 🟡 API real |
| 2.3 | Contratos das ferramentas | `src/ai/tools.ts` | 2.2 | `agent.test.ts` | args inválidos → erro de ferramenta | ✅ |
| 2.4 | Prompt e guardrails | `src/ai/prompt.ts`, `guardrails.ts` | 2.2 | `security.test.ts` | sanitização e atalho de atendente | ✅ |
| 2.5 | Disponibilidade e fuso | `src/calendar/availability.ts`, `time.ts` | — | `calendar.test.ts` | horários corretos em UTC-3 e com horário de verão | ✅ |
| 2.6 | BookingService (proposta → confirmação → evento) | `src/calendar/booking-service.ts` | 2.5, 1.2 | `processor.test.ts` | sem duplo agendamento; sucesso só com API | ✅ |
| 2.7 | Adaptador Google Calendar | `src/calendar/google.ts` | 2.6 | `calendar.test.ts` (fetch simulado) | formato conforme referência | 🟡 |
| 2.8 | Handoff, notificação, ações humanas, admin | `src/handoff/*`, `src/http/app.ts` | 2.1 | `processor.test.ts`, `webhook.test.ts` | IA para após handoff; isolamento por chave | ✅ |
| 2.9 | Retenção e exclusão LGPD | `src/worker/retention.ts`, `human-actions.ts` | 1.2 | `processor.test.ts` | conteúdo apagado; auditoria imutável | ✅ |

## Etapa 3 — Áudio ✅ (🟡 integrações reais)

| # | Tarefa | Arquivos | Depende de | Testes | Concluída quando | Status |
|---|---|---|---|---|---|---|
| 3.1 | Download seguro e validação com ffprobe | `src/audio/inbound.ts`, `ffmpeg.ts`, `src/whatsapp/client.ts` | 2.1 | `audio.test.ts`, `whatsapp-client.test.ts` | inválidos recusados com resposta ao cliente | ✅ |
| 3.2 | STT OpenAI com conversão para MP3 | `src/audio/stt.ts` | 3.1 | `audio.test.ts` | arquivo enviado é MP3 mono | ✅ / 🟡 API real |
| 3.3 | TTS ElevenLabs + normalização OGG/Opus + fallback | `src/audio/tts.ts`, `processor.ts` | 3.1 | `audio.test.ts` | voz enviada; falha cai para texto | ✅ / 🟡 API real |

## Etapa 4 — Validação real com o piloto ⬜ (próxima)

| # | Tarefa | Arquivos | Depende de | Teste / verificação | Concluída quando |
|---|---|---|---|---|---|
| 4.1 | Criar app na Meta, número de teste, token de sistema; publicar a API com HTTPS | infra | — | `GET` de verificação aceito no painel da Meta | webhook "verificado" no painel |
| 4.2 | Seed da empresa piloto | `scripts/seed-demo.ts` | 4.1 | `npm run seed:demo` | empresa criada; chave admin em mãos |
| 4.3 | Teste manual de texto ponta a ponta com LLM real | — | 4.2 | roteiro: preço, endereço, atendente | 10 conversas sem erro em `agent_runs` |
| 4.4 | Conta de serviço Google + agenda compartilhada | `calendar_connections` | 4.2 | agendar, remarcar, cancelar pelo WhatsApp | evento aparece/some no Google Calendar |
| 4.5 | Áudio real (nota de voz do WhatsApp) | — | 4.1 | enviar 5 áudios de 5–60 s | transcrições corretas; `voice: true` |
| 4.6 | Voz opcional com ElevenLabs | env | 4.5 | habilitar `voice_reply_enabled` | nota de voz toca no WhatsApp com ícone de play |
| 4.7 | Conjunto de avaliação do agente | `test/eval/*` (novo) | 4.3 | 30–50 conversas anonimizadas com resultado esperado (resposta, ferramenta, handoff) | taxa de acerto medida antes de cada mudança de prompt/modelo |
| 4.8 | Ajustar preço por token do modelo escolhido | `.env` | — | conferir página de preços | custo em `agent_runs` bate com a fatura |

## Etapa 5 — Operação mínima ⬜

| # | Tarefa | Notas |
|---|---|---|
| 5.1 | Build e publicação da imagem Docker | `Dockerfile` pronto, não executado aqui |
| 5.2 | Observabilidade | métricas (jobs, latência, custo por empresa), alertas para `failed` e handoffs; Sentry ou OpenTelemetry |
| 5.3 | Painel mínimo para a equipe | lista de conversas em `human`, responder, devolver ao bot (consumindo `/admin/*`) |
| 5.4 | Rotação de chave de cifragem | script de recifragem |
| 5.5 | OAuth Google para quem não usa Workspace | tela de consentimento + refresh token cifrado |
| 5.6 | Templates para mensagens fora da janela de 24 h (lembretes) | exige templates aprovados na Meta |
| 5.7 | Provider Bladiq | implementar `CalendarProvider` contra a API do Bladiq |

Só depois de a etapa 4 provar demanda e qualidade: cadastro self-service, cobrança, RLS, painel completo.
