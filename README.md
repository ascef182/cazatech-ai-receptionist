# CazaTech AI Receptionist

Atendente de WhatsApp com IA para salões, barbearias e clínicas de estética: responde dúvidas com informações aprovadas pela empresa, entende áudio, transfere para a equipe e — quando autorizado — agenda, remarca e cancela no Google Calendar.

**Estado:** MVP de escopo limitado, com 109 testes automatizados passando contra Postgres, Redis e ffmpeg reais. As integrações externas (Meta, Anthropic, OpenAI, ElevenLabs, Google) estão implementadas conforme a documentação oficial, mas **ainda não foram executadas com credenciais reais**. Detalhes em [`STATUS.md`](STATUS.md).

## Documentação

| # | Documento |
|---|---|
| 1 | [Descoberta e requisitos](docs/01-descoberta-e-requisitos.md) — MVP, atores, casos de uso, riscos, critérios de aceitação |
| 2 | [Arquitetura](docs/02-arquitetura.md) — componentes, fluxos síncrono e assíncrono, fronteiras de segurança (diagramas Mermaid) |
| 3 | [Modelo de dados](docs/03-modelo-de-dados.md) — tabelas, chaves, índices, isolamento, retenção |
| 4 | [Webhooks e processamento](docs/04-webhooks-e-processamento.md) — validação, deduplicação, debounce, lease, tentativas |
| 5 | [Áudio](docs/05-audio.md) — download seguro, validação, STT, TTS opcional, fallback |
| 6 | [Orquestração de IA](docs/06-orquestracao-ia.md) — contratos das ferramentas, limites, handoff, injeção de instruções |
| 7 | [Google Calendar e MCP](docs/07-calendario.md) — escopos, fluxos, conflitos |
| 8 | [Segurança e privacidade](docs/08-seguranca-e-privacidade.md) — autenticação, LGPD, auditoria, incidentes |
| 9 | [Testes](docs/09-testes.md) — cenários exigidos × testes, resultado real |
| 10 | [Plano de implementação](docs/10-plano-de-implementacao.md) — tarefas, dependências, critérios, próximos passos |
| 11 | [Auditoria e validação](docs/11-auditoria-e-validacao.md) — achados da auditoria técnica, correções aplicadas, ambiente local validado, checklist para credenciais reais |
| — | [Referências](docs/referencias.md) |

## Estrutura

```
src/
  config.ts              variáveis de ambiente validadas (zod)
  main-api.ts            processo da API (Fastify)
  main-worker.ts         processo do worker (BullMQ) + manutenção
  http/                  rotas: webhook, admin, health; rate limit
  whatsapp/              schema do webhook, ingestão transacional, cliente da Cloud API
  queue/                 fila com debounce, reconciliador do outbox
  worker/                processamento da conversa, retenção
  ai/                    cliente LLM, laço do agente, ferramentas, prompt, guardrails
  calendar/              disponibilidade, fuso, BookingService, Google, fake
  audio/                 ffmpeg/ffprobe, STT, TTS
  handoff/               notificação para a equipe, ações humanas, exclusão LGPD
  tenant/                carregamento do contexto da empresa
migrations/001_init.sql  schema completo
test/                    unit, integration, e2e
scripts/                 seed-demo.ts, smoke.ts
```

## Rodando localmente

Requisitos: Node 22+, PostgreSQL 16 (com `btree_gist`), Redis 7, ffmpeg.

```bash
npm install
cp .env.example .env          # preencha os segredos
# chave de cifragem: openssl rand -base64 32

npm run migrate
npm run seed:demo -- --phone-number-id <ID_DO_NUMERO> --token <TOKEN_META>
npm run start:api             # porta 3000
npm run start:worker
```

Sem nenhuma credencial, dá para ver a pilha funcionando com `LLM_PROVIDER=fake` e `STT_PROVIDER=disabled`, ou rodar o teste de fumaça:

```bash
DATABASE_URL=postgresql://.../air_smoke npm run smoke
```

Com Docker (não testado neste ambiente): `docker compose up --build`.

### Configurar o webhook na Meta

1. Publique a API com HTTPS (ex.: Cloud Run, ou um túnel durante testes).
2. No app da Meta, configure a URL `https://<host>/webhooks/whatsapp` e o `WHATSAPP_VERIFY_TOKEN`; assine o campo `messages`.
3. `WHATSAPP_APP_SECRET` = app secret do app; o token de acesso do número vai cifrado no banco pelo `seed:demo`.

### Endpoints administrativos

Todos com `Authorization: Bearer <chave da empresa>` (gerada pelo seed):

| Método | Caminho | Uso |
|---|---|---|
| GET | `/admin/conversations?status=human` | conversas aguardando a equipe |
| POST | `/admin/conversations/:id/messages` | resposta humana (`{"text": "..."}`) |
| POST | `/admin/conversations/:id/release` | devolve a conversa ao bot |
| POST | `/admin/contacts/:id/erase` | exclusão de dados (LGPD) |

## Testes

```bash
npm run typecheck
TEST_DATABASE_URL=postgresql://air:air@localhost:5432/air_test TEST_REDIS_URL=redis://127.0.0.1:6379 npm test
```

Os testes **apagam e recriam o schema** do banco indicado em `TEST_DATABASE_URL`. Use um banco exclusivo.

### CI

O workflow do GitHub Actions está em `ci/github-actions.yml` (sobe Postgres e Redis, instala ffmpeg, roda typecheck e testes). Para ativar, mova para `.github/workflows/ci.yml`.
