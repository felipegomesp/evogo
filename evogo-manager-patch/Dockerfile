# Evolution Go + botão "Chatwoot" no manager.
# Única alteração: 1 linha em /app/manager/dist/index.html que carrega o painel servido pela ponte.
# Para atualizar o Evolution Go: troque EVOGO_VERSION e reimplante (ver UPGRADE-EVOGO.md).
ARG EVOGO_VERSION=0.7.3
FROM evoapicloud/evolution-go:${EVOGO_VERSION}
LABEL org.opencontainers.image.title="evolution-go-chatwoot" \
      org.opencontainers.image.description="Evolution Go + botao Chatwoot no manager (patch de 1 linha no index.html)"
ARG BRIDGE_PANEL_URL=https://bridge.example.com/admin/panel.js
COPY CHATWOOT-PATCH.md /app/CHATWOOT-PATCH.md
RUN set -e; f=/app/manager/dist/index.html; \
    grep -q '</head>' "$f" || { echo "ERRO: index.html do manager mudou (sem </head>); revisar o patch"; exit 1; }; \
    sed -i "s#</head>#<script defer src=\"${BRIDGE_PANEL_URL}\"></script></head>#" "$f"; \
    grep -q 'admin/panel.js' "$f" || { echo "ERRO: patch nao aplicado"; exit 1; }; \
    echo "patch do manager aplicado"
