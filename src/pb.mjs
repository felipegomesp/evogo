// Leitor mínimo de protobuf, o bastante para extrair o texto de uma edição decifrada.
export function readFields(buf) {
  const out = [];
  let i = 0;
  const varint = () => {
    let r = 0n, s = 0n;
    for (;;) {
      const b = buf[i++];
      r |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) break;
      s += 7n;
    }
    return r;
  };
  while (i < buf.length) {
    const t = Number(varint());
    const f = t >> 3, w = t & 7;
    if (w === 0) out.push({ f, v: varint() });
    else if (w === 2) { const l = Number(varint()); out.push({ f, b: buf.subarray(i, i + l) }); i += l; }
    else if (w === 1) { out.push({ f, b: buf.subarray(i, i + 8) }); i += 8; }
    else if (w === 5) { out.push({ f, b: buf.subarray(i, i + 4) }); i += 4; }
    else throw new Error('protobuf wire type ' + w);
  }
  return out;
}

export function get(buf, ...path) {
  let cur = buf;
  for (const f of path) {
    const x = readFields(cur).find((o) => o.f === f && o.b);
    if (!x) return null;
    cur = x.b;
  }
  return cur;
}

// Message.protocolMessage(12).editedMessage(14) -> conversation(1) | extendedTextMessage(6).text(1)
export function editedText(plain) {
  const ed = get(plain, 12, 14);
  if (!ed) return null;
  const c = get(ed, 1);
  if (c) return c.toString('utf8');
  const e = get(ed, 6, 1);
  return e ? e.toString('utf8') : null;
}
