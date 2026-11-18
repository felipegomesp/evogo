# Evolution Go ⇄ Chatwoot: funcionalidades (especificação)

Este documento descreve **o que a integração faz**, para poder reimplementá-la ou ajustá-la quando o Evolution Go for atualizado.
Para o passo a passo de atualização, veja `UPGRADE-EVOGO.md`. Versão de referência: Evolution Go **0.7.3**, Chatwoot **4.19** (custom3).

## 1. Componentes

| Componente | Imagem | Papel |
|---|---|---|
| Evolution Go com patch | `felipegomesp/evolution-go-chatwoot:<versão>-cw1` | Evolution Go original + 1 linha no `index.html` do manager que carrega o painel |
| Ponte | `felipegomesp/evogo-chatwoot-bridge:<versão>` | Serviço Node que espelha mensagens e serve o painel e a API `/admin` |

O binário do Evolution Go **não é alterado**. Toda a lógica está na ponte.

## 2. Funcionalidades

### 2.1 WhatsApp → Chatwoot (entrada)
| Funcionalidade | Como funciona |
|---|---|
| Texto | `Message.conversation` ou `extendedTextMessage.text` vira mensagem *incoming* na conversa do contato |
| Contato | Telefone vem de `Info.Chat`/`Sender` (`@s.whatsapp.net`); `@lid` é ignorado como identidade (usa `SenderAlt` só como apoio). Nome = `PushName`. Busca por telefone com as **duas variações do nono dígito** (55 + DDD + 9) |
| Conversa | Reaproveita a conversa aberta da inbox; se resolvida, cria nova (ou reabre, se a opção estiver ligada). Opção "pendente" |
| Reply | `contextInfo.stanzaID` → `in_reply_to` do Chatwoot (via tabela de mapeamento) |
| Imagem, vídeo, áudio, documento, sticker | O evogo entrega o arquivo em `Message.base64`; a ponte anexa (multipart) com o nome/mimetype corretos e a legenda |
| Mensagem enviada do celular | `Info.IsFromMe = true` vira mensagem *outgoing* (sem reenviar) |
| Apagar para todos | `Info.Edit = "7"` (ou `"8"`) + `protocolMessage.key.ID` → apaga a mensagem espelhada no Chatwoot |
| Editar | `Info.Edit = "1"` + `secretEncryptedMessage` (tipo 2). **O texto novo chega cifrado**: a ponte guarda o `messageSecret` de cada mensagem e decifra (HKDF-SHA256 + AES-256-GCM). No Chatwoot aparece como nova mensagem "✏️ Mensagem editada: …" respondendo à original |
| Entregue / lido (tiques) | Evento `Receipt` do evogo (assinado como `READ_RECEIPT`): `MessageIDs` + `Type` (`""` = entregue, `read`/`played` = lido) → `PATCH /conversations/:c/messages/:m {status}` no Chatwoot (só inbox de API). Só para mensagens enviadas pelo Chatwoot; nunca rebaixa o status (lido → entregue). Status guardado em `messages.wa_status` |
| Anti-duplicidade | Cada `Info.ID` do WhatsApp é gravado; reentregas do webhook são ignoradas |
| Tipos não suportados | Viram texto `[mensagem não suportada: <tipo>]` (localização, contato, enquete, etc.) |
| Grupos | Com "ignorar grupos" desligado, o grupo vira **uma conversa só**, identificada pelo JID (`…@g.us`). O contato do grupo é criado **sem `phone_number`** (o JID tem 18 dígitos e o Chatwoot recusa como não-e164), com `identifier = JID` e nome `Nome do grupo (GROUP)` (nome via `POST /group/info`, best-effort). Mensagens de participantes chegam com o prefixo `*PushName:*`; as enviadas do celular não. Do Chatwoot para o grupo: o JID vem do mapeamento da conversa (`sendText` com `number = JID`) |
| Ignorados | Grupos (se a opção estiver ligada), status/broadcast, newsletters, reações, protocolo interno |

