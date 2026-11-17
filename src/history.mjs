import { log } from './log.mjs';
import { db } from './db.mjs';
import { Chatwoot } from './chatwoot.mjs';
import { ensureConversation, digits } from './conversation.mjs';
import { newSession, ingest, buildPlan } from './history-parse.mjs';
import { dbConfigured, fixTimestamps } from './chatwoot-db.mjs';

// O histórico chega em vários pedaços logo após o pareamento. Acumulamos e, quando para de chegar (QUIET_MS), importamos.
const QUIET_MS = 25_000;
const sessions = new Map(); // instância -> { session, timer }
const running = new Set();

export function onHistoryEvent(inst, body) {
  let s = sessions.get(inst.name);
  if (!s) sessions.set(inst.name, (s = { session: newSession(), timer: null }));
  ingest(s.session, body);
  clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    const cur = sessions.get(inst.name); sessions.delete(inst.name);
    runImport(inst.name, { session: cur.session }).catch((e) => log.error('importação de histórico falhou', { inst: inst.name, err: e.message }));
  }, QUIET_MS);
}

const summarize = (plan) => ({
  chats: plan.stats.chats, mensagens: plan.stats.messages, descartadas: plan.stats.skipped,
  maiores: plan.chats.map((c) => ({ final: digits(c.chatKey).slice(-4), mensagens: c.messages.length })).sort((a, b) => b.mensagens - a.mensagens).slice(0, 5),
});

// opts: { session, dry, only:[dígitos], days }
export async function runImport(instName, opts = {}) {
  const inst = await db.instance(instName);
  if (!inst) throw new Error('instância não encontrada');
  if (!inst.chatwoot_enabled || !inst.inbox_id) throw new Error('o Chatwoot precisa estar ligado nesta instância');
  if (!inst.import_history && !opts.force) throw new Error('a importação de histórico está desligada nesta instância');
  const days = Number.isInteger(opts.days) ? opts.days : inst.history_days;
  let plan = buildPlan(opts.session, { ignoreGroups: inst.ignore_groups, days });
  if (opts.only?.length) plan = { ...plan, chats: plan.chats.filter((c) => opts.only.some((o) => digits(c.chatKey).endsWith(o))) }; // aceita o número inteiro ou só o final
  const total = plan.chats.reduce((n, c) => n + c.messages.length, 0);
  if (opts.dry) return { dry: true, ...summarize({ ...plan, stats: { ...plan.stats, chats: plan.chats.length, messages: total } }) };
  if (!dbConfigured()) throw new Error('CHATWOOT_DB_URL não configurada: sem ela não dá para restaurar as datas originais');
  if (running.has(inst.name)) throw new Error('já existe uma importação em andamento para esta instância');
  running.add(inst.name);
  const runId = await db.startRun(inst.name, plan.chats.length, total);
  log.info('importação de histórico iniciada', { inst: inst.name, run: runId, chats: plan.chats.length, mensagens: total });
  // execução em segundo plano; quem chamou recebe já o id
  (async () => {
    const cw = new Chatwoot(inst);
    const since = new Date(Date.now() - 60_000);
    let chatsDone = 0, msgsDone = 0, failed = 0;
    try {
      for (const chat of plan.chats) {
        try {
          msgsDone += await importChat(inst, cw, chat, since);
        } catch (e) { failed++; log.warn('conversa não importada', { inst: inst.name, final: digits(chat.chatKey).slice(-4), err: e.message.slice(0, 160) }); }
        chatsDone++;
        await db.updateRun(runId, { chats_done: chatsDone, msgs_done: msgsDone, failed });
      }
      await db.updateRun(runId, { status: failed ? 'concluida_com_falhas' : 'concluida', finished_at: new Date() });
      log.info('importação de histórico concluída', { inst: inst.name, run: runId, conversas: chatsDone, mensagens: msgsDone, falhas: failed });
    } catch (e) {
      await db.updateRun(runId, { status: 'erro', error: e.message.slice(0, 300), finished_at: new Date() }).catch(() => {});
      log.error('importação de histórico interrompida', { inst: inst.name, err: e.message });
    } finally { running.delete(inst.name); }
  })();
  return { started: true, run: runId, chats: plan.chats.length, mensagens: total };
}

