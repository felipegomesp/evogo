import test from 'node:test';
import assert from 'node:assert/strict';
import { newSession, ingest, textOf, buildPlan } from '../src/history-parse.mjs';

const item = (id, fromMe, ts, message, order = ts) => ({ message: { key: { ID: id, fromMe, remoteJID: 'x' }, message, messageTimestamp: ts }, msgOrderID: order });
const ev = (syncType, conversations = [], extra = {}) => ({ data: { Data: { syncType, conversations, ...extra } } });
const DAY = 86400, NOW = Date.parse('2026-11-17T12:00:00Z');
const ts = (daysAgo) => Math.floor(NOW / 1000) - daysAgo * DAY;

test('mensagens repetidas entre os tipos de sincronização são deduplicadas', () => {
  const s = newSession();
  const c = () => [{ ID: '5511999990001@s.whatsapp.net', messages: [item('A', false, ts(2), { conversation: 'oi' }), item('B', true, ts(1), { conversation: 'olá' })] }];
  ingest(s, ev(0, c())); ingest(s, ev(3, c())); ingest(s, ev(2, c()));
  const { chats, stats } = buildPlan(s, { now: NOW });
  assert.equal(stats.messages, 2); assert.equal(chats.length, 1);
});

test('conversa @lid usa o número do mapeamento e junta com a conversa pelo número', () => {
  const s = newSession();
  ingest(s, ev(2, [
    { ID: '111@lid', messages: [item('A', false, ts(3), { conversation: 'a' })] },
    { ID: '5511999990002@s.whatsapp.net', messages: [item('B', true, ts(2), { conversation: 'b' })] },
  ], { phoneNumberToLidMappings: [{ lidJID: '111@lid', pnJID: '5511999990002@s.whatsapp.net' }], pushnames: [{ ID: '5511999990002@s.whatsapp.net', pushname: 'Ana' }] }));
  const { chats } = buildPlan(s, { now: NOW });
  assert.equal(chats.length, 1); assert.equal(chats[0].chatKey, '5511999990002@s.whatsapp.net'); assert.equal(chats[0].name, 'Ana');
  assert.deepEqual(chats[0].messages.map((m) => m.id), ['A', 'B']);
});

test('@lid sem mapeamento, grupos e status são pulados e contados', () => {
  const s = newSession();
  ingest(s, ev(2, [
    { ID: '222@lid', messages: [item('A', false, ts(1), { conversation: 'a' })] },
    { ID: '123-456@g.us', messages: [item('B', false, ts(1), { conversation: 'b' })] },
    { ID: 'status@broadcast', messages: [item('C', false, ts(1), { conversation: 'c' })] },
  ]));
  const { chats, stats } = buildPlan(s, { now: NOW });
  assert.equal(chats.length, 0); assert.deepEqual(stats.skipped, { grupo: 1, semTelefone: 1, outros: 1, vazias: 0, antigas: 0 });
  assert.equal(buildPlan(s, { now: NOW, ignoreGroups: false }).stats.skipped.grupo, 0);
});

test('janela de dias e ordenação por data', () => {
  const s = newSession();
  ingest(s, ev(2, [{ ID: '5511999990003@s.whatsapp.net', messages: [
    item('NOVA', false, ts(1), { conversation: 'n' }), item('VELHA', false, ts(200), { conversation: 'v' }), item('MEIO', true, ts(10), { conversation: 'm' })] }]));
  const p = buildPlan(s, { now: NOW, days: 30 });
  assert.deepEqual(p.chats[0].messages.map((m) => m.id), ['MEIO', 'NOVA']); assert.equal(p.stats.skipped.antigas, 1);
  assert.deepEqual(buildPlan(s, { now: NOW }).chats[0].messages.map((m) => m.id), ['VELHA', 'MEIO', 'NOVA']);
});

test('texto: mídia vira aviso com legenda; protocolo/reação são ignorados', () => {
  assert.equal(textOf({ conversation: 'oi' }), 'oi');
  assert.equal(textOf({ imageMessage: { caption: 'foto' } }), '📷 Imagem\nfoto');
  assert.equal(textOf({ audioMessage: {} }), '🎤 Áudio');
  assert.equal(textOf({ documentMessage: { fileName: 'a.pdf' } }), '📄 a.pdf');
  assert.equal(textOf({ ephemeralMessage: { message: { conversation: 'efêmera' } } }), 'efêmera');
  assert.equal(textOf({ listMessage: { description: 'escolha' } }), 'escolha');
  assert.equal(textOf({ templateMessage: {} }), '[mensagem interativa]');
  assert.equal(textOf({ protocolMessage: { type: 0 } }), null);
  assert.equal(textOf({ reactionMessage: {} }), null);
  assert.equal(textOf({ messageContextInfo: {} }), null);
});

test('chats de sistema do WhatsApp (número curto) são ignorados', () => {
  const s = newSession();
  ingest(s, ev(2, [{ ID: '0@s.whatsapp.net', messages: [item('S', false, ts(1), { conversation: 'aviso' })] },
                   { ID: '5511999990004@s.whatsapp.net', messages: [item('A', false, ts(1), { conversation: 'oi' })] }]));
  const { chats, stats } = buildPlan(s, { now: NOW });
  assert.equal(chats.length, 1); assert.equal(stats.skipped.outros, 1);
});
