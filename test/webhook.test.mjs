import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://x'; process.env.WEBHOOK_SECRET ||= 'seg';
process.env.EVOGO_WEBHOOK_BASE = 'http://ponte:3000';
const { webhookReason, expectedUrl } = await import('../src/webhook-rules.mjs');

const okUrl = expectedUrl();
const inst = (over = {}) => ({ import_history: false, ...over });

test('conectada e correta: nada a fazer', () => {
  assert.equal(webhookReason(inst(), { connected: true, webhook: okUrl, events: 'MESSAGE,READ_RECEIPT' }), null);
});
test('conectada com webhook apagado: divergente', () => {
  assert.equal(webhookReason(inst(), { connected: true, webhook: '', events: 'MESSAGE' }), 'divergente');
});
test('desconectada sem QR: nunca reconecta', () => {
  assert.equal(webhookReason(inst({ import_history: true }), { connected: false, webhook: '', events: 'MESSAGE', qrcode: '' }), null);
});
test('QR pendente sem histórico ligado: não mexe', () => {
  assert.equal(webhookReason(inst(), { connected: false, webhook: '', events: 'MESSAGE', qrcode: 'abc' }), null);
});
test('QR pendente com histórico ligado: restaura (pareamento)', () => {
  assert.equal(webhookReason(inst({ import_history: true }), { connected: false, webhook: '', events: 'MESSAGE', qrcode: 'abc' }), 'pareamento');
});
test('eventos precisam incluir HISTORY_SYNC quando o histórico está ligado', () => {
  assert.equal(webhookReason(inst({ import_history: true }), { connected: true, webhook: okUrl, events: 'MESSAGE,READ_RECEIPT' }), 'divergente');
  assert.equal(webhookReason(inst({ import_history: true }), { connected: true, webhook: okUrl, events: 'HISTORY_SYNC,MESSAGE,READ_RECEIPT' }), null);
});
