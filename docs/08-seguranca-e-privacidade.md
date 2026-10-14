# 8. Segurança e privacidade

## Autenticação

| Superfície | Mecanismo |
|---|---|
| Webhook da Meta (POST) | HMAC-SHA256 do corpo bruto com o app secret (`X-Hub-Signature-256`), comparação em tempo constante |
| Verificação do webhook (GET) | `hub.verify_token` comparado em tempo constante |
| Endpoints administrativos | `Authorization: Bearer <chave>`; o banco guarda só o SHA-256 da chave (`admin_api_keys.key_hash`); chave revogável (`revoked_at`) |
| Aviso de handoff para a empresa | Corpo assinado com HMAC-SHA256 (`X-AIR-Signature`), só HTTPS |
| Saída para provedores | Tokens de API em variáveis de ambiente (LLM, STT, TTS) ou cifrados por empresa (Meta, Google) |

## Autorização por empresa

- Cada chave administrativa pertence a uma empresa; todas as consultas administrativas filtram por esse `tenant_id`. Testado: a chave da empresa B recebe 404 ao tentar liberar uma conversa da empresa A e não enxerga as conversas de A.
- No processamento, o `tenant_id` vem do número que recebeu a mensagem (`whatsapp_numbers.phone_number_id`), nunca do conteúdo.
- O banco reforça com chaves estrangeiras compostas (ver `03-modelo-de-dados.md`).

## Proteção de credenciais

- Segredos da aplicação (`WHATSAPP_APP_SECRET`, `DATA_ENCRYPTION_KEY`, `HANDOFF_SIGNING_SECRET`, chaves de API) só em variáveis de ambiente / gerenciador de segredos (ex.: Secret Manager no GCP). `.env` fora do git.
- Credenciais por empresa (token da Meta, conta de serviço do Google): AES-256-GCM com IV aleatório e tag de autenticação; chave fora do banco. Adulteração é detectada (teste).
- Rotação: trocar `DATA_ENCRYPTION_KEY` exige recifrar `whatsapp_numbers` e `calendar_connections` (script de rotação está no plano).
- Logs com redação automática (pino `redact`) de cabeçalhos de autorização, assinatura, tokens, corpo de mensagens, transcrições e telefones.

## Rate limiting

- Webhook: limite por IP por minuto (`RATE_LIMIT_PER_MINUTE`, padrão 600).
- Admin: `ADMIN_RATE_LIMIT_PER_MINUTE` (padrão 60).
- O IP vem de `X-Forwarded-For` (`trustProxy: true`), adequado atrás de um balanceador. Exposta diretamente à internet, a API deve desligar `trustProxy` para o cabeçalho não ser forjado.
- Implementação em memória, por instância. Com várias instâncias, mover para o balanceador/WAF ou para Redis (sem tornar o webhook dependente do Redis).
- Custo: orçamento diário de LLM por empresa (ver `06-orquestracao-ia.md`).

## Dados pessoais (LGPD)

Base de dados tratados: telefone (`wa_id`), nome de perfil, nome informado, conteúdo das conversas, transcrições, reservas.

| Princípio | Como foi aplicado |
|---|---|
| Necessidade | Para agendar, só o nome. O prompt proíbe pedir documentos, cartão ou dados de saúde. |
| Transparência | Aviso automático de atendimento por IA na primeira resposta, com caminho para pessoa; registrado em `consents`. |
| Minimização no armazenamento | Áudio nunca é armazenado; payload bruto do webhook apagado em 7 dias (ou nunca gravado); conteúdo das mensagens apagado após a retenção configurada. |
| Minimização no compartilhamento | O aviso de handoff não leva telefone nem conteúdo. Logs não têm conteúdo. Ao LLM vão só as últimas 20 mensagens da própria conversa e os dados aprovados da empresa. |
| Direitos do titular | `POST /admin/contacts/:id/erase` remove identificação e conteúdo, fecha a conversa e mantém só o necessário da reserva, com auditoria. |
| Segurança | Ver seções acima. |

Papéis: a empresa cliente (salão) é **controladora**; a CazaTech atua como **operadora**, e os provedores de IA, voz e agenda são suboperadores. Isso precisa constar no contrato com a empresa (DPA) e na política de privacidade dela. Verifique, para cada provedor, a política de retenção e o uso de dados enviados pela API, e prefira as opções sem retenção quando disponíveis. **Isto não é parecer jurídico: essa parte precisa de revisão de um advogado.**

Temas de saúde (clínicas de estética): o sistema não pede nem interpreta dados de saúde e transfere esses casos para a equipe. Mesmo assim, o cliente pode enviá-los espontaneamente; por isso a retenção curta e a exclusão sob pedido importam.

## Auditoria

`audit_log` registra: transferências, criação/cancelamento/remarcação de reservas, liberação de conversa, respostas humanas e exclusões. Sem conteúdo de mensagem. A tabela é somente inserção (trigger), exceto pelo job de retenção. `agent_runs` registra cada execução do agente (modelo, iterações, tokens, custo, resultado).

## Tratamento de incidentes

| Incidente | Resposta imediata |
|---|---|
| Vazamento de token da Meta | Revogar no Business Manager, gerar novo, recifrar no banco; verificar envios em `messages` no período |
| Vazamento de `DATA_ENCRYPTION_KEY` | Rotacionar chave e recifrar credenciais; revogar tokens de terceiros |
| IA respondendo errado em massa | `UPDATE tenant_settings SET ai_enabled = false` (efeito imediato, mensagens continuam registradas) |
| Custo anormal | Reduzir `daily_llm_budget_micros`; consultar `agent_runs` por empresa |
| Webhook sob ataque | Assinatura já barra; reforçar limite no balanceador; considerar mTLS/allowlist de IPs da Meta (opções citadas na documentação) |
| Pedido do titular / ANPD | `erase` + extração de `audit_log` |

Prazo legal de comunicação de incidentes com dados pessoais e formato: seguir a regulamentação vigente da ANPD (verificar no momento do incidente).
