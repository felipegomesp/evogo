# Patch Chatwoot no Evolution Go

Esta imagem e o Evolution Go original + 1 linha em /app/manager/dist/index.html:
  <script defer src="<BRIDGE_PANEL_URL>"></script>
O binario nao e alterado. O painel (icone Chatwoot nos cartoes de instancia) e servido pela ponte.
Documentacao completa: veja FEATURES.md e UPGRADE-EVOGO.md na imagem da ponte (/app/docs) ou no repositorio.
Para atualizar: troque EVOGO_VERSION no Dockerfile e rebuild; o build falha se o index.html mudou.
