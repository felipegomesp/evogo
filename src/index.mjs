import http from 'node:http';
import crypto from 'node:crypto';
import { config } from './config.mjs';
import { log } from './log.mjs';
import { db, migrate } from './db.mjs';
import { Chatwoot } from './chatwoot.mjs';
import { evogo } from './evogo.mjs';
import { decryptEdit } from './edit-crypto.mjs';
import { ensureInbox } from './inbox.mjs';
import { handleAdmin } from './admin.mjs';
import { reconcile } from './webhook.mjs';
import { forwardEvent } from './forward.mjs';
import { ensureConversation, digits } from './conversation.mjs';
import { handleSendText } from './compat.mjs';
import { onHistoryEvent } from './history.mjs';

// ---------- util ----------
const queues = new Map();
function enqueue(key, fn) {
  const prev = queues.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); }).catch(() => {});
  return next;
}
const newWaId = () => '3EB0' + crypto.randomBytes(14).toString('hex').toUpperCase();

const MEDIA = {
  imageMessage: { ext: 'jpg' }, videoMessage: { ext: 'mp4' }, audioMessage: { ext: 'ogg' },
  documentMessage: { ext: 'bin' }, stickerMessage: { ext: 'webp' },
};
const extFromMime = (m) => ({
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'video/mp4': 'mp4', 'audio/ogg': 'ogg', 'application/pdf': 'pdf',
}[(m || '').split(';')[0]]);

// ---------- WhatsApp -> Chatwoot ----------
function extract(m) {
  const key = Object.keys(MEDIA).find((k) => m[k]);
  const ctx = (m.extendedTextMessage ?? (key && m[key]))?.contextInfo;
  const text = m.conversation ?? m.extendedTextMessage?.text ?? (key && m[key]?.caption) ?? '';
  if (key && m.base64) {
    const meta = m[key];
    const name = meta.fileName || `${key.replace('Message', '')}.${extFromMime(meta.mimetype) || MEDIA[key].ext}`;
    return { text, stanza: ctx?.stanzaID, file: { data: Buffer.from(m.base64, 'base64'), mime: meta.mimetype || 'application/octet-stream', name } };
  }
  if (text) return { text, stanza: ctx?.stanzaID, file: null };
  const k = Object.keys(m).find((x) => !['messageContextInfo', 'base64'].includes(x));
  return { text: `[mensagem não suportada: ${k ?? 'desconhecida'}]`, stanza: ctx?.stanzaID, file: null };
}

async function inbound(inst, d) {
  const I = d.Info, M = d.Message ?? {};
  const chat = I.Chat;
  if (!chat || chat.endsWith('@broadcast') || chat.endsWith('@newsletter') || I.IsNewsletterStatus) return;
  if (chat.endsWith('@g.us') && inst.ignore_groups) return;
  const pn = [I.Chat, I.Sender, I.SenderAlt, I.RecipientAlt].find((j) => j?.endsWith('@s.whatsapp.net'));
  const chatKey = chat.endsWith('@g.us') ? chat : pn ?? chat;
  const cw = new Chatwoot(inst);

  // exclusão feita no WhatsApp
  if (I.Edit === '7' || I.Edit === '8') {
    const target = M.protocolMessage?.key?.ID;
    const row = target && await db.msg(inst.name, target);
    if (row?.cw_message_id) {
      await cw.deleteMessage(row.cw_conversation_id, row.cw_message_id).catch((e) => log.warn('delete falhou', { err: e.message }));
      await db.dropMsg(inst.name, target);
      log.info('mensagem apagada no Chatwoot', { wa: target, cw: row.cw_message_id });
    }
    return;
  }

  // edição feita no WhatsApp (chega cifrada)
  if (I.Edit === '1' && M.secretEncryptedMessage) {
    const sem = M.secretEncryptedMessage;
    const row = await db.msg(inst.name, sem.targetMessageKey?.ID);
    if (!row?.secret) return log.warn('edição sem mensagem original conhecida', { target: sem.targetMessageKey?.ID });
    const text = decryptEdit({ sem, originalSecretB64: row.secret, jidCandidates: [I.SenderAlt, I.Sender, row.sender_jid] });
    if (!text) return log.warn('não foi possível decifrar a edição', { target: row.wa_id });
    const conv = await ensureConversation(inst, cw, chatKey, I.PushName);
    const res = await cw.createMessage(conv.cw_conversation_id, {
      content: `✏️ *Mensagem editada:*\n${text}`, type: I.IsFromMe ? 'outgoing' : 'incoming', sourceId: 'WAID:' + I.ID, replyTo: row.cw_message_id,
    });
    await db.saveMsg({ instance: inst.name, wa_id: I.ID, chat_jid: chatKey, cw_message_id: res.id, cw_conversation_id: conv.cw_conversation_id, from_me: I.IsFromMe });
    await db.setContent(inst.name, row.wa_id, text);
    log.info('edição espelhada', { wa: row.wa_id });
    return;
  }

  if (M.protocolMessage || M.reactionMessage || M.secretEncryptedMessage || M.senderKeyDistributionMessage) return;

  const existing = await db.msg(inst.name, I.ID);
  if (existing?.cw_message_id) return; // eco de mensagem enviada pela ponte, ou reentrega

  const ex = extract({ ...M, base64: M.base64 ?? d.base64 });
  const { file, stanza } = ex;
  // em grupo, identifica quem falou (a conversa é uma só para o grupo todo)
  const text = chat.endsWith('@g.us') && !I.IsFromMe && I.PushName ? `*${I.PushName}:*\n${ex.text}` : ex.text;
  const replyRow = stanza ? await db.msg(inst.name, stanza) : null;
  const send = (conv) => cw.createMessage(conv.cw_conversation_id, {
    content: text, type: I.IsFromMe ? 'outgoing' : 'incoming', sourceId: 'WAID:' + I.ID,
    replyTo: replyRow?.cw_message_id, files: file ? [file] : undefined,
  });

  let conv = await ensureConversation(inst, cw, chatKey, I.IsFromMe ? undefined : I.PushName);
  let res;
  try { res = await send(conv); }
  catch (e) {
    if (e.status !== 404) throw e;
    await db.dropConv(inst.name, chatKey); // conversa apagada no Chatwoot
    conv = await ensureConversation(inst, cw, chatKey, I.PushName);
    res = await send(conv);
  }
  await db.saveMsg({
    instance: inst.name, wa_id: I.ID, chat_jid: chatKey, cw_message_id: res.id, cw_conversation_id: conv.cw_conversation_id,
    from_me: I.IsFromMe, sender_jid: I.Sender, secret: M.messageContextInfo?.messageSecret, content: text,
  });
  log.info('WhatsApp -> Chatwoot', { inst: inst.name, wa: I.ID, cw: res.id, media: !!file });
}

