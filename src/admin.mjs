import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.mjs';
import { log, recentEvents } from './log.mjs';
import { db } from './db.mjs';
import { Chatwoot } from './chatwoot.mjs';
import { ensureInbox } from './inbox.mjs';
import { listEvogoInstances, applyWebhook, expectedUrl, expectedEvents } from './webhook.mjs';
import { testForward } from './forward.mjs';
import { replayFromSamples } from './history.mjs';

const panelJs = () => fs.readFileSync(new URL('./panel.js', import.meta.url));
const overviewHtml = () => fs.readFileSync(new URL('./overview.html', import.meta.url));
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const evogoInstances = listEvogoInstances;

const publicInst = (i) => i && ({
  enabled: i.enabled, chatwootEnabled: i.chatwoot_enabled && !!i.inbox_id,
  accountId: i.account_id, inboxId: i.inbox_id, inboxName: i.inbox_name,
  forwardUrl: i.forward_url || '', forwardFormat: i.forward_format || 'evolution-v2', botName: i.bot_name || '',
  options: { sign: i.sign_msg, reopen: i.reopen_conversation, pending: i.conversation_pending, ignoreGroups: i.ignore_groups, importHistory: i.import_history, historyDays: i.history_days },
});

async function state() {
  const [evo, mine, accounts, stats] = await Promise.all([evogoInstances(), db.allInstances(), db.accountIds(), db.stats()]);
  const byName = new Map(mine.map((i) => [i.name, i]));
  const runs = new Map(await Promise.all(evo.map(async (e) => [e.name, await db.lastRun(e.name)])));
  const run = (r) => r && { status: r.status, chats: r.chats_total, chatsDone: r.chats_done, msgs: r.msgs_total, msgsDone: r.msgs_done, failed: r.failed, startedAt: r.started_at, finishedAt: r.finished_at, error: r.error };
  const live = new Set(evo.map((e) => e.name));
  // webhook do evogo apontando para a ponte com os eventos esperados (só faz sentido para instância configurada)
  const webhookOk = (e, row) => {
    if (!row) return null;
    const ev = String(e.webhook ? e.events || '' : '').split(',').map((x) => x.trim()).filter(Boolean), want = expectedEvents(row);
    return e.webhook === expectedUrl() && ev.length === want.length && want.every((x) => ev.includes(x));
  };
  const st = (name) => { const x = stats.get(name); return x ? { conversations: x.conversations, messages: x.messages, messages24h: x.messages_24h, lastMessage: x.last_message } : null; };
  return {
    accounts,
    instances: evo.map((e) => ({ name: e.name, connected: !!e.connected, number: (e.jid || '').split(':')[0].split('@')[0], bridge: publicInst(byName.get(e.name)) ?? null, webhookOk: webhookOk(e, byName.get(e.name)), stats: st(e.name), lastImport: run(runs.get(e.name)) ?? null })),
    // instâncias que a ponte conhece mas o evogo não tem mais (a vigia remove sozinha em ~5 min; aqui dá para remover na hora)
    orphans: mine.filter((i) => !live.has(i.name)).map((i) => ({ name: i.name, accountId: i.account_id, inboxName: i.inbox_name, stats: st(i.name) })),
    events: recentEvents().slice(0, 40),
  };
}

function parseUrl(u) {
  try { const x = new URL(u); if (x.protocol === 'http:' || x.protocol === 'https:') return x.toString(); } catch { /* cai no erro abaixo */ }
  throw new HttpError(400, 'A URL do webhook é inválida (use http:// ou https://).');
}

