const req = (k) => { const v = process.env[k]; if (!v) throw new Error('variável obrigatória ausente: ' + k); return v; };
export const config = {
  port: Number(process.env.PORT || 3000),
  databaseUrl: req('DATABASE_URL'),
  evogoUrl: (process.env.EVOGO_URL || 'http://evogo:8080').replace(/\/$/, ''),
  chatwootUrl: (process.env.CHATWOOT_URL || 'http://chatwoot:3000').replace(/\/$/, ''),
  // URL (interna) pela qual o Chatwoot alcança esta ponte
  bridgeUrl: (process.env.BRIDGE_URL || 'http://evogo-chatwoot:3000').replace(/\/$/, ''),
  secret: req('WEBHOOK_SECRET'),
  // chave global do Evolution Go: autentica o painel /admin e lista instâncias
  evogoGlobalKey: process.env.EVOGO_GLOBAL_KEY || '',
  // URL (interna) pela qual o evogo alcança esta ponte
  evogoWebhookBase: (process.env.EVOGO_WEBHOOK_BASE || 'http://evogo-chatwoot:3000').replace(/\/$/, ''),
  debug: process.env.DEBUG === '1',
};