### 2.2 Chatwoot → WhatsApp (saída)
| Funcionalidade | Como funciona |
|---|---|
| Texto | Webhook `message_created` (*outgoing*, não privada) → `POST /send/text` com `id` gerado pela ponte |
| Anexos | Cada anexo → `POST /send/media` (`type`: image/video/audio/document); a URL do anexo é reescrita para o endereço interno do Chatwoot; legenda no primeiro |
| Reply | `content_attributes.in_reply_to` → `quoted {messageId, participant}` |
| Assinatura | Opcional: prefixa `*Nome do atendente:*` |
| Apagar | `message_updated` com `content_attributes.deleted` → `POST /message/delete` |
| Editar | `message_updated` com conteúdo diferente (mensagens enviadas por atendente) → `POST /message/edit` |
| Anti-eco | O `id` da mensagem é definido pela ponte e gravado **antes** do envio; mensagens com `source_id = WAID:…` e já mapeadas são ignoradas, evitando loop |
| Falha de envio | Cria nota privada na conversa: "⚠️ Falha ao enviar ao WhatsApp: …" |

### 2.3 Cadastro e administração (painel no manager)
| Funcionalidade | Como funciona |
|---|---|
| Ícone **Chatwoot** em cada cartão de instância | Injetado por `panel.js` na barra de ações (`/manager/instances`); verde = conectada |
| Formulário por instância | Seção **Chatwoot** (liga/desliga; ID da conta, token só na 1ª vez por conta, nome da inbox, opções: assinar, reabrir, pendente, ignorar grupos) e seção **Automação** (URL do webhook, conversão para v2, Testar) |
| Conectar | Valida o token, cria/atualiza a inbox de API (com o webhook da ponte), grava a instância e configura o webhook no evogo (`POST /instance/connect`) |
| Desconectar | Marca a instância como desativada na ponte (conversas mantidas) |
| Autenticação | A chave global do evogo (a mesma do login do manager) no cabeçalho `apikey`; a ponte compara com `EVOGO_GLOBAL_KEY` |
| Várias instâncias e contas | Uma linha por instância; token do Chatwoot guardado por conta |
| Plano B | `window.__evogoChatwoot.open("instancia")` no console do navegador |
| **Auto-recuperação do webhook** | O botão *Conectar* do manager (e reinícios) **zera o webhook** da instância no evogo. A cada 10 s a ponte compara `webhook` e `events` de `GET /instance/all` com o esperado e, se divergirem em uma instância **conectada**, reaplica via `POST /instance/connect` (`src/webhook.mjs`). Mensagens recebidas na janela de até ~10 s entre o reset e a restauração não chegam à ponte |

### 2.4 Encaminhamento para n8n / webhook (automações de IA)
| Funcionalidade | Como funciona |
|---|---|
| Webhook por instância | Campo **URL do webhook** no formulário da instância. Cada mensagem recebida é **copiada** (fire-and-forget, timeout 10 s) para essa URL; falha do n8n **nunca** afeta o Chatwoot. Funciona com ou sem Chatwoot na instância |
| Formato Evolution API v2 (padrão) | A ponte converte o evento do evogo para `messages.upsert` da v2 (`data.key.{remoteJid,fromMe,id,remoteJidAlt}`, `pushName`, `message`, `messageType`, `contextInfo`, `message.base64` nas mídias), para reaproveitar fluxos do n8n feitos para a v2 **sem alterá-los**. O corpo inclui `apikey` (token da instância), como a v2, pois fluxos costumam lê-la de `body.apikey` para chamar o envio. Edições/apagar/protocolo não são encaminhados nesse formato. Opção "raw" envia o evento original (sem `instanceToken`) |
| Botão **Testar** | Envia `{event:"evogo.test"}` à URL e mostra o HTTP/latência. Fluxos que filtram `messages.upsert` ignoram o teste |
| Envio compatível com a v2 | `POST /message/sendText/:instancia` `{number,text,delay?,quoted?}` com cabeçalho `apikey` (token da instância no evogo ou chave global). Permite que o n8n troque só o endereço dos nós de envio; a mensagem enviada é espelhada no Chatwoot como *outgoing* (via evento `IsFromMe` do evogo). Só `sendText` por enquanto |
| Mensagem da IA no Chatwoot | O evogo **não emite evento** para mensagens enviadas pela API, então a ponte cria a mensagem no Chatwoot **antes** de enviar (*outgoing*, `source_id = WAID:…`), para o recibo de entregue/lido já achar o mapeamento. Falha de envio marca a mensagem como `failed` com o motivo; falha de espelhamento não impede o envio |
| Nome do remetente da IA ("Lis") | Campo "Nome que aparece no Chatwoot nas respostas da automação". A ponte cria/reaproveita um **Agente Bot** com esse nome na conta (`GET/POST /agent_bots`) e envia a mensagem com `sender_type: "AgentBot"` + `sender_id`. Vazio = nome do dono do token. Com "Assinar mensagens" ligado, o texto enviado ao WhatsApp também recebe o prefixo `*Nome:*` (`src/sign.mjs`), como a assinatura dos agentes; no Chatwoot o conteúdo fica sem prefixo. Colunas `bot_name`/`bot_id` |
| Chatwoot e webhook independentes | `instances.chatwoot_enabled` e `forward_url`; a restauração do webhook do evogo cobre as duas |

