import { config } from './config.mjs';
const w = (lvl, msg, extra) => console.log(JSON.stringify({ t: new Date().toISOString(), lvl, msg, ...extra }));
export const log = {
  info: (m, e) => w('info', m, e),
  warn: (m, e) => w('warn', m, e),
  error: (m, e) => w('error', m, e),
  debug: (m, e) => config.debug && w('debug', m, e),
};
