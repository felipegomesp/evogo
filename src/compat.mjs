import crypto from 'node:crypto';
import { config } from './config.mjs';
import { log } from './log.mjs';
import { db } from './db.mjs';
import { evogo } from './evogo.mjs';
import { Chatwoot } from './chatwoot.mjs';
import { ensureConversation } from './conversation.mjs';

// Endpoint compatível com a Evolution API v2:  POST /message/sendText/:instancia  { number, text, delay?, quoted? }
// Permite que fluxos do n8n feitos para a v2 troquem só o endereço. Autenticação: cabeçalho apikey
// (token da instância no evogo ou chave global).
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const newWaId = () => '3EB0' + crypto.randomBytes(14).toString('hex').toUpperCase();

export async function handleSendText(req, res, instName, readJson) {
  const send = (status, obj) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
  const inst = await db.instance(decodeURIComponent(instName || ''));
  const key = String(req.headers.apikey || '');
  const authed = inst && key && (safeEq(key, inst.evogo_token) || (config.evogoGlobalKey && safeEq(key, config.evogoGlobalKey)));
  if (!authed) return send(401, { status: 401, error: 'Unauthorized', response: { message: 'apikey inválida ou instância desconhecida' } });
  const b = await readJson(req);
  const text = String(b.text ?? '');
  const digits = String(b.number ?? '').replace(/\D/g, '');
  const jid = String(b.number ?? '').includes('@') ? String(b.number) : digits ? digits + '@s.whatsapp.net' : '';
  if (!jid || !text) return send(400, { status: 400, error: 'Bad Request', response: { message: ['number e text são obrigatórios'] } });
  const id = newWaId();
  const quotedId = b.quoted?.key?.id;
  // O evogo NÃO emite evento para mensagens enviadas pela API, então a ponte registra a mensagem no Chatwoot (antes de enviar,
  // para que o recibo de entregue/lido já encontre o mapeamento).
  let cwRef = null;
  if (inst.chatwoot_enabled && inst.inbox_id) {
    try {
      const cw = new Chatwoot(inst);
      const conv = await ensureConversation(inst, cw, jid, undefined);
      const res = await cw.createMessage(conv.cw_conversation_id, { content: text, type: 'outgoing', sourceId: 'WAID:' + id, senderBotId: inst.bot_id || undefined });
      cwRef = { cw, convId: conv.cw_conversation_id, msgId: res.id };
      await db.saveMsg({ instance: inst.name, wa_id: id, chat_jid: jid, cw_message_id: res.id, cw_conversation_id: conv.cw_conversation_id, from_me: true, content: text });
    } catch (e) { log.warn('não consegui espelhar no Chatwoot a mensagem enviada pela API', { inst: inst.name, err: e.message }); }
  }
  try {
    await evogo.sendText(inst.evogo_token, { number: jid, text, id, delay: Number(b.delay) || undefined, quoted: quotedId ? { messageId: quotedId } : undefined });
  } catch (e) {
    if (cwRef) await cwRef.cw.updateStatus(cwRef.convId, cwRef.msgId, 'failed', e.message.slice(0, 200)).catch(() => {});
    log.error('sendText (compat) falhou', { inst: inst.name, err: e.message });
    return send(502, { status: 502, error: 'Bad Gateway', response: { message: e.message.slice(0, 200) } });
  }
  log.info('sendText (compat) enviado', { inst: inst.name, wa: id });
  send(201, { key: { remoteJid: jid, fromMe: true, id }, status: 'PENDING', message: { conversation: text }, messageType: 'conversation', instanceId: inst.name });
}
