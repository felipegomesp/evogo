import { config } from './config.mjs';

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

export const evogo = {
  sendText: (t, { number, text, id, quoted, delay }) => call(t, 'POST', '/send/text', { number, text, id, quoted, delay, formatJid: false }),
  sendMedia: (t, { number, url, type, caption, filename, id, quoted }) =>
    call(t, 'POST', '/send/media', { number, url, type, caption, filename, id, quoted, formatJid: false }),
  edit: (t, { chat, messageId, message }) => call(t, 'POST', '/message/edit', { chat, messageId, message }),
  delete: (t, { chat, messageId }) => call(t, 'POST', '/message/delete', { chat, messageId }),
  markRead: (t, { number, ids }) => call(t, 'POST', '/message/markread', { number, id: ids }),
};
