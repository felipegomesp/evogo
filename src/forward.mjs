import { log } from './log.mjs';

// ---------- conversão Evolution Go -> formato da Evolution API v2 (messages.upsert) ----------
// Permite reaproveitar fluxos do n8n feitos para a Evolution API v2 sem alterá-los.
// ATENÇÃO: este formato inclui `apikey` (token da instância), como a v2; use só com webhooks seus.
const TYPES = ['conversation', 'extendedTextMessage', 'imageMessage', 'videoMessage', 'audioMessage', 'documentMessage',
  'documentWithCaptionMessage', 'stickerMessage', 'contactMessage', 'locationMessage', 'reactionMessage', 'pollCreationMessage'];

export function toV2(body) {
  const d = body.data ?? {}, I = d.Info ?? {}, M = d.Message ?? {};
  // edições, apagamentos e mensagens de protocolo não são "messages.upsert"
  if (I.Edit || M.protocolMessage || M.secretEncryptedMessage || M.senderKeyDistributionMessage) return null;
  const isGroup = String(I.Chat || '').endsWith('@g.us');
  const pn = [I.Chat, I.Sender, I.SenderAlt, I.RecipientAlt].find((j) => j?.endsWith('@s.whatsapp.net'));
  const message = { ...M }; delete message.messageContextInfo;
  const base64 = message.base64; delete message.base64;
  const type = TYPES.find((t) => M[t]) ?? Object.keys(message)[0] ?? 'conversation';
  const inner = M.extendedTextMessage ?? M[type];
  const ts = Math.floor((Date.parse(I.Timestamp) || Date.now()) / 1000);
  return {
    event: 'messages.upsert',
    instance: body.instanceName,
    data: {
      key: {
        remoteJid: isGroup ? I.Chat : pn ?? I.Chat, fromMe: !!I.IsFromMe, id: I.ID,
        ...(isGroup ? { participant: I.Sender } : {}),
        ...(pn && pn !== I.Chat ? { remoteJidAlt: pn } : {}),
      },
      pushName: I.PushName || '',
      message: base64 ? { ...message, base64 } : message,
      messageType: type,
      messageTimestamp: ts,
      contextInfo: inner?.contextInfo,
      source: 'evolution-go',
      instanceId: body.instanceId,
    },
    date_time: new Date(ts * 1000).toISOString(),
    sender: pn,
    // a Evolution API v2 inclui a apikey da instância no webhook; fluxos do n8n costumam lê-la de body.apikey
    apikey: body.instanceToken,
  };
}

const lastWarn = new Map();
function warnRateLimited(inst, msg, extra) {
  const now = Date.now();
  if (now - (lastWarn.get(inst) ?? 0) < 60_000) return;
  lastWarn.set(inst, now);
  log.warn(msg, { inst, ...extra });
}

async function post(url, payload, ms = 10_000) {
  return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(ms) });
}

// Envia uma cópia do evento ao webhook configurado (n8n etc.). Nunca bloqueia nem derruba o espelhamento do Chatwoot.
export function forwardEvent(inst, body) {
  let payload;
  if (inst.forward_format === 'raw') { payload = { ...body }; delete payload.instanceToken; }
  else { if (body.event !== 'Message') return; payload = toV2(body); if (!payload) return; }
  post(inst.forward_url, payload)
    .then((r) => { if (!r.ok) warnRateLimited(inst.name, 'webhook de encaminhamento respondeu erro', { status: r.status }); })
    .catch((e) => warnRateLimited(inst.name, 'falha ao encaminhar ao webhook', { err: e.message }));
}

// Teste do webhook: evento sintético que fluxos de mensagem ignoram (event != messages.upsert).
export async function testForward(url, instance) {
  const t0 = Date.now();
  const r = await post(url, { event: 'evogo.test', instance, data: { test: true, aviso: 'Teste de conexão do painel Chatwoot/n8n. Pode ignorar.' } }, 15_000);
  return { status: r.status, ok: r.ok, ms: Date.now() - t0 };
}
