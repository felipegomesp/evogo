# Evolution Go + Chatwoot: guia de manutenção e atualização

Este guia explica o que foi customizado, e como refazer as alterações **sempre que o Evolution Go for atualizado**.
Não há segredos neste arquivo. Eles ficam em `./.env` (chmod 600) e nas variáveis dos serviços no Easypanel.

> Os nomes de serviço, domínios e caminhos deste guia (`evogo`, `chatwoot`, `bridge.example.com`, projeto `n8n`) são exemplos: troque pelos do seu ambiente.

## 1. Visão geral

```
WhatsApp ⇄ Evolution Go (evogo) ──webhook──▶ Ponte (evogo-chatwoot) ──API──▶ Chatwoot (chatwoot)
                                     ◀──/send/*──                          ◀─webhook (URL pública)─
```

| Peça | O que é | Onde |
|---|---|---|
| **Ponte** `evogo-chatwoot` | Serviço Node (só dependência `pg`) que espelha mensagens nos dois sentidos | Código: `./src` · Serviço Easypanel: projeto `n8n`, serviço `evogo-chatwoot` |
| **Patch do manager** | Imagem derivada do Evolution Go com **1 linha** no `index.html` do manager, que carrega o painel (botão "Chatwoot") | `./evogo-manager-patch/Dockerfile` · Serviço Easypanel: `evogo` (origem *upload* + Dockerfile) |
| **Painel** | JS servido pela ponte (`/admin/panel.js`); coloca um ícone Chatwoot na barra de cada cartão de instância e autentica com a chave global que o manager já guarda | `src/panel.js` |
| **Banco da ponte** | Schema `evogo_bridge` no Postgres `n8n` (`instances`, `accounts`, `conversations`, `messages`) | container `postgres` |

URLs (domínio padrão do Easypanel):
- Manager: `https://evogo.example.com/manager`
- Ponte: `https://bridge.example.com` (`/health`, `/admin/panel.js`, `/admin/*`)

**Por que a ponte tem domínio público:** o Chatwoot 4.x bloqueia webhooks para IPs internos (erro
`Hostname ... has no public ip addresses`). A alternativa seria `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` no Chatwoot (desliga a proteção SSRF e reinicia a produção); preferimos o domínio público.

## 2. O que foi alterado no Evolution Go (e só isso)

**Apenas um arquivo da imagem:** `/app/manager/dist/index.html`. O `sed` insere, antes de `</head>`:

```html
<script defer src="https://bridge.example.com/admin/panel.js"></script>
```

O **binário (`/app/server`) não é alterado**. Não há código do evogo para recompilar.
O nome dos arquivos em `assets/` (hash do Vite) muda a cada versão, mas o patch não depende deles.

## 3. Como atualizar o Evolution Go (passo a passo)

1. **Ler as notas da versão nova** e conferir se mudaram: formato do webhook (`event: "Message"`, `data.Info`, `data.Message`, campo `base64`), endpoints `/send/text`, `/send/media`, `/message/edit`, `/message/delete`, `/instance/connect`, `/instance/all`, e o `index.html` do manager.
2. **Testar o patch localmente** (não afeta produção):
   ```bash
   cd ./evogo-manager-patch
   docker build --build-arg EVOGO_VERSION=<NOVA_VERSAO> -t evogo-custom:test .
   docker run --rm --entrypoint cat evogo-custom:test /app/manager/dist/index.html | grep panel.js
   ```
   O Dockerfile **falha o build** se o `index.html` não tiver mais `</head>` ou se o patch não pegar. Nesse caso, ajuste o `sed` (ver §6).