async function connect(b) {
  const name = String(b.instance || '').trim();
  if (!name) throw new HttpError(400, 'Informe a instância.');
  const ev = (await evogoInstances()).find((i) => i.name === name);
  if (!ev) throw new HttpError(404, `Instância "${name}" não existe no Evolution Go.`);
  const prev = (await db.allInstances()).find((i) => i.name === name);
  const o = b.options || {};

  const chatwootEnabled = !!b.chatwootEnabled;
  const forwardUrl = (b.forwardUrl || '').trim() ? parseUrl(b.forwardUrl.trim()) : '';
  if (!chatwootEnabled && !forwardUrl) throw new HttpError(400, 'Ligue o Chatwoot e/ou informe o webhook de automação. Para desligar tudo, use Desconectar.');

  let accountId = prev?.account_id ?? null, token = prev?.chatwoot_token ?? null, inboxName = prev?.inbox_name ?? null;
  const sameInbox = (id, nm) => prev && prev.account_id === id && prev.inbox_name === nm;
  let inboxId = prev?.inbox_id ?? null;
  if (chatwootEnabled) {
    accountId = Number.parseInt(b.accountId, 10);
    if (!Number.isInteger(accountId) || accountId < 1) throw new HttpError(400, 'Informe o ID da conta do Chatwoot.');
    token = (b.chatwootToken || '').trim() || (await db.account(accountId))?.chatwoot_token;
    if (!token) throw new HttpError(400, `Primeira vez na conta ${accountId}: informe o token de acesso do Chatwoot.`);
    try { await new Chatwoot({ account_id: accountId, chatwoot_token: token }).listInboxes(); }
    catch (e) { throw new HttpError(400, e.status === 401 || e.status === 403 ? 'Token do Chatwoot inválido ou sem acesso a essa conta.' : 'Não consegui acessar o Chatwoot: ' + e.message); }
    await db.saveAccount(accountId, token);
    inboxName = (b.inboxName || '').trim() || prev?.inbox_name || `${name}-evogo`;
    inboxId = sameInbox(accountId, inboxName) ? prev.inbox_id : null;
  }

  const row = {
    name, evogo_token: ev.token, account_id: accountId, chatwoot_token: token, inbox_id: inboxId, inbox_name: inboxName, chatwoot_enabled: chatwootEnabled,
    sign_msg: o.sign ?? prev?.sign_msg ?? false, reopen_conversation: o.reopen ?? prev?.reopen_conversation ?? false,
    conversation_pending: o.pending ?? prev?.conversation_pending ?? false, ignore_groups: o.ignoreGroups ?? prev?.ignore_groups ?? true,
    import_history: o.importHistory ?? prev?.import_history ?? false,
    history_days: Number.isInteger(Number(o.historyDays)) && Number(o.historyDays) >= 0 ? Number(o.historyDays) : prev?.history_days ?? 90,
    forward_url: forwardUrl, forward_format: b.forwardFormat === 'raw' ? 'raw' : 'evolution-v2',
    bot_name: prev?.bot_name ?? null, bot_id: prev?.bot_id ?? null,
  };
  if (chatwootEnabled) {
    const botName = String(b.botName ?? prev?.bot_name ?? '').trim();
    if (botName && (botName !== prev?.bot_name || accountId !== prev?.account_id || !prev?.bot_id)) {
      try { row.bot_id = (await new Chatwoot({ account_id: accountId, chatwoot_token: token }).ensureAgentBot(botName)).id; row.bot_name = botName; }
      catch (e) { throw new HttpError(400, 'Não consegui criar o remetente "' + botName + '" no Chatwoot (a conta do token precisa ser administradora): ' + e.message.slice(0, 120)); }
    } else if (!botName) { row.bot_name = null; row.bot_id = null; }
  }
  await db.upsertInstance(row);
  if (chatwootEnabled) {
    await ensureInbox(row);
    const after = (await db.allInstances()).find((i) => i.name === name);
    if (prev?.account_id && (prev.account_id !== after.account_id || (prev.inbox_id && prev.inbox_id !== after.inbox_id))) {
      await db.resetChatwootLinks(name); // evita mandar mensagens para conversas da conta/inbox anterior
      log.info('conta/inbox alterada: cache de conversas limpo', { inst: name });
    }
  }
  try { await applyWebhook(row, ev.token); } catch { throw new HttpError(502, 'Salvo, mas o evogo recusou configurar o webhook.'); }
  log.info('instância configurada pelo painel', { inst: name, chatwoot: chatwootEnabled, forward: !!forwardUrl });
  return { ok: true, bridge: publicInst((await db.allInstances()).find((i) => i.name === name)) };
}

export async function handleAdmin(req, res, action, readJson) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'apikey, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
  if (req.method === 'GET' && action === 'overview') { // página estática, sem segredos: pede a chave global e chama /admin/state
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(overviewHtml());
    return;
  }
  if (req.method === 'GET' && action === 'panel.js') {
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.end(panelJs());
    return;
  }
  const send = (status, obj) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
  try {
    const key = String(req.headers.apikey || '');
    if (!config.evogoGlobalKey) throw new HttpError(503, 'EVOGO_GLOBAL_KEY não configurada na ponte.');
    if (!key || !safeEq(key, config.evogoGlobalKey)) throw new HttpError(401, 'Chave inválida. Entre no manager com a chave global.');
    if (req.method === 'GET' && action === 'state') return send(200, await state());
    if (req.method === 'POST' && action === 'connect') return send(200, await connect(await readJson(req)));
    if (req.method === 'POST' && action === 'history-replay') {
      const b = await readJson(req);
      return send(200, await replayFromSamples(String(b.instance || ''), { dry: !!b.dry, only: Array.isArray(b.only) ? b.only.map(String) : undefined, days: Number.isInteger(b.days) ? b.days : undefined, force: !!b.force }));
    }
    if (req.method === 'POST' && action === 'test-forward') {
      const b = await readJson(req);
      const url = parseUrl(String(b.url || '').trim());
      try { return send(200, await testForward(url, String(b.instance || ''))); }
      catch (e) { return send(200, { ok: false, status: 0, error: e.name === 'TimeoutError' ? 'Tempo esgotado (15 s)' : e.message }); }
    }
    if (req.method === 'POST' && action === 'remove') { // só instância que não existe mais no evogo
      const name = String((await readJson(req)).instance || '');
      if ((await evogoInstances()).some((i) => i.name === name)) throw new HttpError(400, 'A instância ainda existe no Evolution Go. Use Desconectar no formulário dela.');
      if (!(await db.allInstances()).some((i) => i.name === name)) throw new HttpError(404, 'A ponte não conhece essa instância.');
      await db.removeInstance(name);
      log.warn('instância removida da ponte pela tela de visão geral', { inst: name });
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && action === 'disconnect') {
      const b = await readJson(req);
      await db.disable(String(b.instance || ''));
      return send(200, { ok: true });
    }
    throw new HttpError(404, 'Rota inexistente.');
  } catch (e) {
    if (!(e instanceof HttpError)) log.error('admin falhou', { err: e.message });
    send(e.status || 500, { error: e instanceof HttpError ? e.message : 'Erro interno: ' + e.message });
  }
}
