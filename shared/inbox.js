// Prumo — regras da caixa de entrada (vale para e-mail e WhatsApp).
// Recebe "eventos" (mensagem que chegou / mensagem que o Julio mandou) e decide o que vira pendência.
//
//  • Chegou mensagem → pendência "Responder" (mensagens seguidas da mesma conversa atualizam a mesma pendência).
//  • Chegou resposta de quem você estava esperando → "Esperando retorno" é concluído sozinho e vira "Responder".
//  • Você respondeu (pelo celular, pelo PC ou pelo webmail) → a pendência "Responder" é concluída sozinha.
//  • Você mandou uma pergunta → vira "Esperando retorno", com lembrete de cobrança em 2 dias úteis às 9h.

import { tzParts, zoned } from './scheduler.js';

const URGENT = /\b(urgente|urgencia|hoje|agora|asap|prazo|vence|vencimento|boleto|pagamento|cobranca|nota fiscal|nf-?e|multa|protesto|reclamac|problema|cancel)/;
const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const rid = (p) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** Importância: palavras de urgência, contatos VIP, ou pergunta direta de alguém da lista de prioridade */
export function importance(ev, { vip = [] } = {}) {
  const t = strip(`${ev.title || ''} ${ev.detail || ''}`);
  const who = strip(`${ev.person || ''} ${ev.from || ''}`);
  if (vip.some((v) => v && who.includes(strip(v)))) return 'alta';
  if (URGENT.test(t)) return 'alta';
  return 'normal';
}

/** Próximo dia útil (seg–sex) às 9h, `days` dias úteis depois */
export function businessDaysLater(date, days, tz) {
  const p = tzParts(date, tz);
  let d = 0, add = 0, wd = p.wd;
  while (d < days) { add++; wd = (wd + 1) % 7; if (wd !== 0 && wd !== 6) d++; }
  return zoned(p.y, p.m, p.d + add, 9, 0, tz);
}

/**
 * @param items    pendências atuais
 * @param events   [{type:'in'|'out', channel, conversationId, person, title, detail, at, messageId, expectsReply}]
 * @returns {{ items: object[], alerts: string[], closed: string[], followups: {itemId, fireAt}[] }}
 *   items = pendências novas ou alteradas; alerts = ids que merecem push; closed = ids concluídos (cancelar lembretes)
 */
export function applyEvents(items, events, { tz = 'America/Sao_Paulo', vip = [], seen = new Set() } = {}) {
  const byId = new Map(items.map((i) => [i.id, { ...i }]));
  const changed = new Set(), alerts = new Set(), closed = new Set(), followups = [];
  const open = (conv, kind) => [...byId.values()].find((i) => i.status === 'open' && i.conversationId === conv && i.kind === kind);
  const sorted = [...events].sort((a, b) => new Date(a.at) - new Date(b.at));

  for (const ev of sorted) {
    if (ev.messageId && seen.has(ev.messageId)) continue; // já processado (o mesmo e-mail lido duas vezes)
    if (ev.messageId) seen.add(ev.messageId);
    const conv = ev.conversationId;
    if (ev.type === 'in') {
      const waiting = open(conv, 'retorno');
      if (waiting) {
        Object.assign(waiting, { status: 'done', completedAt: ev.at, completedBy: 'chegou a resposta' });
        (waiting.history ||= []).push({ at: ev.at, what: 'Chegou a resposta' });
        changed.add(waiting.id); closed.add(waiting.id);
      }
      const imp = importance(ev, { vip });
      let it = open(conv, 'responder');
      if (it) {
        Object.assign(it, { detail: ev.detail, messages: (it.messages || 1) + 1, lastMessageAt: ev.at, importance: imp === 'alta' ? 'alta' : it.importance });
        (it.history ||= []).push({ at: ev.at, what: 'Nova mensagem' });
      } else {
        it = { id: rid('m'), kind: 'responder', status: 'open', channel: ev.channel, conversationId: conv, person: ev.person, title: ev.title, detail: ev.detail,
          context: ev.context || 'pessoal', receivedAt: ev.at, importance: imp, messageId: ev.messageId, history: [{ at: ev.at, what: waiting ? 'Respondeu o que você esperava' : 'Mensagem recebida' }] };
        byId.set(it.id, it);
      }
      changed.add(it.id);
      if (it.importance === 'alta' || waiting) alerts.add(it.id);
    } else if (ev.type === 'out') {
      const it = open(conv, 'responder');
      if (it && new Date(ev.at) >= new Date(it.receivedAt)) {
        Object.assign(it, { status: 'done', completedAt: ev.at, completedBy: 'você respondeu' });
        (it.history ||= []).push({ at: ev.at, what: `Respondido pelo ${ev.channel === 'email' ? 'e-mail' : 'WhatsApp'}` });
        changed.add(it.id); closed.add(it.id); alerts.delete(it.id);
      }
      if (ev.expectsReply && !open(conv, 'retorno')) {
        const w = { id: rid('w'), kind: 'retorno', status: 'open', channel: ev.channel, conversationId: conv, person: ev.person, title: ev.title, detail: ev.detail,
          context: ev.context || 'pessoal', waitingSince: ev.at, importance: 'normal', history: [{ at: ev.at, what: 'Você perguntou' }] };
        w.reminderAt = businessDaysLater(new Date(ev.at), 2, tz).toISOString();
        byId.set(w.id, w); changed.add(w.id);
        followups.push({ itemId: w.id, fireAt: w.reminderAt });
      }
    }
  }
  return { items: [...changed].map((id) => byId.get(id)), alerts: [...alerts], closed: [...closed], followups };
}

/** Uma mensagem enviada "espera resposta"? Pergunta, pedido de confirmação ou de envio. */
export function expectsReply(text) {
  const t = strip(text).replace(/\s+/g, ' ');
  if (!t) return false;
  if (/\?\s*($|[\n>])/.test(t) || /\?[^?]{0,40}$/.test(t)) return true;
  return /\b(me (confirma|confirme|avisa|avise|manda|mande|envia|envie|retorna|retorne)|aguardo|fico no aguardo|pode(ria)? me (mandar|enviar|passar)|preciso que (voce|vc) (me )?(mande|envie|confirme))/.test(t);
}
