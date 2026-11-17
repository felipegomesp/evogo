import { config } from './config.mjs';

export const expectedUrl = () => `${config.evogoWebhookBase}/evogo/${config.secret}`;
export const expectedEvents = (inst) => ['MESSAGE', 'READ_RECEIPT', ...(inst.import_history ? ['HISTORY_SYNC'] : [])];

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// Decide se o webhook do evogo precisa ser reaplicado. Devolve o motivo ou null.
//  - 'divergente': instância conectada cujo webhook/eventos foram apagados (botão Conectar do manager, reinício);
//  - 'pareamento': instância com importação de histórico ligada aguardando leitura do QR. O histórico chega logo depois
//    do pareamento, então o webhook com HISTORY_SYNC precisa estar valendo ANTES de o QR ser lido.
// Instância desconectada sem QR pendente nunca é tocada (não reconecta quem foi desconectado de propósito).
export function webhookReason(inst, ev) {
  const pairing = !ev.connected && !!inst.import_history && !!ev.qrcode;
  if (!ev.connected && !pairing) return null;
  const events = String(ev.events || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (ev.webhook === expectedUrl() && sameSet(events, expectedEvents(inst))) return null;
  return pairing ? 'pareamento' : 'divergente';
}

