import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { decryptEdit } from '../src/edit-crypto.mjs';

// protobuf mínimo: Message{ protocolMessage(12){ editedMessage(14){ conversation(1) } } }
const ld = (f, b) => Buffer.concat([Buffer.from([(f << 3) | 2, b.length]), b]);

test('decifra uma edição (MESSAGE_EDIT) e extrai o texto novo', () => {
  const secret = randomBytes(32);
  const id = 'ABC123';
  const lid = '100000000000000@lid';
  const plain = ld(12, ld(14, ld(1, Buffer.from('texto novo'))));
  const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(id + lid + lid + 'Message Edit'), 32));
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  const sem = { secretEncType: 2, encIV: iv.toString('base64'), encPayload: enc.toString('base64'), targetMessageKey: { ID: id } };

  assert.equal(decryptEdit({ sem, originalSecretB64: secret.toString('base64'), jidCandidates: ['5511999999999@s.whatsapp.net', lid] }), 'texto novo');
  assert.equal(decryptEdit({ sem, originalSecretB64: randomBytes(32).toString('base64'), jidCandidates: [lid] }), null);
  assert.equal(decryptEdit({ sem: { ...sem, secretEncType: 1 }, originalSecretB64: secret.toString('base64'), jidCandidates: [lid] }), null);
});