3. **Trocar a versão no Dockerfile:** editar `ARG EVOGO_VERSION=` em `evogo-manager-patch/Dockerfile`.
4. **Reimplantar o serviço `evogo` no Easypanel** (via API; `EP_TOKEN` = token de API gerado em Settings → Users; não salve em arquivo):
   ```bash
   cd ./evogo-manager-patch
   A="Authorization: Bearer $EP_TOKEN"; U=http://127.0.0.1:3000/api
   tar czf /etc/easypanel/evogo-patch-src.tgz Dockerfile
   curl -s -X POST -H "$A" -H 'Content-Type: application/json' \
     -d '{"projectName":"n8n","serviceName":"evogo","archivePath":"/etc/easypanel/evogo-patch-src.tgz"}' $U/uploadAppCodeArchive
   curl -s -X POST -H "$A" -H 'Content-Type: application/json' \
     -d '{"projectName":"n8n","serviceName":"evogo"}' $U/deployAppService
   ```
   (Alternativa: Easypanel → serviço `evogo` → Source → enviar o Dockerfile → Deploy.)
5. **Verificar** (checklist do §5).

### Reverter para o evogo original (rollback)

Easypanel → serviço `evogo` → Source → *Image* → `evoapicloud/evolution-go:<versão>` → Deploy. Ou via API:

```bash
curl -s -X POST -H "$A" -H 'Content-Type: application/json' \
  -d '{"projectName":"n8n","serviceName":"evogo","image":"evoapicloud/evolution-go:0.7.3"}' $U/updateAppSourceImage
curl -s -X POST -H "$A" -H 'Content-Type: application/json' -d '{"projectName":"n8n","serviceName":"evogo"}' $U/deployAppService
```

A ponte continua funcionando sem o patch; só some o botão no manager (a configuração por SQL/API continua possível).

## 4. Como atualizar a ponte

```bash
cd . && node --test test/            # teste da decriptação de edição
tar czf /etc/easypanel/evogo-chatwoot-src.tgz --exclude=.env --exclude=node_modules --exclude=test --exclude=evogo-manager-patch -C . .
# mesmos 2 comandos do passo 4 acima, com "serviceName":"evogo-chatwoot"
```

Variáveis da ponte (definidas no Easypanel; fonte local `./.env`):
`DATABASE_URL`, `WEBHOOK_SECRET`, `EVOGO_URL`, `CHATWOOT_URL`, `BRIDGE_URL` (pública), `EVOGO_WEBHOOK_BASE` (interna), `EVOGO_GLOBAL_KEY`, `DEBUG` (opcional).
Para alterá-las: `POST /updateAppEnv` e depois `deployAppService`.

> Atenção: o Easypanel passa as variáveis também como *build args* e, em caso de erro de build, a mensagem pode **imprimir os valores**. Ao depurar, mascare a saída.

## 5. Checklist de verificação após qualquer atualização

1. `curl -s https://bridge.example.com/health` → `ok`
2. `docker exec $(docker ps -q -f name=evogo.1) cat /app/VERSION` → versão esperada; `grep -c admin/panel.js /app/manager/dist/index.html` → `1`
3. Manager (`/manager/instances`): logado, cada cartão de instância tem o ícone **Chatwoot** (verde se conectada) na barra de ações, entre "Testar botões" e as configurações; ao clicar, abre o formulário da instância.
4. Instância ainda conectada: `select name, connected, webhook is not null from instances;` no banco `evogo`.
5. **Tiques:** envie do Chatwoot, leia no celular e confira entregue/lido (procure `recibo espelhado` nos logs; `formato de recibo (amostra)` mostra os campos do evogo).
5b. **Do celular → Chatwoot:** texto, reply, imagem, áudio, PDF, sticker; editar; apagar para todos.
6. **Chatwoot → celular:** texto, reply, anexo (a conversa na inbox `<instância>-evogo`).
7. `docker service logs evogo-chatwoot --tail 30` sem `lvl":"error"` novos.
8c. **Histórico (pareamento):** com a opção ligada, desconecte (logout) e reconecte o número; confira `histórico recebido` nos logs, a linha `importação de histórico concluída` e, no Chatwoot, as datas originais. Validação: nenhuma mensagem `WAID:` importada com a data de hoje; sem duplicatas.
8b. **n8n:** no formulário da instância, clique em *Testar* (HTTP 200) e envie uma mensagem do celular; o fluxo deve receber `messages.upsert` (execuções do n8n). Envio compatível: `POST /message/sendText/<instancia>` com `apikey` deve responder 201.
8. **Webhook persistente:** simule o botão Conectar (`POST /instance/connect` com `{"immediate":true}` e o token da instância) e confirme que em ~10 s o log mostra `webhook restaurado` e o `webhook` volta ao banco.

