# Status — CazaTech AI Receptionist

Atualizado em 13/10/2026. Lista objetiva do que existe, do que foi executado e do que falta.

## Implementado **e testado** (104 testes, todos passando; Postgres, Redis e ffmpeg reais)

- Webhook da WhatsApp Cloud API: verificação GET, assinatura HMAC-SHA256 do corpo bruto, validação do payload, limite de taxa.
- Persistência transacional: evento bruto, contato, conversa, mensagem, status de entrega e outbox.
- Deduplicação por hash do corpo e por `wamid`; status de entrega que só avança.
- Enfileiramento BullMQ com debounce por conversa; prazo curto no webhook.
- Outbox + reconciliador (Redis fora do ar, jobs perdidos, mensagens paradas), com advisory lock.
- Worker com lease por conversa, rodadas, reenvio de respostas pendentes, tratamento de última tentativa.
- Agente com 9 ferramentas tipadas (zod → JSON Schema), limites de iteração, tempo, tokens e orçamento diário por empresa; registro de custo em `agent_runs`.
- Agenda: disponibilidade por expediente/fuso/antecedência, códigos de horário oferecidos, proposta → confirmação verificada no banco → evento com id determinístico; revalidação no freeBusy; constraint de exclusão contra duplo agendamento; remarcação e cancelamento; tratamento de timeout, 409, falha permanente.
- Handoff: atalho determinístico para "atendente", handoff pelo modelo e pelo sistema, aviso assinado para webhook (n8n), resposta humana e devolução ao bot pela API admin.
- Áudio: download seguro (hosts da Meta, limite de bytes, hash), validação com ffprobe, conversão para MP3, transcrição; resposta em voz opcional com normalização para OGG/Opus mono e fallback para texto.
- Isolamento por empresa (FKs compostas, escopo nas consultas e nas ferramentas, chaves admin por empresa).
- LGPD: aviso de IA na primeira resposta, exclusão sob pedido, retenção automática, auditoria somente inserção, logs sem conteúdo.
- Processos reais `main-api` e `main-worker` executados juntos no teste de fumaça (`npm run smoke`): webhook → fila → worker → envio para Graph API simulada → status `sent` no banco.

## Implementado, **mas não validado contra o serviço real** (falta credencial)

| Integração | O que foi verificado | O que falta |
|---|---|---|
| WhatsApp Cloud API (envio, mídia, leitura/digitação) | formato das requisições conforme documentação oficial; testes com `fetch` simulado | número real, token, webhook publicado com HTTPS |
| Anthropic Messages API | formato da requisição, cabeçalhos, tratamento de `tool_use`/`tool_result` | chave real; qualidade das respostas em português |
| OpenAI transcrição | multipart com MP3 convertido de verdade | chave real; precisão com áudios reais |
| ElevenLabs TTS | requisição e normalização do áudio de saída | chave e voz reais |
| Google Calendar | requisições freeBusy/insert/get/delete e tratamento de 409/404/410 | conta de serviço e agenda compartilhada |
| Notificação de handoff para n8n | assinatura e corpo | URL real do fluxo n8n |
| Docker (`Dockerfile`, `docker-compose.yml`) | `npm run build` (tsc) gera `dist/` e importa corretamente | build da imagem: o Docker Hub está bloqueado no ambiente onde o código foi escrito |

Itens a confirmar no primeiro teste real: código de erro da Meta fora da janela de 24 h (o código trata `131047`/"re-engagement", que não foi confirmado na documentação consultada) e o preço por token do modelo escolhido.

## Pendente (não implementado)

- Validação com empresa piloto (etapa 4 do plano).
- Conjunto de avaliação do agente com conversas reais anonimizadas.
- Painel web para a equipe (hoje: API `/admin/*`).
- OAuth Google para contas pessoais; provider Bladiq.
- Templates de mensagem fora da janela de 24 h (lembretes, confirmações ativas).
- Observabilidade (métricas, alertas, tracing) e rotação de chave de cifragem.
- Rate limit distribuído entre instâncias; Row-Level Security.
- Coexistência do número com o app WhatsApp Business (não avaliada).
- Aviso à equipe quando chegam novas mensagens numa conversa que já está com ela (hoje só o handoff inicial gera aviso).
