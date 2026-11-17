// Interpretação do histórico enviado pelo WhatsApp no pareamento (evento HistorySync do evogo). Código puro (sem rede/banco).
// Estrutura: data.Data = { syncType, conversations:[{ID, messages:[{message:{key:{ID,fromMe,remoteJID}, message:{...}, messageTimestamp}, msgOrderID}]}],
//            phoneNumberToLidMappings:[{pnJID,lidJID}], pushnames:[{ID,pushname}] }
// syncType: 0 INITIAL_BOOTSTRAP, 1 INITIAL_STATUS_V3, 2 FULL, 3 RECENT, 4 PUSH_NAME, 5 NON_BLOCKING_DATA, 6 ON_DEMAND.
// Os tipos 0, 2 e 3 repetem o mesmo histórico: deduplicamos pelo id da mensagem.
const SYNC_WITH_MESSAGES = new Set([0, 2, 3, 6]);

export function newSession() { return { lid2pn: new Map(), names: new Map(), chats: new Map(), events: 0 }; }

export function ingest(session, body) {
  const D = body?.data?.Data ?? body?.Data ?? body ?? {};
  session.events++;
  for (const m of D.phoneNumberToLidMappings ?? []) if (m.lidJID && m.pnJID) session.lid2pn.set(m.lidJID, m.pnJID);
  for (const p of D.pushnames ?? []) if (p.ID && p.pushname) session.names.set(p.ID, p.pushname);
  if (!SYNC_WITH_MESSAGES.has(Number(D.syncType))) return;
  for (const c of D.conversations ?? []) {
    const jid = String(c.ID ?? '');
    if (!jid) continue;
    let chat = session.chats.get(jid);
    if (!chat) session.chats.set(jid, (chat = new Map()));
    for (const it of c.messages ?? []) {
      const wm = it.message ?? {};
      const id = wm.key?.ID;
      if (!id || chat.has(id)) continue;
      chat.set(id, { id, fromMe: !!wm.key.fromMe, ts: Number(wm.messageTimestamp) || 0, order: Number(it.msgOrderID) || 0, message: wm.message ?? {} });
    }
  }
}

// remove camadas "embrulho" (efêmera, visualização única, documento com legenda)
function unwrap(m) {
  let cur = m ?? {};
  for (let i = 0; i < 5; i++) {
    const inner = cur.ephemeralMessage?.message ?? cur.viewOnceMessage?.message ?? cur.viewOnceMessageV2?.message ?? cur.documentWithCaptionMessage?.message;
    if (!inner) break;
    cur = inner;
  }
  return cur;
}

// Texto para o Chatwoot. Mídia vem só como referência (sem o arquivo), então vira um aviso + legenda. null = ignorar a mensagem.
export function textOf(raw) {
  const m = unwrap(raw);
  const cap = (label, c) => (c ? `${label}\n${c}` : label);
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return cap('📷 Imagem', m.imageMessage.caption);
  if (m.videoMessage) return cap('🎥 Vídeo', m.videoMessage.caption);
  if (m.audioMessage) return '🎤 Áudio';
  if (m.documentMessage) return cap(`📄 ${m.documentMessage.fileName || 'Documento'}`, m.documentMessage.caption);
  if (m.stickerMessage) return '🏷️ Sticker';
  if (m.contactMessage) return `👤 Contato: ${m.contactMessage.displayName || ''}`.trim();
  if (m.locationMessage) return '📍 Localização';
  if (m.pollCreationMessage) return `📊 Enquete: ${m.pollCreationMessage.name || ''}`.trim();
  const interactive = m.listMessage?.description || m.listMessage?.title || m.buttonsMessage?.contentText || m.interactiveMessage?.body?.text
    || m.templateMessage?.hydratedTemplate?.hydratedContentText || m.templateMessage?.hydratedFourRowTemplate?.hydratedContentText;
  if (interactive) return interactive;
  if (m.listMessage || m.buttonsMessage || m.interactiveMessage || m.templateMessage) return '[mensagem interativa]';
  const reply = m.listResponseMessage?.title || m.buttonsResponseMessage?.selectedDisplayText || m.templateButtonReplyMessage?.selectedDisplayText;
  if (reply) return reply;
  return null; // protocolMessage, reação, chaves de grupo, etc.
}

export const replyIdOf = (raw) => {
  const m = unwrap(raw);
  return m.extendedTextMessage?.contextInfo?.stanzaID || m.imageMessage?.contextInfo?.stanzaID || m.videoMessage?.contextInfo?.stanzaID
    || m.documentMessage?.contextInfo?.stanzaID || m.audioMessage?.contextInfo?.stanzaID || null;
};

// Plano de importação: conversas individuais (por número), mensagens deduplicadas, ordenadas, dentro da janela de dias.
export function buildPlan(session, { ignoreGroups = true, days = 0, now = Date.now() } = {}) {
  const cutoff = days > 0 ? Math.floor(now / 1000) - days * 86400 : 0;
  const stats = { chats: 0, messages: 0, skipped: { grupo: 0, semTelefone: 0, outros: 0, vazias: 0, antigas: 0 } };
  const byKey = new Map();
  for (const [jid, map] of session.chats) {
    let chatKey = jid;
    if (jid.endsWith('@g.us')) { if (ignoreGroups) { stats.skipped.grupo += map.size; continue; } }
    else if (jid.endsWith('@lid')) {
      chatKey = session.lid2pn.get(jid);
      if (!chatKey) { stats.skipped.semTelefone += map.size; continue; }
    } else if (!jid.endsWith('@s.whatsapp.net') || jid.split('@')[0].replace(/\D/g, '').length < 8) { stats.skipped.outros += map.size; continue; } // status, newsletters e chats de sistema (ex.: 0@s.whatsapp.net)
    if (chatKey.split('@')[0].replace(/\D/g, '').length < 8 && !chatKey.endsWith('@g.us')) { stats.skipped.outros += map.size; continue; }
    let acc = byKey.get(chatKey);
    if (!acc) byKey.set(chatKey, (acc = new Map()));
    for (const [id, it] of map) if (!acc.has(id)) acc.set(id, it);
  }
  const chats = [];
  for (const [chatKey, map] of byKey) {
    const messages = [];
    for (const it of map.values()) {
      if (cutoff && it.ts < cutoff) { stats.skipped.antigas++; continue; }
      const content = textOf(it.message);
      if (!content) { stats.skipped.vazias++; continue; }
      messages.push({ id: it.id, fromMe: it.fromMe, ts: it.ts, order: it.order, content, replyTo: replyIdOf(it.message) });
    }
    if (!messages.length) continue;
    messages.sort((a, b) => a.ts - b.ts || a.order - b.order);
    chats.push({ chatKey, name: session.names.get(chatKey) ?? null, messages });
    stats.chats++; stats.messages += messages.length;
  }
  chats.sort((a, b) => a.messages.at(-1).ts - b.messages.at(-1).ts); // mais antigas primeiro
  return { chats, stats };
}
