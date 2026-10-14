# 1. Descoberta e requisitos

## Contexto encontrado nos repositórios

Antes de criar este projeto, inspecionei o que já existe em `~/Documents`:

| Repositório | O que tem de relevante | Decisão |
|---|---|---|
| **bladiq/aparatus-barber** (Bladiq) | Next.js 16 + Prisma; modelos `Booking`, `Service`, `Staff`, `StaffWorkingHours`, `Conversation`, `Message`; `lib/scheduling/availability.ts`; worker BullMQ; zod, pino, vitest | Não acoplar no MVP. Usar a **mesma família de bibliotecas** (BullMQ, ioredis, zod 4, pino, vitest) para facilitar uma integração futura: o Bladiq pode virar um *provider* de agenda alternativo ao Google Calendar (interface `CalendarProvider`). |
| **Opsmind** | Monorepo NestJS + Next + worker BullMQ, Prisma, pgvector | Sem sobreposição direta. Mesmo padrão de worker separado da API. |

O projeto novo fica isolado em `~/Documents/cazatech-ai-receptionist`, conforme pedido, sem modificar código existente.

## Objetivo do MVP

Validar comercialmente um atendente de WhatsApp para **uma empresa piloto** (salão, barbearia ou clínica de estética) que:

1. responde dúvidas com informações aprovadas pela empresa;
2. entende texto e áudio;
3. transfere para a equipe quando necessário;
4. quando a empresa autoriza, consulta horários e agenda, remarca ou cancela no Google Calendar.

Fora do MVP (de propósito): painel web, onboarding self-service, cobrança, multiempresa em escala, campanhas ativas/marketing, templates fora da janela de 24h, múltiplos idiomas.

O banco já é multiempresa (toda tabela tem `tenant_id`), porque refazer isso depois custa caro. O que **não** foi construído é a operação multiempresa (cadastro, cobrança, painel).

## Atores

| Ator | Interação |
|---|---|
| **Cliente final** | Conversa pelo WhatsApp (texto ou áudio). |
| **Equipe da empresa** | Recebe aviso de transferência (via webhook → n8n → Telegram/e-mail), responde pelo endpoint administrativo e devolve a conversa ao bot. |
| **Dono / admin da empresa** | Define serviços, preços aprovados, expediente, se a IA pode agendar e se responde em voz. No MVP, via seed/SQL. |
| **CazaTech (operação)** | Configura números, credenciais, limites de custo e acompanha logs/auditoria. |
| **Meta (WhatsApp Business Platform)** | Entrega webhooks e recebe envios. |
| **Provedores externos** | LLM (Anthropic), STT (OpenAI), TTS (ElevenLabs), Google Calendar. |

## Casos de uso

| # | Caso | Prioridade |
|---|---|---|
| UC1 | Cliente pergunta preço, endereço, horário de funcionamento ou formas de pagamento | MVP |
| UC2 | Cliente manda várias mensagens seguidas → uma resposta só | MVP |
| UC3 | Cliente manda áudio → transcrição → resposta | MVP |
| UC4 | Cliente pede para falar com uma pessoa → transferência imediata | MVP |
| UC5 | IA identifica reclamação, tema de saúde ou dúvida fora do escopo → transferência | MVP |
| UC6 | Cliente pede horário → consulta → proposta → confirmação → evento criado | MVP (se autorizado) |
| UC7 | Cliente consulta, remarca ou cancela o próprio agendamento | MVP (se autorizado) |
| UC8 | Equipe responde e devolve a conversa ao bot | MVP (API) |
| UC9 | Resposta em voz para quem mandou áudio | Opcional (desligado por padrão) |
| UC10 | Pedido de exclusão de dados (LGPD) | MVP (API) |

## Limitações conhecidas

- **Janela de 24 horas:** fora da janela de atendimento, a Meta só aceita templates aprovados. O sistema só responde a mensagens recebidas; não faz envio ativo. Falha de envio fora da janela é registrada como `outside_customer_service_window`.
- **Número dedicado:** um número conectado à Cloud API é operado pela API. O uso simultâneo do número no app WhatsApp Business ("coexistência") não foi avaliado; no MVP, a equipe responde pelo endpoint administrativo.
- **Remarcação que se sobrepõe à reserva antiga do mesmo cliente** (ex.: adiar 30 min um serviço de 60 min) é recusada pela constraint de sobreposição; a IA oferece outro horário ou transfere.
- **Agenda só via conta de serviço Google** (agenda compartilhada com o e-mail da conta de serviço). OAuth do usuário final está no plano, não implementado.
- **Preços e políticas** vêm de cadastro manual; a IA não inventa (instrução + ferramentas), mas a revisão humana do cadastro é responsabilidade da empresa.

## Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| IA informa preço/horário errado | Alto (atrito com cliente) | Ferramentas são a única fonte de dados; horário só reservável por código oferecido pelo sistema; sucesso só após confirmação da API |
| Duplo agendamento | Alto | Constraint de exclusão no Postgres + revalidação no freeBusy antes de criar o evento |
| Webhook duplicado / fora de ordem | Médio | Deduplicação por hash do corpo e por `wamid`; processamento lê o estado do banco, não o payload |
| Indisponibilidade do Redis | Médio | Outbox transacional no Postgres + reconciliador |
| Injeção de instruções em mensagens | Médio | Texto do cliente marcado como dado; ferramentas com escopo fixo; tenant/contato nunca vêm do modelo |
| Custo descontrolado de LLM | Médio | Orçamento diário por empresa, limite de iterações, tokens e tempo |
| Dados pessoais e de saúde | Alto (LGPD) | Mínimo necessário, áudio só em memória, retenção configurável, exclusão sob pedido, logs sem conteúdo |
| Dependência de credenciais reais não testadas | Médio | Adaptadores verificados contra a documentação e testados com `fetch` simulado; validação real é etapa explícita do plano |

## Critérios de aceitação do MVP

| # | Critério | Como é verificado |
|---|---|---|
| A1 | Webhook com assinatura inválida é recusado (401) | `test/integration/webhook.test.ts` |
| A2 | Webhook responde sem esperar LLM, STT ou TTS | arquitetura + e2e (`full-flow`) |
| A3 | Webhook reentregue não gera mensagem nem resposta duplicada | integração + e2e |
| A4 | Mensagens em sequência geram uma única resposta | integração + e2e (BullMQ real) |
| A5 | Nunca há duas reservas ativas sobrepostas para o mesmo profissional | teste de concorrência + teste de mutação (removendo a constraint, o teste falha) |
| A6 | A IA só diz "agendado" quando a agenda confirmou | contrato da ferramenta + testes de falha da agenda |
| A7 | Pedido explícito de atendente transfere sem chamar o modelo | integração |
| A8 | Dados de uma empresa nunca aparecem para outra | FKs compostas + testes de isolamento |
| A9 | Com Redis fora do ar, nenhuma mensagem é perdida | integração + e2e |
| A10 | Gasto diário de LLM por empresa respeita o limite | integração |
| A11 | Validação real com WhatsApp, Google e LLM | **Pendente** (precisa de credenciais) — ver `STATUS.md` |
