# 6. Orquestração de IA

Código: `src/ai/agent.ts`, `src/ai/tools.ts`, `src/ai/prompt.ts`, `src/ai/guardrails.ts`, `src/ai/llm.ts`.

## Princípio

O modelo **conversa e escolhe ferramentas**; o código **decide e executa**. O modelo não tem acesso a SQL, rede, arquivos, credenciais, outras conversas ou outras empresas. Tudo o que ele pode fazer está nas 9 ferramentas abaixo, e cada uma recebe `tenant`, `conversa` e `contato` do contexto do job — nunca dos argumentos do modelo.

## Contratos das ferramentas

Os schemas zod em `ToolSchemas` são a fonte única: geram o JSON Schema enviado ao modelo (`z.toJSONSchema`) e validam os argumentos devolvidos (`.strict()`: campo extra = erro).

| Ferramenta | Entrada | Saída (resumo) | Disponível quando |
|---|---|---|---|
| `get_business_info` | — | nome, fuso, expediente, informações aprovadas | sempre |
| `list_services` | — | `service_id`, nome, duração, preço aprovado | sempre |
| `check_availability` | `service_id` (uuid), `date` (AAAA-MM-DD), `part_of_day?` | até 6 horários com `slot_code` (5 caracteres, válido 30 min) | agenda autorizada |
| `propose_booking` | `slot_code`, `customer_name` | `proposal_id` + resumo; **não agenda** | agenda autorizada |
| `list_my_bookings` | — | próximas reservas **deste** contato | agenda autorizada |
| `propose_reschedule` | `booking_id`, `slot_code` | `proposal_id` + resumo | agenda autorizada |
| `propose_cancellation` | `booking_id` | `proposal_id` + resumo | agenda autorizada |
| `confirm_proposal` | `proposal_id` | `ok: true` + `confirmed_by_calendar`, ou erro tipado | agenda autorizada |
| `handoff_to_human` | `reason` (enum), `note?` | `transferred: true` | sempre |

Erros voltam como `tool_result` com `is_error: true` e um código (`invalid_arguments`, `invalid_slot`, `slot_taken`, `not_confirmed_by_customer`, `calendar_error`, `calendar_unavailable`, `unknown_booking`…), para o modelo explicar ou tentar outra opção.

### Proteções embutidas nas ferramentas de agenda

- **O modelo não inventa horário:** só reserva `slot_code` que o sistema ofereceu naquela conversa e que não expirou.
- **Confirmação verificável:** `confirm_proposal` só executa se existir mensagem do cliente **posterior** à criação da proposta. O modelo não consegue "pular" a etapa de perguntar, nem com instrução maliciosa. Limite conhecido: o sistema verifica que o cliente respondeu, não *o que* respondeu; interpretar "sim" versus "na verdade prefiro outro dia" continua sendo papel do modelo (e é um item do conjunto de avaliação da etapa 4).
- **Reserva só do próprio cliente:** `booking_id` é buscado com `tenant_id` + `contact_id`.
- **Sucesso só com confirmação da API:** o resultado `ok: true` só é devolvido depois do `events.insert` responder (ou de o evento ser encontrado com `events.get` após timeout).

## Laço do agente e limites

| Limite | Padrão | Ao estourar |
|---|---|---|
| Iterações (chamadas ao modelo) por turno | `AGENT_MAX_ITERATIONS=6` | contingência + handoff |
| Tempo total do turno | `AGENT_RUN_TIMEOUT_MS=60000` (AbortController) | contingência + handoff |
| Tempo por ferramenta | 20 s | erro de ferramenta para o modelo |
| Tokens de saída por chamada | `LLM_MAX_OUTPUT_TOKENS=800` | — |
| Orçamento diário por empresa | `tenant_settings.daily_llm_budget_micros` (US$ 2,00) | sem chamada ao modelo; handoff |
| Histórico enviado | últimas 20 mensagens | — |

O custo de cada execução é calculado pelos tokens informados na resposta e pelos preços configurados (`LLM_INPUT_MICROS_PER_MTOK`, `LLM_OUTPUT_MICROS_PER_MTOK`), gravado em `agent_runs` e somado para o orçamento do dia. **Confira os preços atuais** na página de preços do provedor; os padrões refletem a tabela consultada em out/2026 para o modelo configurado.

Integração com a Messages API da Anthropic: `POST /v1/messages`, ferramentas com `name`, `description` e `input_schema`; respostas `tool_use` são respondidas com blocos `tool_result` como **primeiros** itens da mensagem seguinte (exigência da documentação). `tool_choice` fica no padrão `auto`: a documentação informa que os modelos atuais recusam `any`/`tool` forçados.

## Regras de transferência para humano

| Gatilho | Onde é decidido |
|---|---|
| Cliente pede atendente/pessoa | **Determinístico**, antes do modelo (`wantsHuman`) |
| Reclamação, tema de saúde/sensível, fora do escopo, incerteza | Modelo, via `handoff_to_human` (instrução no system prompt) |
| Falha repetida de agenda | Modelo (instrução) + resultado de erro da ferramenta |
| Limite de iterações/tempo, erro do modelo na última tentativa | Sistema |
| Orçamento diário esgotado | Sistema |
| Mensagens atrasadas mais de 24 h | Sistema |

Depois do handoff, a conversa fica em `human`: o bot registra as mensagens mas não responde, até a equipe chamar `POST /admin/conversations/:id/release`. A equipe é avisada por um webhook assinado (`X-AIR-Signature`, HMAC-SHA256) com motivo e id da conversa, **sem** telefone nem conteúdo.

## Proteção contra instruções maliciosas

Camadas, da mais forte para a mais fraca:

1. **Capacidade limitada:** mesmo que o modelo "obedeça" a um ataque, ele só tem 9 ferramentas com escopo fixo. Não há ferramenta para listar outros clientes, mudar preços ou enviar mensagem para outro número.
2. **Identidade injetada:** tenant/contato vêm do job; schemas `.strict()` rejeitam campos extras.
3. **Confirmação verificada no banco** para qualquer alteração de agenda.
4. **Texto do cliente marcado como dado** (`<cliente>…</cliente>`, com remoção de tentativas de fechar a marcação) e instrução explícita no system prompt para ignorar pedidos de mudar regras ou revelar instruções.
5. **Sanitização da saída:** remove UUIDs, nomes de ferramentas e títulos markdown; limita tamanho.

O que **não** está coberto: um cliente pode convencer o modelo a dizer algo inadequado em texto (sem efeito colateral). Mitigações futuras: classificador de saída, lista de respostas proibidas por empresa e amostragem para revisão humana.

## Aviso de atendimento automatizado

Na primeira resposta a cada contato, o sistema acrescenta: "Sou a assistente virtual do {empresa}… se preferir falar com uma pessoa, escreva 'atendente'", e registra em `consents` (`ai_processing`, origem `notice_first_message`).
