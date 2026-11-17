// Assinatura da automação no WhatsApp: com "Assinar mensagens" ligado e um nome definido (ex.: "Lis"),
// a resposta vai como "*Lis:*\ntexto", no mesmo formato da assinatura dos agentes. Não duplica se já assinada.
export function signBotText(inst, text) {
  const name = (inst.bot_name || '').trim();
  if (!inst.sign_msg || !name) return text;
  const prefix = `*${name}:*`;
  return text.startsWith(prefix) ? text : `${prefix}\n${text}`;
}
