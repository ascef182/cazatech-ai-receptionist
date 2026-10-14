# 11. Auditoria e validação (Fases 1–2)

Relatório da auditoria técnica realizada antes de qualquer integração com provedores reais, seguido do que foi corrigido e validado localmente. Este documento é sobre o **processo de validação**; o inventário "implementado vs. validado" continua em [`STATUS.md`](../STATUS.md).

## Método

Leitura completa do código de webhook/HTTP, fila/reconciliador, agente de IA, calendário e áudio, cruzando com `docs/01` a `docs/10`. Nenhuma chamada foi feita a um provedor externo real nesta fase — tudo foi verificado por leitura de código e, quando aplicável, por teste automatizado com dublês (`ScriptedLlm`, `FakeCalendarProvider`, `fetch` simulado).

## Achados

| # | Problema | Evidência | Impacto | Correção | Prioridade | Dependência externa |
|---|---|---|---|---|---|---|
| 1 | Classificação de erro da Meta dependia só do status HTTP + uma regex sobre um trecho truncado (300 caracteres) do corpo, para reconhecer o código `131047` (janela de 24h fechada) | `src/whatsapp/client.ts` (`isWindowClosedError`, antes da correção) | Qualquer mudança no formato da mensagem de erro da Meta quebra silenciosamente a detecção; nenhum tratamento específico para token expirado/revogado (código `190`) ou limite de taxa (`4`/`17`/`80007`, que nem sempre vêm como HTTP 429) | **Corrigido**: `src/lib/http.ts` agora interpreta `error.code`/`error_subcode` do corpo JSON (padrão Graph API) e anexa ao `HttpError`; `isWindowClosedError` usa o código primeiro (com fallback por texto); novos `isTokenInvalidError`, `isRateLimitedError`; `HttpError.retryable` passa a tratar os códigos de limite de taxa do WhatsApp como temporários mesmo sem HTTP 429 | Alta | Nenhuma — testável com `fetch` simulado (`test/unit/security.test.ts`) |
| 2 | `LLM_MAX_OUTPUT_TOKENS=800` sem checar `stop_reason === 'max_tokens'`: uma resposta cortada no meio de um `tool_use` podia ser executada com argumento incompleto | `src/ai/agent.ts` (antes da correção) | Risco real em ferramentas de agenda (`propose_booking`, `confirm_proposal`, etc.) — um argumento truncado, mesmo rejeitado pelo zod na maioria dos casos, não tinha tratamento explícito | **Corrigido**: quando `stopReason === 'max_tokens'` e há `tool_use` pendente, o agente retorna `outcome: 'error'` (contingência + handoff já existentes em `processor.ts`) em vez de tentar executar a ferramenta | Alta | Nenhuma — testável com `ScriptedLlm` (`test/unit/agent.test.ts`) |
| 3 | `freeBusy` do Google Calendar tratava **qualquer** erro de uma agenda individual como falha de toda a consulta (lançava exceção para todos os `calendarIds` pedidos) | `src/calendar/google.ts` (`busy`, antes da correção) | Uma agenda mal configurada ou com compartilhamento revogado de **um** profissional derrubava a disponibilidade de **todos** os profissionais do tenant | **Corrigido**: agenda com erro agora é tratada como ocupada durante toda a janela consultada (nunca como livre — mantém a garantia de segurança original), sem lançar exceção nem afetar as demais agendas | Alta | Nenhuma — testável com `fetch` simulado (`test/unit/calendar.test.ts`) |
| 4 | `uploadMedia` (envio de áudio de resposta) nunca foi exercitado contra a Graph API real — só contra `FakeWhatsAppClient` | `src/whatsapp/client.ts` (`uploadMedia`) | O formato multipart (`FormData`/`Blob`) segue a documentação, mas upload de mídia historicamente tem variações sutis entre versões da Graph API | Nenhuma correção de código — risco só se resolve validando contra a API real | Média | **Sim** — token/número real (Fase 3) e `TTS_PROVIDER` habilitado (Fase 7) |
| 5 | Rate limiter HTTP é em memória por processo (`src/http/rate-limit.ts`) | já documentado em `STATUS.md` → Pendente: "Rate limit distribuído entre instâncias" | Em múltiplas instâncias, o limite efetivo escala com o número de réplicas | Nenhuma ação nesta fase — já é uma pendência conhecida e aceita para o MVP de instância única | Baixa (para o MVP atual) | Não |
| 6 | Limitador de taxa dos endpoints `/admin/*` é por IP (`admin:${req.ip}`), não por chave/tenant | `src/http/app.ts` | Tenants que compartilham IP de saída (raro no cenário de demonstração) poderiam afetar uns aos outros | Nenhuma ação nesta fase — impacto insignificante para um tenant de demonstração único | Baixa | Não |
| 7 | `.env` não é carregado automaticamente por nenhum script (`npm run migrate`, `npm test`, etc.) — não há `dotenv` no projeto | `package.json`, confirmado ao rodar `npm run migrate` sem exportar as variáveis primeiro (erro `SASL: ... client password must be a string`) | Apenas um ponto de atenção operacional: é preciso `export $(cat .env)` ou equivalente antes de rodar comandos localmente fora do Docker — o `docker-compose.yml` já resolve isso via `env_file` | Nenhuma correção de código nesta fase (mudar isso seria uma decisão de dependência, fora do escopo de correção pontual) | Baixa | Não |
| — | `POST /admin/conversations/:id/release` (devolução da conversa ao bot) | `src/http/app.ts:135` | — verificado: **existe e está correto**, só não está em `human-actions.ts` como o resto do fluxo de handoff humano | N/A — não é um bug | N/A | Não |