## 6. O que quebra numa atualização (e onde mexer)

| Sintoma | Causa provável | Onde corrigir |
|---|---|---|
| Build do patch falha: "index.html do manager mudou" | Manager reestruturado | `Dockerfile` do patch: ajustar o ponto de inserção do `<script>` |
| Ícone Chatwoot não aparece nos cartões | Manager mudou o markup do cartão (barra de ações `div.border-t.opacity-0` dentro de `.group`, nome em `.flex-1.min-w-0 > p`, botão de config com classe `text-gray-500`) ou a chave do `localStorage` (`evolution-auth` → `state.apiKey`) | `cards()`/`nameOf()`/`enhance()`/`auth()` em `src/panel.js`. Plano B: no console, `window.__evogoChatwoot.open("nome-da-instancia")` |
| Mensagens do WhatsApp não chegam ao Chatwoot | Formato do webhook mudou (`data.Info`, `data.Message`, `base64`) | `inbound()`/`extract()` em `src/index.mjs`. Capture payloads reais (§7) |
| Edição aparece como "não foi possível decifrar" | WhatsApp/evogo mudou o cifrado, ou o JID usado na chave | `src/edit-crypto.mjs` (teste: `test/edit-crypto.test.mjs`) |
| Mensagens do Chatwoot não saem | Contrato de `/send/text`, `/send/media`, `quoted` mudou | `src/evogo.mjs`, `outbound()` |
| Editar/apagar a partir do Chatwoot falha | Contrato de `/message/edit` ou `/message/delete` mudou | `src/evogo.mjs` |
| n8n deixou de receber mensagens | O evogo mudou o formato do evento `Message` (quebra `toV2`), ou o `webhook` da instância foi zerado (a ponte restaura em ~10 s) | `src/forward.mjs` (`toV2`, teste em `test/forward.test.mjs`); capturar payload real (§7) |
| Resposta da IA não aparece no Chatwoot / aparece com nome do agente | Evogo não emite evento para envios por API (a ponte espelha em `src/compat.mjs`); nome vem do Agente Bot (`bot_id`); `sender_type`/`sender_id` aceitos por `Messages::MessageBuilder` do Chatwoot | `src/compat.mjs`, `Chatwoot.ensureAgentBot`/`createMessage` em `src/chatwoot.mjs`. Se o Chatwoot mudar o builder, o remetente volta ao dono do token |
| Importação de histórico não acontece / falha | Formato do `HistorySync` mudou (`data.Data.{syncType,conversations,pushnames,phoneNumberToLidMappings}`), webhook sem `HISTORY_SYNC`, `CHATWOOT_DB_URL` ausente, limite de 200 msg/min do Chatwoot, ou colunas `messages.{account_id,inbox_id,source_id,created_at}` / `conversations.{display_id,status,last_activity_at}` mudaram | `src/history-parse.mjs` (teste `test/history-parse.test.mjs`), `src/chatwoot-db.mjs`. Reprocessar: `POST /admin/history-replay` (precisa das amostras: `DEBUG=1` no pareamento) |
| Mensagens de grupo não chegam / não saem (log `POST /contacts -> 422 Phone number should be in e164 format`) | Contato de grupo criado com o JID como telefone. Corrigido na 0.3.1: grupo usa `identifier` sem `phone_number` | `ensureConversation`/`findOrCreateGroupContact` em `src/conversation.mjs`; `POST /group/info` em `src/evogo.mjs`. Confirme que *ignorar grupos* está desligado na instância |
| Anexo do Chatwoot não sai (`Invalid file format: 'text/xml; charset=utf-8'`) | O evogo faz HEAD na URL do anexo e o MinIO/S3 recusa HEAD em URL assinada para GET (403 em XML). Corrigido na 0.3.2: o evogo busca o anexo pelo proxy interno `/media/<segredo>/<url>` da ponte, que responde HEAD e GET | `mediaProxyUrl`/`serveMedia` em `src/index.mjs` |
| Envio falha com `number ...@s.whatsapp.net is not registered on WhatsApp` mas o número tem WhatsApp | `/user/check` do evogo devolve `IsInWhatsapp:false` para algumas contas (resolvidas só por LID). Corrigido na 0.3.2: a ponte reenvia para o `LID` devolvido por `/user/check` | `withLidFallback` em `src/evogo.mjs` |
| Tela `/admin/overview` vazia ou sem instâncias / botão "Ponte" some | `GET /instance/all` mudou, ou o manager mudou o `localStorage["evolution-auth"]` | `state()` em `src/admin.mjs`; `overviewLink()` em `src/panel.js` |
| Log `ensureInbox falhou ... 402 Account limit exceeded` | A conta do Chatwoot tem `limits.inboxes` baixo (tabela `accounts.limits`) ou sobrou instância apagada no evogo que ainda está na ponte (a vigia remove em ~5 min) | Aumentar o limite no Chatwoot ou remover a instância na tela `/admin/overview` |
| Painel dá erro ao conectar | `/instance/all` ou `/instance/connect` mudou | `src/admin.mjs` |
| Mensagens do celular param de chegar ao Chatwoot (saída continua) | `webhook` da instância zerado: o botão *Conectar* do manager faz `POST /instance/connect` sem webhook. A ponte restaura sozinha em ~10 s (`reconcile` em `src/webhook.mjs`) | Se persistir: ver logs da ponte (`webhook divergente`), conferir `select webhook, events from instances` no banco `evogo`, e se `GET /instance/all` ainda expõe `webhook`/`events`. Manual: painel → Salvar |

