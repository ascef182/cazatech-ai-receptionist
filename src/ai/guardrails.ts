const HUMAN_REQUEST = /\b(atendente|humano|humana|pessoa de verdade|falar com (algu[eé]m|uma pessoa|o dono|a dona|a gerente|o gerente)|quero falar com)\b/i;

/** Atalho determinístico: pedido explícito por atendimento humano não depende do modelo. */
export function wantsHuman(text: string): boolean {
  return HUMAN_REQUEST.test(text.normalize('NFC'));
}

const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const INTERNAL_TERMS = /\b(slot_code|proposal_id|booking_id|tool_use|handoff_to_human|confirm_proposal|check_availability|system prompt)\b/gi;

/** Limpa a resposta final do modelo antes de enviar ao cliente. */
export function sanitizeReply(text: string, maxChars = 1200): string {
  let out = text.replace(UUID, '').replace(INTERNAL_TERMS, '').replace(/^#{1,6}\s+/gm, '');
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (out.length > maxChars) out = out.slice(0, maxChars - 1).replace(/\s+\S*$/, '') + '…';
  return out;
}

/** Envolve o texto do cliente para deixar explícito ao modelo que é dado, não instrução. */
export function wrapCustomerText(text: string): string {
  const clean = text.replace(/<\/?cliente>/gi, '').slice(0, 4000);
  return `<cliente>\n${clean}\n</cliente>`;
}

export const FALLBACK_REPLY = 'Desculpe, não consegui concluir seu atendimento agora. Já avisei a equipe, e uma pessoa vai continuar a conversa com você em breve.';
export const AUDIO_FALLBACK_REPLY = 'Não consegui ouvir seu áudio. Você pode escrever sua mensagem, por favor?';
export const HANDOFF_REPLY = 'Certo! Vou chamar uma pessoa da equipe para continuar com você. Em breve alguém responde por aqui.';