## O que foi corrigido (commits)

1. `93545bf` — classificação de erro da Meta por código, truncamento de `max_tokens` tratado como contingência, degradação parcial do `freeBusy`. Testes novos: `test/unit/security.test.ts`, `test/unit/agent.test.ts`, `test/unit/calendar.test.ts`.

## Ambiente local — validado nesta sessão

| Item | Resultado |
|---|---|
| `git init` + commit inicial | OK — repositório agora rastreável (antes não havia controle de versão) |
| `ffmpeg`/`ffprobe` no host | Instalados via Homebrew (ausentes antes; só existiam dentro da imagem Docker) |
| Postgres 16 + Redis 7 | Subidos via `docker compose up -d postgres redis` (reaproveitando `docker-compose.yml` existente) — ambos `healthy` |
| Bancos dedicados | Criados `air` (dev), `air_test` (suíte automatizada) e `air_smoke` (teste de fumaça) no mesmo servidor Postgres local — nenhum dado de produção envolvido |
| `.env` local | Criado com `LLM_PROVIDER=fake`, `STT_PROVIDER=disabled`, `TTS_PROVIDER=disabled` e segredos de desenvolvimento gerados localmente (não reais, nunca exibidos) — coberto por `.gitignore` |
| `npm run migrate` | OK — aplicou `001_init.sql` de forma idempotente |
| `npm run typecheck` | OK — sem erros |
| `npm test` (contra `air_test`) | **109/109 testes passando** (104 originais + 5 novos desta fase) |
| `npm run smoke` (contra `air_smoke`) | **`SMOKE OK`** — fluxo completo com fakes: webhook assinado → Postgres → fila → worker → resposta da IA de demonstração → envio simulado → `status = 'sent'` no banco |

Todos os itens acima estão **validados localmente com fakes/dublês**. Nenhum deles envolveu um provedor externo real — essa distinção continua registrada em `STATUS.md`.

## Checklist para a Fase 3 (configuração real do WhatsApp)

Apenas os nomes das variáveis que faltam preencher em `src/config.ts` para sair do modo `fake`/`disabled` — nenhum valor, nenhum segredo:

| Variável | Onde vem | Observação |
|---|---|---|
| `WHATSAPP_APP_SECRET` | App Secret do app criado no Meta for Developers | Valida a assinatura `X-Hub-Signature-256` |
| `WHATSAPP_VERIFY_TOKEN` | Escolhido por nós, informado no painel da Meta ao cadastrar o webhook | Mínimo 16 caracteres |
| Token de acesso do número (não é variável de ambiente) | Painel da Meta → gerado ao conectar o número de teste/dedicado | Vai cifrado no banco via `scripts/seed-demo.ts --token ...`, nunca em `.env` |
| `PHONE_NUMBER_ID` (não é variável de ambiente) | Painel da Meta, ao escolher o número de teste | Passado como `--phone-number-id` para `scripts/seed-demo.ts` |
| Endpoint HTTPS público | Túnel (ex.: durante testes) ou deploy real | A Meta exige HTTPS para registrar o webhook |
| `ANTHROPIC_API_KEY` | Console da Anthropic | Só necessário quando sair de `LLM_PROVIDER=fake` |

Infraestrutura, código e os 109 testes automatizados já estão prontos para receber essas credenciais — nenhuma mudança de código é esperada só para a Fase 3 de texto.
