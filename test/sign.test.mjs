import test from 'node:test';
import assert from 'node:assert/strict';
import { signBotText } from '../src/sign.mjs';

test('assina com o nome do bot quando "assinar" está ligado', () => {
  assert.equal(signBotText({ sign_msg: true, bot_name: 'Lis' }, 'Olá!'), '*Lis:*\nOlá!');
});
test('não assina sem nome ou com "assinar" desligado', () => {
  assert.equal(signBotText({ sign_msg: true, bot_name: '' }, 'Olá!'), 'Olá!');
  assert.equal(signBotText({ sign_msg: true }, 'Olá!'), 'Olá!');
  assert.equal(signBotText({ sign_msg: false, bot_name: 'Lis' }, 'Olá!'), 'Olá!');
});
test('não duplica a assinatura', () => {
  assert.equal(signBotText({ sign_msg: true, bot_name: 'Lis' }, '*Lis:*\nOlá!'), '*Lis:*\nOlá!');
});
