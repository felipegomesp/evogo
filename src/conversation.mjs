import { db } from './db.mjs';
import { evogo } from './evogo.mjs';
import { log } from './log.mjs';

export const digits = (jid) => (jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');

// variações do nono dígito brasileiro (55 + DDD + 9 + 8 dígitos)
function phoneVariants(p) {
  const out = new Set([p]);
  if (p.startsWith('55')) {
    if (p.length === 13 && p[4] === '9') out.add(p.slice(0, 4) + p.slice(5));
    if (p.length === 12) out.add(p.slice(0, 4) + '9' + p.slice(4));
  }
  return [...out];
}


// Grupo: o JID (1203...@g.us) não é telefone (o Chatwoot recusa: "e164"), então o contato
// é identificado pelo JID, sem phone_number. Nome do grupo vem do evogo (best-effort).
async function groupName(inst, jid) {
  try {
    const r = await evogo.groupInfo(inst.evogo_token, jid);
    const d = r?.data ?? r;
    return d?.Name || d?.name || d?.Subject || d?.subject || null;
  } catch (e) { log.warn('nome do grupo indisponível', { err: e.message }); return null; }
}

async function findOrCreateGroupContact(inst, cw, jid) {
  const found = (await cw.searchContact(jid)).find((c) => c.identifier === jid);
  if (found) return found;
  const name = await groupName(inst, jid);
  return cw.createContact({ inbox_id: inst.inbox_id, name: name ? `${name} (GROUP)` : `${digits(jid)} (GROUP)`, identifier: jid });
}

export async function ensureConversation(inst, cw, chatJid, pushName) {
  const cached = await db.conv(inst.name, chatJid);
  if (cached) return cached;
  const isGroup = chatJid.endsWith('@g.us');
  const phone = digits(chatJid);
  const variants = phoneVariants(phone);

  let contact;
  if (isGroup) contact = await findOrCreateGroupContact(inst, cw, chatJid);
  else {
    for (const v of variants) {
      const found = (await cw.searchContact(v)).find((c) => variants.includes(digits(c.phone_number)));
      if (found) { contact = found; break; }
    }
    if (!contact) {
      contact = await cw.createContact({ inbox_id: inst.inbox_id, name: pushName || '+' + phone, phone_number: '+' + phone, identifier: phone });
    }
  }
  let full = await cw.getContact(contact.id);
  let ci = (full.contact_inboxes || []).find((x) => x.inbox?.id === inst.inbox_id);
  if (!ci) {
    await cw.createContactInbox(contact.id);
    full = await cw.getContact(contact.id);
    ci = (full.contact_inboxes || []).find((x) => x.inbox?.id === inst.inbox_id);
  }

  const convs = (await cw.listConversations(contact.id)).filter((c) => c.inbox_id === inst.inbox_id).sort((a, b) => b.id - a.id);
  let conv = convs.find((c) => c.status !== 'resolved') ?? (inst.reopen_conversation ? convs[0] : undefined);
  let created = false;
  if (!conv) {
    created = true;
    conv = await cw.createConversation({
      source_id: ci.source_id, inbox_id: inst.inbox_id, contact_id: contact.id, status: inst.conversation_pending ? 'pending' : 'open',
    });
  }
  await db.saveConv(inst.name, chatJid, contact.id, conv.id);
  return { instance: inst.name, chat_jid: chatJid, contact_id: contact.id, cw_conversation_id: conv.id, created };
}

