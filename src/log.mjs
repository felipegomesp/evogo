import { config } from './config.mjs';
const recent = [];
// últimos avisos/erros em memória, para a tela de visão geral (/admin/overview); o texto é cortado para não vazar payloads grandes
export const recentEvents = () => recent.slice().reverse();
const w = (lvl, msg, extra) => {
  const t = new Date().toISOString();
  if (lvl === 'warn' || lvl === 'error') {
    recent.push({ t, lvl, msg, inst: extra?.inst, err: extra?.err ? String(extra.err).slice(0, 200) : undefined });
    if (recent.length > 100) recent.shift();
  }
  console.log(JSON.stringify({ t, lvl, msg, ...extra }));
};
export const log = {
  info: (m, e) => w('info', m, e),
  warn: (m, e) => w('warn', m, e),
  error: (m, e) => w('error', m, e),
  debug: (m, e) => config.debug && w('debug', m, e),
};
