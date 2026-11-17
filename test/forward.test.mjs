import test from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgres://x'; process.env.WEBHOOK_SECRET ||= 'x';
const { toV2 } = await import('../src/forward.mjs');

const base = (over = {}, msg = { conversation: 'Olá' }) => ({
  event: 'Message', instanceName: 'inst', instanceId: 'id1', instanceToken: 'tok-123',
  data: { Info: { ID: 'ABC', Chat: '5511999999999@s.whatsapp.net', Sender: '5511999999999@s.whatsapp.net', SenderAlt: '100000000000000@lid', IsFromMe: false, PushName: 'Fulano', Edit: '', Timestamp: '2026-01-01T12:00:00-03:00', ...over }, Message: { ...msg, messageContextInfo: { messageSecret: 'x' } } },
});

test('texto vira messages.upsert da Evolution API v2', () => {
  const v = toV2(base());
  assert.equal(v.event, 'messages.upsert');
  assert.equal(v.instance, 'inst');
  assert.equal(v.data.key.remoteJid, '5511999999999@s.whatsapp.net');
  assert.equal(v.data.key.fromMe, false);
  assert.equal(v.data.key.id, 'ABC');
  assert.equal(v.data.pushName, 'Fulano');
  assert.equal(v.data.message.conversation, 'Olá');
  assert.equal(v.data.messageType, 'conversation');
  assert.equal(v.data.message.messageContextInfo, undefined);
  assert.equal(v.apikey, 'tok-123'); // a v2 inclui a apikey no webhook
});

test('reply expõe contextInfo no nível de data', () => {
  const v = toV2(base({}, { extendedTextMessage: { text: 'r', contextInfo: { stanzaID: 'Q1' } } }));
  assert.equal(v.data.messageType, 'extendedTextMessage');
  assert.equal(v.data.contextInfo.stanzaID, 'Q1');
});

test('mídia mantém base64 dentro de message', () => {
  const v = toV2(base({ MediaType: 'image' }, { imageMessage: { caption: 'c' }, base64: 'QUJD' }));
  assert.equal(v.data.messageType, 'imageMessage');
  assert.equal(v.data.message.base64, 'QUJD');
});

test('edição, apagar e protocolo não viram upsert', () => {
  assert.equal(toV2(base({ Edit: '1' })), null);
  assert.equal(toV2(base({ Edit: '7' }, { protocolMessage: { type: 0 } })), null);
  assert.equal(toV2(base({}, { secretEncryptedMessage: {} })), null);
});

test('chat @lid usa o número real como remoteJid', () => {
  const v = toV2(base({ Chat: '100000000000000@lid' }));
  assert.equal(v.data.key.remoteJid, '5511999999999@s.whatsapp.net');
  assert.equal(v.data.key.remoteJidAlt, '5511999999999@s.whatsapp.net');
});

test('chat normal não inclui remoteJidAlt', () => {
  assert.equal(toV2(base()).data.key.remoteJidAlt, undefined);
});
