# 9. Testes

**Resultado da última execução (13/10/2026):** 104 testes, 104 aprovados, 0 falhas — 9 arquivos, ~16 s.
Ambiente: Node 22, PostgreSQL 16.15 real, Redis 7.0.15 real, ffmpeg 6.1.1 real. Externos (Meta, Anthropic, OpenAI, ElevenLabs, Google) simulados.

```bash
npm run typecheck   # tsc sem erros
npm test            # vitest (precisa de Postgres e Redis: TEST_DATABASE_URL / TEST_REDIS_URL)
npm run smoke       # processos reais de API e worker + Graph API simulada
```

## Pirâmide

| Camada | Arquivos | Testes | O que é real | O que é simulado |
|---|---|---|---|---|
| Unitário | `test/unit/*` | 44 | lógica pura, zod, crypto, fuso horário | `fetch` dos provedores |
| Integração | `test/integration/*` | 56 | Postgres, Redis/BullMQ, ffmpeg | Meta, LLM (roteirizado), STT/TTS, Google |
| Ponta a ponta | `test/e2e/full-flow.test.ts` | 4 | HTTP (Fastify escutando), Postgres, Redis, worker BullMQ, debounce | Meta (envio), LLM, Google |
| Fumaça | `scripts/smoke.ts` | 1 roteiro | os dois processos (`main-api`, `main-worker`) com configuração real | Graph API (servidor local), LLM em modo demonstração |

O LLM roteirizado (`ScriptedLlm`) devolve respostas pré-definidas — inclusive funções que leem o `tool_result` anterior, para reproduzir o comportamento de um modelo que usa os códigos de horário devolvidos pelas ferramentas.

## Cenários exigidos → testes

| Cenário pedido | Testes | Arquivo |
|---|---|---|
| **Webhooks duplicados** | mesmo corpo reentregue; mesmo `wamid` em corpos diferentes; duplicado ponta a ponta sem resposta dupla | webhook, e2e |
| **Mensagens enviadas em sequência** | 3 mensagens → 1 conversa; 3 mensagens → 1 chamada ao modelo e 1 resposta; debounce com BullMQ real (1 job por conversa); rajada ponta a ponta | webhook, processor, queue, e2e |
| **Áudios inválidos** | arquivo corrompido; acima da duração; acima dos bytes (sem baixar tudo); tipo não suportado; STT desligado; download só de hosts da Meta | audio, whatsapp-client, security |
| **Falhas temporárias de APIs** | LLM 529 → repete sem duplicar; LLM fora na última tentativa → contingência + handoff; envio ao WhatsApp falha → reenvio sem nova chamada ao modelo; STT 503 → repete; Calendar 503 → repete e confirma; classificação 5xx/429/timeout | processor, audio, agent, security |
| **Repetição de jobs** | job repetido após sucesso não gera nova resposta; `confirm_proposal` duas vezes é idempotente | processor |
| **Duas solicitações para o mesmo horário** | dois clientes confirmam em paralelo → 1 reserva, o outro recebe `slot_taken`. **Validado por mutação:** removendo a constraint de exclusão, o teste falha (2 reservas) | processor |
| **Falha na criação do evento** | falha permanente → reserva `failed`, IA não confirma; timeout após criação → evento encontrado, sem duplicar; ocupação manual na agenda → `slot_taken` | processor |
| **Transferência para atendimento humano** | pedido explícito sem chamar o modelo; mensagens seguintes sem resposta automática; handoff pelo modelo; resposta humana pelo painel; devolução ao bot; aviso sem telefone | processor, webhook |
| **Isolamento entre empresas** | mesmo cliente em 2 empresas → contatos separados; FK composta recusa referência cruzada; chave admin da empresa B não acessa conversa de A; cliente de outra empresa (e outro cliente da mesma) não cancela reserva alheia | webhook, processor |
| **Indisponibilidade do Redis** | enfileiramento falha em < 1,5 s; webhook responde 200 e grava outbox; reconciliador despacha quando o Redis volta; e2e: resposta entregue depois; reconciliador reenfileira mensagens paradas; reconciliador em instância única | queue, webhook, e2e |
| **Limites de custo e tempo** | orçamento diário esgotado → sem chamada ao modelo; limite de custo dentro do turno; limite de iterações com custo registrado; limite de tempo (AbortController) | processor, agent |

Também cobertos: assinatura HMAC (5 variações), verificação GET, payload malformado, status de entrega monotônico, cifragem/adulteração, limitador de taxa, guardrails, fuso horário com e sem horário de verão, geração de horários, contratos das ferramentas, formato das requisições para Meta/Anthropic/Google/OpenAI/ElevenLabs, conversão real de áudio (OGG → MP3 para o STT; MP3 → OGG/Opus mono para voz), exclusão LGPD, retenção e imutabilidade da auditoria.

## O que os testes **não** provam

- Que as credenciais reais funcionam e que a Meta/Google/Anthropic/OpenAI/ElevenLabs respondem exatamente como a documentação descreve. Os adaptadores seguem a documentação oficial consultada em 13/10/2026, mas não foram executados contra os serviços reais.
- A qualidade das respostas de um modelo real em português (tom, aderência às regras, resistência a manipulação). Isso exige um conjunto de avaliação com conversas reais anonimizadas — está no plano.
- Comportamento sob carga (centenas de conversas simultâneas).
- A imagem Docker: o `Dockerfile` e o `docker-compose.yml` foram escritos, mas o build não pôde ser executado neste ambiente (o registro do Docker Hub está bloqueado aqui).
