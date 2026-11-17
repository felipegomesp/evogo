import { hkdfSync, createDecipheriv } from 'node:crypto';
import { editedText } from './pb.mjs';

// Decifra uma edição do WhatsApp (secretEncryptedMessage, tipo MESSAGE_EDIT).
// Chave = HKDF-SHA256(messageSecret da mensagem original, info = idOriginal + remetenteOriginal + remetenteEdição + "Message Edit").
// Os JIDs usados na derivação dependem do endereçamento (pn ou lid); testamos as combinações.
export function decryptEdit({ sem, originalSecretB64, jidCandidates }) {
  if (!sem || sem.secretEncType !== 2) return null;
  const secret = Buffer.from(originalSecretB64, 'base64');
  const payload = Buffer.from(sem.encPayload, 'base64');
  const iv = Buffer.from(sem.encIV, 'base64');
  const id = sem.targetMessageKey.ID;
  const cands = [...new Set(jidCandidates.filter(Boolean))];
  for (const os of cands) for (const ms of cands) {
    try {
      const key = Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), Buffer.from(id + os + ms + 'Message Edit'), 32));
      const d = createDecipheriv('aes-256-gcm', key, iv);
      d.setAuthTag(payload.subarray(payload.length - 16));
      const plain = Buffer.concat([d.update(payload.subarray(0, payload.length - 16)), d.final()]);
      return editedText(plain);
    } catch { /* tenta a próxima combinação */ }
  }
  return null;
}