Contrato do evogo usado pela ponte (Swagger do container: `http://127.0.0.1:8080/swagger/doc.json`):
`POST /send/text` · `/send/media` (campos `number`, `id`, `quoted{messageId,participant}`, `url`, `type`, `caption`, `filename`) · `/message/edit {chat,messageId,message}` · `/message/delete {chat,messageId}` · `/instance/connect {webhookUrl,subscribe[],immediate}` · `GET /instance/all`.

## 7. Como capturar payloads reais (para ajustar o parser)

1. Subir um receptor temporário na rede `easypanel-n8n` (que apenas grava POSTs num arquivo).
2. Apontar o webhook da instância para ele: `POST /instance/connect` com `webhookUrl` e `subscribe`, usando o token da instância.
3. Enviar do celular cada tipo (texto, reply, editar, apagar, imagem, áudio, documento, sticker) e inspecionar o JSON.
4. Restaurar o webhook para `http://evogo-chatwoot:3000/evogo/<WEBHOOK_SECRET>` (ou reabrir no painel e Salvar).

Fatos já descobertos (v0.7.3): evento `Message`; `Info.Edit` = `"7"` apagar, `"1"` editar (texto novo **cifrado** em `secretEncryptedMessage`, tipo 2, chave HKDF-SHA256 de `messageSecret` com JIDs `@lid` e `"Message Edit"`, AES-256-GCM sem AAD); mídia recebida vem em `Message.base64`; reply em `contextInfo.stanzaID`; o payload inclui `instanceName` e `instanceToken`.

## 8. Lacunas conhecidas

- **Importar histórico** (opção no painel, desativada): o evento `HistorySync` existe no evogo; falta capturar payload e implementar.
- Grupos ignorados por padrão (ligue em *ignorar grupos* por instância); reações não são espelhadas. Marcar como lido no WhatsApp quando o atendente abre a conversa também não é feito.
- Edição feita a partir do Chatwoot depende de a UI do Chatwoot emitir `message_updated` com conteúdo novo.
- Mensagens `Falha ao enviar` antigas no Chatwoot (de antes de o webhook ficar público) não são reenviadas.