### 2.5 Importação de histórico do WhatsApp (pareamento)
| Funcionalidade | Como funciona |
|---|---|
| Quando ocorre | Só no **pareamento do número (QR)**: o WhatsApp envia o histórico do celular em vários eventos `HistorySync`. O pedido sob demanda (`/chat/history-sync`) é aceito mas o WhatsApp **não respondeu** nos testes. Opção por instância "Importar o histórico…" + "Dias de histórico" (0 = tudo; padrão 90) |
| Assinatura de eventos | Com a opção ligada a ponte assina `HISTORY_SYNC`. Durante o pareamento (instância desconectada **com QR pendente**) a vigia (`webhookReason` em `src/webhook-rules.mjs`) restaura o webhook antes do QR ser lido, pois o botão *Conectar* do manager o apaga |
| Interpretação (`src/history-parse.mjs`) | syncType 0/2/3/6 trazem mensagens (repetidas entre si → dedupe por id); 4 = nomes (`pushnames`); `phoneNumberToLidMappings` converte conversas `@lid` em número; mensagens vazias (só carcaça), grupos (opção), status e chats de sistema (`0@s.whatsapp.net`) são descartados. Mídia vem só como referência → aviso (`📷 Imagem`, `🎤 Áudio`, `📄 arquivo`) + legenda |
| Execução (`src/history.mjs`) | Acumula os pedaços e importa 25 s depois do último. Por conversa, em ordem cronológica: contato/conversa (`ensureConversation`) → mensagens **pela API** (`source_id WAID:…`, reply quando a original foi importada) → `saveMsg` com `wa_ts`. Idempotente (pula o que já está na conversa) |
| Datas originais (`src/chatwoot-db.mjs`) | A API do Chatwoot **não permite** `created_at` e o painel ignora `external_created_at`. Após criar, a ponte corrige **só** `created_at/updated_at` das mensagens recém-criadas (por id, `source_id WAID:%`, mesma conta/inbox) e `created_at/last_activity_at` da conversa, numa transação; conversas **novas** ficam `resolvidas` (as já existentes não mudam de status). Exige `CHATWOOT_DB_URL` (Postgres do Chatwoot) |
| Limite de enxurrada | O Chatwoot recusa >200 mensagens/minuto por conversa (`CONVERSATION_MESSAGE_PER_MINUTE_LIMIT`). As datas são corrigidas em **lotes de 50**, então nunca se atinge o limite; há ainda retry se ocorrer. Um `finally` sempre corrige o que foi criado, mesmo em falha |
| Efeitos colaterais evitados | Não passa pelo encaminhamento ao n8n; mensagens importadas têm `source_id WAID:` (ignoradas pelo webhook de saída); conversas importadas resolvidas não enchem a caixa. Relatórios/SLA do Chatwoot dessas conversas ficam imprecisos (eventos criados na data da importação) |
| Acompanhamento | Tabela `history_imports`; o painel mostra a última importação (conversas/mensagens/falhas). `POST /admin/history-replay {instance, dry?, only?, days?}` reprocessa as amostras guardadas (`event_samples`, só gravadas com `DEBUG=1`) — `dry:true` mostra o plano sem gravar |
| Troca de conta/inbox | Limpa o cache de conversas e os vínculos de mensagens da instância (ids de conversa são **por conta**; sem isso a ponte mandava mensagens para conversas da conta anterior) |