// ---------- recibos (entregue / lido) ----------
const RANK = { sent: 1, delivered: 2, read: 3 };
const seenReceiptShapes = new Set();
async function receipt(inst, d) {
  const ids = d.MessageIDs ?? d.MessageIds ?? d.messageIDs ?? d.messageIds ?? [];
  const type = String(d.Type ?? d.type ?? '');
  const shape = type + ':' + Object.keys(d).sort().join(',');
  if (!seenReceiptShapes.has(shape)) { seenReceiptShapes.add(shape); log.info('formato de recibo (amostra)', { type, campos: Object.keys(d), ids: ids.length }); }
  const status = type === '' || type === 'delivered' ? 'delivered' : type === 'read' || type === 'played' ? 'read' : null;
  if (!status || !Array.isArray(ids) || !ids.length) return;
  const cw = new Chatwoot(inst);
  let n = 0;
  for (const id of ids) {
    const row = await db.msg(inst.name, id);
    if (!row?.from_me || !row.cw_message_id) continue;
    if ((RANK[row.wa_status] ?? 0) >= RANK[status]) continue; // nunca rebaixa (lido -> entregue)
    try {
      await cw.updateStatus(row.cw_conversation_id, row.cw_message_id, status);
      await db.setStatus(inst.name, id, status);
      n++;
    } catch (e) { log.warn('não consegui atualizar status', { err: e.message }); }
  }
  if (n) log.info('recibo espelhado', { inst: inst.name, status, mensagens: n });
}

// ---------- Chatwoot -> WhatsApp ----------
const attType = { image: 'image', video: 'video', audio: 'audio', file: 'document' };
const internalUrl = (u) => { try { const x = new URL(u); return config.chatwootUrl + x.pathname + x.search; } catch { return u; } };

function sign(inst, b, text) {
  const name = b.sender?.available_name || b.sender?.name;
  return inst.sign_msg && name ? `*${name}:*\n${text}` : text;
}