async function importChat(inst, cw, chat, since) {
  let conv = await ensureConversation(inst, cw, chat.chatKey, chat.name || undefined);
  if (!conv.created) {
    // o cache pode apontar para uma conversa que não existe mais (ex.: troca de conta/inbox): confirma e se recupera
    try { await cw.getConversation(conv.cw_conversation_id); }
    catch (e) { if (e.status !== 404) throw e; await db.dropConv(inst.name, chat.chatKey); conv = await ensureConversation(inst, cw, chat.chatKey, chat.name || undefined); }
  }
  const imported = new Map(); // id WhatsApp -> id da mensagem no Chatwoot (para respostas)
  let batch = [];             // criadas e ainda sem a data original
  const repair = [];          // já importadas antes (datas podem ter ficado erradas por uma falha anterior)
  let created = 0;
  const flush = async (resolve = false) => {
    if (batch.length) {
      const n = await fixTimestamps({ accountId: inst.account_id, inboxId: inst.inbox_id, convDisplayId: conv.cw_conversation_id, items: batch, since, resolve });
      if (n !== batch.length) log.warn('datas ajustadas em menos mensagens que o esperado', { esperado: batch.length, ajustadas: n });
      batch = [];
    }
  };
  try {
    for (const m of chat.messages) {
      const prev = await db.msg(inst.name, m.id);
      if (prev?.cw_message_id && prev.cw_conversation_id === conv.cw_conversation_id) {
        imported.set(m.id, prev.cw_message_id);
        if (prev.wa_ts) repair.push({ msgId: prev.cw_message_id, ts: m.ts }); // só linhas criadas pela importação (têm wa_ts)
        continue;
      }
      const res = await createWithRetry(cw, conv.cw_conversation_id, {
        content: m.content, type: m.fromMe ? 'outgoing' : 'incoming', sourceId: 'WAID:' + m.id,
        replyTo: m.replyTo ? imported.get(m.replyTo) ?? (await db.msg(inst.name, m.replyTo))?.cw_message_id : undefined,
      });
      imported.set(m.id, res.id);
      batch.push({ msgId: res.id, ts: m.ts });
      created++;
      await db.saveMsg({ instance: inst.name, wa_id: m.id, chat_jid: chat.chatKey, cw_message_id: res.id, cw_conversation_id: conv.cw_conversation_id, from_me: m.fromMe, content: m.content, wa_ts: m.ts });
      // O Chatwoot recusa >200 mensagens/minuto por conversa (CONVERSATION_MESSAGE_PER_MINUTE_LIMIT) contando created_at; ao devolver a data
      // original em lotes, as mensagens saem da janela do "último minuto" e o limite nunca é atingido.
      if (batch.length >= 50) await flush();
    }
  } finally {
    await flush(false).catch((e) => log.warn('falha ao ajustar datas do último lote', { err: e.message }));
  }
  if (repair.length) await fixTimestamps({ accountId: inst.account_id, inboxId: inst.inbox_id, convDisplayId: conv.cw_conversation_id, items: repair, since: new Date(0), resolve: false });
  if (conv.created) await fixTimestamps({ accountId: inst.account_id, inboxId: inst.inbox_id, convDisplayId: conv.cw_conversation_id, items: [], since, resolve: true });
  return created;
}

// Se mesmo assim o Chatwoot disser "Too many messages", espera a janela de 1 minuto esvaziar e tenta de novo.
async function createWithRetry(cw, convId, data, tries = 4) {
  for (let i = 1; ; i++) {
    try { return await cw.createMessage(convId, data); }
    catch (e) {
      if (i >= tries || !/Too many messages/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 15_000));
    }
  }
}

// Reprocessa as amostras guardadas (event_samples) como se tivessem acabado de chegar. Serve para testar e para refazer.
export async function replayFromSamples(instName, opts = {}) {
  const payloads = await db.samples(instName);
  if (!payloads.length) throw new Error('não há amostras de histórico guardadas para esta instância');
  const session = newSession();
  for (const p of payloads) ingest(session, p);
  return runImport(instName, { ...opts, session });
}
