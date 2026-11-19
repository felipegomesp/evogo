import { config } from './config.mjs';
import { log } from './log.mjs';

async function call(token, method, path, body) {
  const res = await fetch(config.evogoUrl + path, {
    method,
    headers: { apikey: token, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`evogo ${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return text; }
}

// O /user/check do evogo erra para algumas contas (só resolvidas por LID): devolve IsInWhatsapp=false e o envio
// falha com "not registered". O envio direto ao LID funciona; então, nesse erro, reenvia para o LID do contato.
async function withLidFallback(t, number, send) {
  try { return await send(number); } catch (e) {
    if (!/not registered on WhatsApp/i.test(e.message) || !number.endsWith('@s.whatsapp.net')) throw e;
    let lid;
    try { lid = (await call(t, 'POST', '/user/check', { number: [number], formatJid: false }))?.data?.Users?.[0]?.LID; } catch { /* sem LID */ }
    if (!lid) throw e;
    log.info('reenviando pelo LID (verificação do evogo falhou)', { lid });
    return send(lid);
  }
}

export const evogo = {
  sendText: (t, { number, text, id, quoted, delay }) =>
    withLidFallback(t, number, (n) => call(t, 'POST', '/send/text', { number: n, text, id, quoted, delay, formatJid: false })),
  sendMedia: (t, { number, url, type, caption, filename, id, quoted }) =>
    withLidFallback(t, number, (n) => call(t, 'POST', '/send/media', { number: n, url, type, caption, filename, id, quoted, formatJid: false })),
  edit: (t, { chat, messageId, message }) => call(t, 'POST', '/message/edit', { chat, messageId, message }),
  delete: (t, { chat, messageId }) => call(t, 'POST', '/message/delete', { chat, messageId }),
  groupInfo: (t, jid) => call(t, 'POST', '/group/info', { groupJid: jid }),
  markRead: (t, { number, ids }) => call(t, 'POST', '/message/markread', { number, id: ids }),
};
