FROM node:22-alpine
LABEL org.opencontainers.image.title="evogo-chatwoot-bridge" \
      org.opencontainers.image.description="Ponte Evolution Go <-> Chatwoot (mensagens, reply, edicao, delecao, midia) + painel de cadastro" \
      org.opencontainers.image.documentation="/app/docs/FEATURES.md"
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY src ./src
COPY FEATURES.md UPGRADE-EVOGO.md ./docs/
ENV NODE_ENV=production PORT=3000
USER node
EXPOSE 3000
CMD ["node", "src/index.mjs"]
