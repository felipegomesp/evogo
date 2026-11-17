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
| Ignorados | Grupos (opção), status/broadcast, newsletters, reações, protocolo interno |

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
| Formulário por instância | ID da conta, token do Chatwoot (só na 1ª vez por conta), nome da inbox, opções (assinar, reabrir, pendente, ignorar grupos) |
| Conectar | Valida o token, cria/atualiza a inbox de API (com o webhook da ponte), grava a instância e configura o webhook no evogo (`POST /instance/connect`) |
| Desconectar | Marca a instância como desativada na ponte (conversas mantidas) |
| Autenticação | A chave global do evogo (a mesma do login do manager) no cabeçalho `apikey`; a ponte compara com `EVOGO_GLOBAL_KEY` |
| Várias instâncias e contas | Uma linha por instância; token do Chatwoot guardado por conta |
| Plano B | `window.__evogoChatwoot.open("instancia")` no console do navegador |
| **Auto-recuperação do webhook** | O botão *Conectar* do manager (e reinícios) **zera o webhook** da instância no evogo. A cada 10 s a ponte compara `webhook` e `events` de `GET /instance/all` com o esperado e, se divergirem em uma instância **conectada**, reaplica via `POST /instance/connect` (`src/webhook.mjs`). Mensagens recebidas na janela de até ~10 s entre o reset e a restauração não chegam à ponte |

### 2.4 Pendente / não implementado
- **Importar histórico** (opção desativada no painel): usar o evento `HISTORY_SYNC` do evogo, que só ocorre no pareamento. Falta capturar payload e implementar.
- Grupos, reações, atualização do nome do contato.
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
`instances` (config por instância), `accounts` (token do Chatwoot por conta), `conversations` (chat ↔ conversa), `messages` (id WhatsApp ↔ id Chatwoot, `messageSecret`, conteúdo). O schema é criado/migrado na inicialização (`src/schema.sql`).

## 6. Variáveis de ambiente da ponte
`DATABASE_URL`, `WEBHOOK_SECRET`, `EVOGO_URL`, `CHATWOOT_URL`, `BRIDGE_URL` (pública), `EVOGO_WEBHOOK_BASE` (interna), `EVOGO_GLOBAL_KEY`, `PORT`, `DEBUG`. Nenhum valor secreto vai dentro das imagens.

## 7. Mapa do código
`src/index.mjs` (webhooks, entrada/saída) · `src/admin.mjs` (API do painel) · `src/panel.js` (UI no manager) · `src/chatwoot.mjs` e `src/evogo.mjs` (clientes) · `src/inbox.mjs` · `src/db.mjs` + `src/schema.sql` · `src/edit-crypto.mjs` + `src/pb.mjs` · `test/` (teste da decriptação).
