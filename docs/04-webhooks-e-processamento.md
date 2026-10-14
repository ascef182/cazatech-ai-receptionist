# 4. Webhooks e processamento

Código: `src/http/app.ts`, `src/whatsapp/ingest.ts`, `src/queue/*`, `src/worker/processor.ts`, `src/worker/run-worker.ts`.

## Validação do evento

| Etapa | Implementação | Referência oficial |
|---|---|---|
| Verificação do endpoint | `GET /webhooks/whatsapp` compara `hub.verify_token` em tempo constante e devolve `hub.challenge` com 200 | Create a webhook endpoint (Meta) |
| Autenticidade | `X-Hub-Signature-256: sha256=<hex>` = HMAC-SHA256 do **corpo bruto** com o app secret; comparação em tempo constante; 401 se inválido | idem |
| Tamanho | `bodyLimit` de ~3 MB (payload máximo documentado: 3 MB) | Webhooks overview |
| Estrutura | zod (`webhook-schema.ts`) com objetos "soltos" para tolerar campos novos; payload inválido é gravado como `invalid` e recebe 200 (evita reentrega infinita) | Messages webhook reference |
| Taxa | limitador por IP em memória (`RATE_LIMIT_PER_MINUTE`) | — |

## Deduplicação

A Meta pode reentregar o mesmo evento por até 7 dias, e a documentação avisa que isso gera duplicatas. Duas camadas:

1. **Evento inteiro:** `webhook_events.body_sha256` único. Reentrega idêntica termina na hora, com 200.
2. **Mensagem:** `UNIQUE (tenant_id, wa_message_id)`. Mesmo que a mensagem venha em outro lote (corpo diferente), ela não é gravada duas vezes e não gera nova linha de outbox.

Status de entrega (`sent` → `delivered` → `read`, ou `failed`) só avançam; um `delivered` atrasado não sobrescreve um `read`.

## Persistência e enfileiramento

Tudo o que deriva do webhook é gravado **numa única transação**: evento, contato, conversa, mensagens, status e outbox. Só depois do COMMIT a API tenta enfileirar, com prazo de `ENQUEUE_TIMEOUT_MS` (300 ms). O webhook nunca espera transcrição, LLM ou síntese de voz.

## Agrupamento de mensagens (debounce)

Job BullMQ com:

```ts
deduplication: { id: `conv:${conversationId}`, ttl: DEBOUNCE_MS, extend: true, replace: true },
delay: DEBOUNCE_MS
```

Esse é o modo "debounce" descrito na documentação do BullMQ: cada nova mensagem substitui o job ainda em espera e reinicia o prazo. Resultado: "oi" + "tudo bem?" + "quanto custa?" em 2 segundos viram **uma** chamada ao modelo e **uma** resposta (teste e2e com Redis real).

O conteúdo do job é só `{tenantId, conversationId}`. O worker lê do banco **todas** as mensagens com `processed_at IS NULL`, então nada depende de qual job "venceu".

## Concorrência por conversa

Lease no Postgres:

```sql
UPDATE conversations SET lease_owner = $worker, lease_until = now() + LEASE_MS
WHERE id = $1 AND tenant_id = $2 AND (lease_until IS NULL OR lease_until < now() OR lease_owner = $worker)
RETURNING id
```

- Se outro worker tem o lease, o job é reagendado com `job.moveToDelayed(+1,5 s)` + `DelayedError` (não consome tentativa).
- Se o worker morrer, o lease expira sozinho (`LEASE_MS`, padrão 90 s).
- Mensagens que chegam durante o processamento entram na próxima rodada do mesmo job (até 3 rodadas) ou no próximo job.

Workers diferentes processam conversas diferentes em paralelo (`WORKER_CONCURRENCY`).

## Tentativas e recuperação de falhas

| Situação | Comportamento |
|---|---|
| Falha temporária (HTTP 408/429/5xx, timeout, erro de rede) no LLM ou STT | Exceção → BullMQ repete (6 tentativas, backoff exponencial a partir de 2 s). As mensagens continuam pendentes; nada foi enviado. |
| Última tentativa ainda com falha temporária | Resposta de contingência ("vou chamar a equipe") + transferência para humano. Nunca fica em silêncio. |
| Falha temporária no envio ao WhatsApp | A resposta já está gravada como `pending`. Na nova tentativa, `flushPendingOutbound` reenvia **sem chamar o modelo de novo**. |
| Falha permanente no envio (ex.: fora da janela de 24 h) | Mensagem marcada `failed` com o motivo; sem novas tentativas. |
| Job repetido depois de sucesso | Nada pendente → nenhuma resposta (idempotente). |
| Job perdido / Redis apagado | Reconciliador reenfileira conversas com mensagens pendentes há mais de `DEBOUNCE_MS + LEASE_MS`. |
| Redis fora do ar | API grava no outbox e responde 200; reconciliador despacha com backoff quando o Redis voltar. Worker para de consumir até o Redis voltar. |
| Mensagens reentregues com mais de 24 h de atraso | Não recebem resposta automática (seria estranho responder "oi" de três dias atrás); a conversa vai para a equipe com motivo `stale_messages`. |
| Crash entre criar o evento na agenda e responder | Na repetição, `confirm_proposal` é idempotente (`proposal_id` único em `bookings`; id determinístico no Google). |

Entrega das respostas é **pelo menos uma vez**: se o processo cair exatamente entre o aceite da Meta e a gravação do `wamid`, a resposta pode ser reenviada. É o compromisso aceito para nunca perder resposta.

## Reconciliador

`src/queue/reconciler.ts`, a cada `OUTBOX_RELAY_INTERVAL_MS` (2 s), protegido por `pg_try_advisory_lock` para rodar em uma instância por vez:

1. despacha linhas de `outbox` pendentes (para no primeiro erro de Redis e aplica backoff de até 60 s por linha);
2. reenfileira conversas com mensagens paradas;
3. a cada hora, aplica a política de retenção.
