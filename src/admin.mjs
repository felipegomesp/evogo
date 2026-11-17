import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from './config.mjs';
import { log } from './log.mjs';
import { db } from './db.mjs';
import { Chatwoot } from './chatwoot.mjs';
import { ensureInbox } from './inbox.mjs';
import { listEvogoInstances, applyWebhook } from './webhook.mjs';

const panelJs = () => fs.readFileSync(new URL('./panel.js', import.meta.url));
const safeEq = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

const evogoInstances = listEvogoInstances;

const publicInst = (i) => i && ({
  enabled: i.enabled, accountId: i.account_id, inboxId: i.inbox_id, inboxName: i.inbox_name,
  options: { sign: i.sign_msg, reopen: i.reopen_conversation, pending: i.conversation_pending, ignoreGroups: i.ignore_groups, importHistory: i.import_history },
});

async function state() {
  const [evo, mine, accounts] = await Promise.all([evogoInstances(), db.allInstances(), db.accountIds()]);
  const byName = new Map(mine.map((i) => [i.name, i]));
  return {
    accounts,
    instances: evo.map((e) => ({ name: e.name, connected: !!e.connected, number: (e.jid || '').split(':')[0].split('@')[0], bridge: publicInst(byName.get(e.name)) ?? null })),
  };
}

async function connect(b) {
  const name = String(b.instance || '').trim();
  const accountId = Number.parseInt(b.accountId, 10);
  if (!name) throw new HttpError(400, 'Informe a instância.');
  if (!Number.isInteger(accountId) || accountId < 1) throw new HttpError(400, 'Informe o ID da conta do Chatwoot.');
  const ev = (await evogoInstances()).find((i) => i.name === name);
  if (!ev) throw new HttpError(404, `Instância "${name}" não existe no Evolution Go.`);

  const token = (b.chatwootToken || '').trim() || (await db.account(accountId))?.chatwoot_token;
  if (!token) throw new HttpError(400, `Primeira vez na conta ${accountId}: informe o token de acesso do Chatwoot.`);
  try { await new Chatwoot({ account_id: accountId, chatwoot_token: token }).listInboxes(); }
  catch (e) { throw new HttpError(400, e.status === 401 || e.status === 403 ? 'Token do Chatwoot inválido ou sem acesso a essa conta.' : 'Não consegui acessar o Chatwoot: ' + e.message); }
  await db.saveAccount(accountId, token);

  const prev = (await db.allInstances()).find((i) => i.name === name);
  const o = b.options || {};
  const inboxName = (b.inboxName || '').trim() || prev?.inbox_name || `${name}-evogo`;
  const sameInbox = prev && prev.account_id === accountId && prev.inbox_name === inboxName;
  const row = {
    name, evogo_token: ev.token, account_id: accountId, chatwoot_token: token,
    inbox_id: sameInbox ? prev.inbox_id : null, inbox_name: inboxName,
    sign_msg: !!(o.sign ?? prev?.sign_msg ?? false), reopen_conversation: !!(o.reopen ?? prev?.reopen_conversation ?? false),
    conversation_pending: !!(o.pending ?? prev?.conversation_pending ?? false), ignore_groups: !!(o.ignoreGroups ?? prev?.ignore_groups ?? true),
    import_history: !!(o.importHistory ?? prev?.import_history ?? false),
  };
  await db.upsertInstance(row);
  await ensureInbox(row);

  try { await applyWebhook(row, ev.token); } catch (e) { throw new HttpError(502, 'Inbox criada, mas o evogo recusou o webhook.'); }
  log.info('instância conectada pelo painel', { inst: name, account: accountId });
  const saved = (await db.allInstances()).find((i) => i.name === name);
  return { ok: true, bridge: publicInst(saved) };
}

export async function handleAdmin(req, res, action, readJson) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'apikey, content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
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
