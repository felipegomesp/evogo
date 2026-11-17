# evogo-chatwoot

Integração **Evolution Go ⇄ Chatwoot**. O Evolution Go não tem Chatwoot nativo; este projeto adiciona:

- uma **ponte** (Node.js, só a dependência `pg`) que espelha as mensagens nos dois sentidos;
- um **painel** dentro do manager do Evolution Go (ícone *Chatwoot* em cada cartão de instância) para ligar um número a uma conta/inbox do Chatwoot sem editar banco ou arquivos.

> Projeto não oficial e sem vínculo com o Evolution Go nem com o Chatwoot. Testado com Evolution Go **0.7.3** e Chatwoot **4.19**.

## O que funciona

| WhatsApp → Chatwoot | Chatwoot → WhatsApp |
|---|---|
| texto, reply, imagem, vídeo, áudio, documento, sticker | texto, reply, anexos |
| editar e apagar mensagens (a edição chega cifrada e é decifrada pela ponte) | editar e apagar |
| mensagens enviadas do próprio celular | assinatura do atendente (opcional) |
| contato e conversa criados automaticamente (com tratamento do nono dígito) | tiques de **entregue** e **lido** |

Também: várias instâncias e várias contas do Chatwoot, e restauração automática do webhook quando o botão *Conectar* do manager o apaga.
Especificação completa em [`FEATURES.md`](FEATURES.md).

## Como funciona

```
WhatsApp ⇄ Evolution Go ──webhook──▶ ponte ──API──▶ Chatwoot
                         ◀─/send/*──       ◀─webhook (URL pública)─
```

O binário do Evolution Go **não é alterado**. O único ajuste é uma linha no `index.html` do manager que carrega o painel servido pela ponte (ver [`evogo-manager-patch/`](evogo-manager-patch)).

## Instalação rápida

1. **Banco:** um Postgres acessível pela ponte (ela cria o schema `evogo_bridge` sozinha).
2. **Ponte:** suba a imagem `felipegomesp/evogo-chatwoot-bridge` (ou faça `docker build .`) com as variáveis:

   | Variável | Para quê |
   |---|---|
   | `DATABASE_URL` | Postgres da ponte |
   | `WEBHOOK_SECRET` | segredo na URL dos webhooks (gere um valor aleatório longo) |
   | `EVOGO_URL` | endereço interno do Evolution Go, ex. `http://evogo:8080` |
   | `EVOGO_GLOBAL_KEY` | `GLOBAL_API_KEY` do Evolution Go (autentica o painel) |
   | `CHATWOOT_URL` | endereço interno do Chatwoot, ex. `http://chatwoot:3000` |
   | `BRIDGE_URL` | URL **pública HTTPS** da ponte (o Chatwoot chama por ela) |
   | `EVOGO_WEBHOOK_BASE` | endereço interno da ponte, pelo qual o Evolution Go a alcança |

3. **Domínio público para a ponte.** O Chatwoot 4.x bloqueia webhooks para IPs privados (`Hostname … has no public ip addresses`). Alternativa: `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` no Chatwoot, que desliga essa proteção.
4. **Painel no manager:** construa o Evolution Go com o patch:
   ```bash
   docker build --build-arg EVOGO_VERSION=0.7.3 \
     --build-arg BRIDGE_PANEL_URL=https://SEU-DOMINIO-DA-PONTE/admin/panel.js \
     -t evolution-go-chatwoot evogo-manager-patch
   ```
5. No manager, no cartão da instância, clique no ícone **Chatwoot**, informe o ID da conta e o token de acesso do Chatwoot e conecte.

## Atualizando o Evolution Go

Siga [`UPGRADE-EVOGO.md`](UPGRADE-EVOGO.md): passo a passo, rollback, checklist de verificação e tabela do que costuma quebrar.

## Pendente

Importar histórico do WhatsApp, grupos, reações e marcar como lido no celular ao abrir a conversa no Chatwoot.

## Licença e atribuição

O código deste repositório está sob a licença [Apache License 2.0](LICENSE) (veja também o [NOTICE](NOTICE)), a mesma do Evolution Go.

O **Evolution Go** é licenciado sob **Apache License 2.0**, com condições adicionais: ao usar o painel Manager, não é permitido remover ou alterar os logotipos e as informações de direitos autorais originais; um *rebranding* completo exige licença comercial da empresa. Este projeto **não faz nada disso**: o patch apenas **adiciona** um script e um ícone ao Manager, sem tocar em marca ou direitos autorais, e o binário não é modificado. O **Chatwoot** tem licença própria. Confira as licenças deles ao redistribuir qualquer imagem; este repositório publica apenas a receita do patch, não uma imagem do Evolution Go.