### 2.6 Pendente / não implementado
- Importar **mídia** do histórico (hoje vira aviso; o evogo entrega só a referência, seria preciso baixar com `/message/downloadmedia`), grupos e reações do histórico.
- Reações e atualização do nome do contato/grupo (o nome é lido só na criação). Grupos: sem menção/@ de participantes, sem histórico de grupos.
- Tentar de novo mensagens que o Chatwoot marcou "Falha ao enviar".

## 3. Contrato com o Evolution Go (v0.7.3)

Webhook (POST JSON) por instância, configurado via `POST /instance/connect {webhookUrl, subscribe[], immediate}`:
```
{ "event": "Message", "instanceName", "instanceToken",
  "data": { "Info": { ID, Chat, Sender, SenderAlt, IsFromMe, IsGroup, PushName, Type, MediaType, Edit, Timestamp },
            "Message": { conversation | extendedTextMessage | imageMessage | audioMessage | documentMessage | stickerMessage |
                         protocolMessage | secretEncryptedMessage ... , "base64"?, "messageContextInfo": { "messageSecret" } } } }
```
Chamadas usadas pela ponte (cabeçalho `apikey`): `POST /send/text`, `/send/media`, `/message/edit {chat,messageId,message}`, `/message/delete {chat,messageId}`, `/instance/connect`, `GET /instance/all` (chave global). Documentação viva: `http://<container>:8080/swagger/doc.json`.

Decriptação de edição (`src/edit-crypto.mjs`): chave = HKDF-SHA256(`messageSecret` da original, salt vazio, info = `idOriginal + jidRemetente + jidEditor + "Message Edit"`), JIDs no formato **LID**; AES-256-GCM, IV = `encIV`, tag = últimos 16 bytes de `encPayload`, sem AAD. Texto em `Message.protocolMessage(12).editedMessage(14)`.

## 4. Contrato com o Chatwoot (API v1, `api_access_token`)
Inbox de API (`POST /inboxes`, `PATCH /inboxes/:id` só com `channel.webhook_url`), contatos (`search`, `create`, `contact_inboxes`), conversas (`create`, `GET /contacts/:id/conversations`), mensagens (`POST`, multipart para anexos, `DELETE`). `source_id = "WAID:<id do WhatsApp>"` marca mensagens espelhadas.

**Restrição:** o Chatwoot 4.x bloqueia webhooks para IPs privados, então a ponte precisa de **domínio público HTTPS** (alternativa: `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true`, que desliga a proteção SSRF).

## 5. Dados (schema `evogo_bridge` no Postgres)
`instances` (config por instância: Chatwoot e encaminhamento), `accounts` (token do Chatwoot por conta), `conversations` (chat ↔ conversa), `messages` (id WhatsApp ↔ id Chatwoot, `messageSecret`, conteúdo). O schema é criado/migrado na inicialização (`src/schema.sql`).

## 6. Variáveis de ambiente da ponte
`DATABASE_URL`, `CHATWOOT_DB_URL` (só para as datas da importação), `WEBHOOK_SECRET`, `EVOGO_URL`, `CHATWOOT_URL`, `BRIDGE_URL` (pública), `EVOGO_WEBHOOK_BASE` (interna), `EVOGO_GLOBAL_KEY`, `PORT`, `DEBUG`. Nenhum valor secreto vai dentro das imagens.

## 7. Mapa do código
`src/index.mjs` (webhooks, entrada/saída) · `src/admin.mjs` (API do painel) · `src/panel.js` (UI no manager) · `src/chatwoot.mjs` e `src/evogo.mjs` (clientes) · `src/inbox.mjs` · `src/db.mjs` + `src/schema.sql` · `src/edit-crypto.mjs` + `src/pb.mjs` · `test/` (teste da decriptação).
