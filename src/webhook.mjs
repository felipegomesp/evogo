import { config } from './config.mjs';
import { log } from './log.mjs';
import { db } from './db.mjs';
import { expectedUrl, expectedEvents, webhookReason } from './webhook-rules.mjs';

export { expectedUrl, expectedEvents, webhookReason };

export async function listEvogoInstances() {
  const r = await fetch(config.evogoUrl + '/instance/all', { headers: { apikey: config.evogoGlobalKey }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) throw new Error(`evogo respondeu ${r.status} ao listar instâncias`);
  const j = await r.json();
  return j.data ?? j;
}

// Configura webhook e eventos da instância no evogo (POST /instance/connect).
export async function applyWebhook(inst, evogoToken = inst.evogo_token) {
  const r = await fetch(config.evogoUrl + '/instance/connect', {
    method: 'POST', headers: { apikey: evogoToken, 'Content-Type': 'application/json' },
    body: JSON.stringify({ webhookUrl: expectedUrl(), subscribe: expectedEvents(inst), immediate: true }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`evogo recusou o webhook (${r.status})`);
}

// O botão "Conectar" do manager (e reinícios) zera o webhook da instância. Esta vigia detecta e restaura.
let running = false;
export async function reconcile() {
  if (running || !config.evogoGlobalKey) return;
  running = true;
  try {
    const live = await listEvogoInstances();
    for (const inst of await db.instances()) {
      const ev = live.find((i) => i.name === inst.name);
      if (!ev) continue;
      const reason = webhookReason(inst, ev);
      if (!reason) continue;
      log.warn('webhook divergente no evogo; restaurando', { inst: inst.name, motivo: reason, tinhaWebhook: !!ev.webhook, eventos: String(ev.events || '') });
      await applyWebhook(inst, ev.token);
      log.info('webhook restaurado', { inst: inst.name, motivo: reason });
    }
  } catch (e) {
    log.error('reconcile falhou', { err: e.message });
  } finally { running = false; }
}