async function outbound(inst, b) {
  if (b.account?.id !== undefined && b.account.id !== inst.account_id) return;
  const sourceId = b.source_id || '';
  const mapped = b.id ? await db.msgByCw(inst.name, b.id) : null;

  if (b.event === 'message_updated') {
    if (!mapped?.from_me || sourceId.startsWith('WAID:')) return;
    if (b.content_attributes?.deleted) {
      await evogo.delete(inst.evogo_token, { chat: mapped.chat_jid, messageId: mapped.wa_id });
      log.info('apagado no WhatsApp', { wa: mapped.wa_id });
    } else if (b.content != null && b.content !== mapped.content && !b.attachments?.length) {
      await evogo.edit(inst.evogo_token, { chat: mapped.chat_jid, messageId: mapped.wa_id, message: sign(inst, b, b.content) });
      await db.setContent(inst.name, mapped.wa_id, b.content);
      log.info('editado no WhatsApp', { wa: mapped.wa_id });
    }
    return;
  }

  if (b.event !== 'message_created' || b.message_type !== 'outgoing' || b.private) return;
  if (sourceId.startsWith('WAID:') || mapped) return; // mensagem espelhada por nós: evita loop

  const cwConv = b.conversation?.id;
  let chat = (await db.convByCw(inst.name, cwConv))?.chat_jid;
  if (!chat) {
    const ph = digits(b.conversation?.meta?.sender?.phone_number);
    if (!ph) return log.warn('conversa sem telefone', { conv: cwConv });
    chat = ph + '@s.whatsapp.net';
  }
  let quoted;
  const replyId = b.content_attributes?.in_reply_to;
  if (replyId) {
    const q = await db.msgByCw(inst.name, replyId);
    if (q) quoted = { messageId: q.wa_id, participant: q.from_me ? undefined : q.sender_jid };
  }

  const atts = b.attachments ?? [];
  const parts = atts.length ? atts : [null];
  for (const [i, a] of parts.entries()) {
    const id = newWaId();
    const content = i === 0 ? (b.content ?? '') : '';
    await db.saveMsg({ instance: inst.name, wa_id: id, chat_jid: chat, cw_message_id: i === 0 ? b.id : null, cw_conversation_id: cwConv, from_me: true, content });
    try {
      if (!a) {
        await evogo.sendText(inst.evogo_token, { number: chat, text: sign(inst, b, content), id, quoted });
      } else {
        await evogo.sendMedia(inst.evogo_token, {
          number: chat, url: internalUrl(a.data_url), type: attType[a.file_type] ?? 'document',
          caption: content ? sign(inst, b, content) : undefined,
          filename: decodeURIComponent(new URL(a.data_url).pathname.split('/').pop() || 'arquivo'), id, quoted: i === 0 ? quoted : undefined,
        });
      }
    } catch (e) {
      await db.dropMsg(inst.name, id);
      log.error('falha ao enviar ao WhatsApp', { err: e.message });
      await new Chatwoot(inst).createMessage(cwConv, { content: '⚠️ Falha ao enviar ao WhatsApp: ' + e.message.slice(0, 200), type: 'outgoing', isPrivate: true }).catch(() => {});
      return;
    }
  }
  log.info('Chatwoot -> WhatsApp', { inst: inst.name, cw: b.id, files: atts.length });
}

// ---------- HTTP ----------
async function readJson(req) {
  const chunks = []; let n = 0;
  for await (const c of req) {
    n += c.length;
    if (n > 256 * 1024 * 1024) throw new Error('payload grande demais');
    chunks.push(c);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

const server = http.createServer(async (req, res) => {
  const [, kind, p1, p2] = req.url.split('?')[0].split('/');
  try {
    if (kind === 'admin') { await handleAdmin(req, res, p1, readJson); return; }
    if (kind === 'message' && p1 === 'sendText' && req.method === 'POST') { await handleSendText(req, res, req.url.split('?')[0].split('/')[3], readJson); return; }
    if (req.method === 'GET' && kind === 'health') { res.end('ok'); return; }
    if (req.method !== 'POST') { res.statusCode = 404; res.end(); return; }
    const secret = kind === 'evogo' ? p1 : p2;
    if (!secret || !safeEq(secret, config.secret)) { res.statusCode = 401; res.end(); return; }
    const body = await readJson(req);
    res.end('ok'); // responde já; processa em fila por conversa
    if (kind === 'evogo') {
      const inst = await db.instance(body.instanceName);
      if (!inst) return;
      if (body.event !== 'Message' && body.event !== 'Receipt') {
        // histórico do WhatsApp (chega no pareamento): acumula e importa quando parar de chegar
        if (inst.import_history && body.event === 'HistorySync') {
          log.info('histórico recebido', { inst: inst.name });
          onHistoryEvent(inst, body);
          if (config.debug) db.saveSample(inst.name, 'HistorySync', JSON.stringify(body).length, body).catch((e) => log.warn('amostra não gravada', { err: e.message }));
        }
        return;
      }
      if (inst.forward_url) forwardEvent(inst, body); // cópia para o n8n/webhook; não bloqueia o Chatwoot
      if (!inst.chatwoot_enabled || !inst.inbox_id) return;
      const isReceipt = body.event === 'Receipt';
      const chat = (isReceipt ? body.data?.Chat : body.data?.Info?.Chat) ?? 'x';
      enqueue(`${inst.name}|${chat}`, () => (isReceipt ? receipt(inst, body.data) : inbound(inst, body.data)))
        .catch((e) => log.error('inbound falhou', { err: e.message, stack: config.debug ? e.stack : undefined }));
    } else if (kind === 'chatwoot') {
      const inst = await db.instance(p1);
      if (!inst?.chatwoot_enabled) return;
      enqueue(`${inst.name}|cw${body.conversation?.id}`, () => outbound(inst, body))
        .catch((e) => log.error('outbound falhou', { err: e.message }));
    }
  } catch (e) {
    log.error('requisição inválida', { err: e.message });
    if (!res.headersSent) { res.statusCode = 400; res.end(); }
  }
});

await migrate();
for (const inst of (await db.instances()).filter((i) => i.chatwoot_enabled && i.account_id)) {
  await ensureInbox(inst).catch((e) => log.error('ensureInbox falhou', { inst: inst.name, err: e.message }));
}
server.listen(config.port, () => log.info('evogo-chatwoot no ar', { port: config.port }));
setTimeout(reconcile, 3000);
setInterval(reconcile, 10_000); // restaura o webhook se o manager/reinício o apagar
