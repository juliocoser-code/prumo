// Prumo — regras de lembretes e notificações.
// Código puro (sem dependências): roda no navegador, no Node (testes) e no Deno (Supabase Edge Functions).

export const DEFAULT_SETTINGS = {
  tz: 'America/Sao_Paulo',
  summaryTime: '07:30',
  quietStart: '22:00',
  quietEnd: '07:00',
  importantAlerts: true,
  groupWindowMin: 30,
};

// ---------- fuso horário ----------
const fmtCache = new Map();
function fmt(tz) {
  if (!fmtCache.has(tz)) {
    fmtCache.set(tz, new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
    }));
  }
  return fmtCache.get(tz);
}
const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function tzParts(date, tz) {
  const o = {};
  for (const p of fmt(tz).formatToParts(new Date(date))) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, hh: +o.hour, mm: +o.minute, ss: +o.second, wd: WD[o.weekday] };
}
function offsetMin(date, tz) {
  const p = tzParts(date, tz);
  return Math.round((Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - new Date(date).getTime()) / 60000);
}
/** Data local (no fuso tz) -> instante UTC */
export function zoned(y, m, d, hh, mm, tz) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let t = guess - offsetMin(guess, tz) * 60000;
  const off2 = offsetMin(t, tz);
  t = guess - off2 * 60000;
  return new Date(t);
}
export function localDateKey(date, tz) {
  const p = tzParts(date, tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}
const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

// ---------- horário de silêncio ----------
export function isQuiet(date, s) {
  const p = tzParts(date, s.tz);
  const now = p.hh * 60 + p.mm, a = toMin(s.quietStart), b = toMin(s.quietEnd);
  if (a === b) return false;
  return a < b ? now >= a && now < b : now >= a || now < b; // janela que atravessa a meia-noite
}
/** Próximo fim do silêncio depois de `date` */
export function quietEndAfter(date, s) {
  const p = tzParts(date, s.tz);
  const [h, m] = s.quietEnd.split(':').map(Number);
  let end = zoned(p.y, p.m, p.d, h, m, s.tz);
  if (end <= new Date(date)) end = zoned(p.y, p.m, p.d + 1, h, m, s.tz);
  return end;
}

// ---------- conteúdo das notificações ----------
const KIND_LABEL = { compromisso: 'Compromisso', prazo: 'Prazo', retorno: 'Cobrar retorno', responder: 'Responder', nota: 'Lembrete' };

export function hhmm(date, tz) {
  const p = tzParts(date, tz);
  return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

export function reminderPayload(item, reminder, s) {
  const when = item.dueAt ? ` · ${hhmm(item.dueAt, s.tz)}` : '';
  let body = item.detail || '';
  if (item.kind === 'retorno') body = `Você está esperando ${item.person || 'um retorno'}${item.waitingSince ? ' desde ' + fmtDay(item.waitingSince, s.tz) : ''}. Hora de cobrar.`;
  if (item.kind === 'compromisso' && item.place) body = `${item.place}${body ? ' — ' + body : ''}`;
  return {
    title: `${KIND_LABEL[item.kind] || 'Lembrete'}${when}`,
    body: `${item.title}${body ? '\n' + body : ''}`,
    tag: `item-${item.id}`,
    url: `./#/item/${item.id}?from=push`,
    itemId: item.id,
    reminderId: reminder.id,
    kind: 'reminder',
    actions: [{ action: 'snooze', title: 'Adiar 1h' }, { action: 'done', title: 'Concluir' }],
  };
}

export function newItemPayload(items, s, count) {
  const first = items[0];
  const n = count || items.length;
  const who = first.person || first.title;
  return {
    title: n > 1 ? `${who} · ${n} mensagens novas` : `Nova pendência importante`,
    body: n > 1 ? `Última: "${trim(items[n - 1].detail || items[n - 1].title)}"` : `${who}: "${trim(first.detail || first.title)}"`,
    tag: `conv-${first.conversationId || first.id}`,
    url: `./#/item/${items[n - 1].id}?from=push`,
    itemId: items[n - 1].id,
    kind: 'new_item',
    actions: [{ action: 'snooze', title: 'Adiar 1h' }, { action: 'done', title: 'Concluir' }],
  };
}

export function summaryPayload(items, now, s) {
  const open = items.filter((i) => i.status === 'open');
  const today = localDateKey(now, s.tz);
  const late = open.filter((i) => i.kind === 'responder' && isLate(i, now));
  const waiting = open.filter((i) => i.kind === 'retorno');
  const appts = open.filter((i) => i.kind === 'compromisso' && i.dueAt && localDateKey(i.dueAt, s.tz) === today)
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const parts = [];
  if (appts.length) parts.push(`${appts.length} compromisso${appts.length > 1 ? 's' : ''} (1º às ${hhmm(appts[0].dueAt, s.tz)})`);
  if (late.length) parts.push(`${late.length} resposta${late.length > 1 ? 's' : ''} atrasada${late.length > 1 ? 's' : ''}`);
  if (waiting.length) parts.push(`${waiting.length} retorno${waiting.length > 1 ? 's' : ''} a cobrar`);
  return {
    title: 'Seu dia no prumo',
    body: parts.length ? parts.join(' · ') : 'Nada pendente. Bom dia!',
    tag: `summary-${today}`,
    url: './#/hoje?from=summary',
    kind: 'summary',
  };
}

export function isLate(item, now, hours = 24) {
  return item.receivedAt && (new Date(now) - new Date(item.receivedAt)) > hours * 3600e3;
}
function trim(t, n = 90) { t = String(t).replace(/\s+/g, ' '); return t.length > n ? t.slice(0, n - 1) + '…' : t; }
function fmtDay(d, tz) { const p = tzParts(d, tz); return `${String(p.d).padStart(2, '0')}/${String(p.m).padStart(2, '0')}`; }

// ---------- operações sobre lembretes ----------
/** Reagendar: cancela lembretes ativos do item e cria um novo. Retorna novas listas. */
export function rescheduleItem(reminders, itemId, fireAt, allowQuiet, newId) {
  const out = reminders.map((r) => (r.itemId === itemId && r.status === 'scheduled' && r.kind === 'reminder'
    ? { ...r, status: 'canceled', canceledReason: 'rescheduled' } : r));
  out.push({ id: newId, itemId, kind: 'reminder', fireAt: new Date(fireAt).toISOString(), allowQuiet: !!allowQuiet, status: 'scheduled' });
  return out;
}
/** Concluir: cancela tudo o que estava agendado para o item */
export function cancelForItem(reminders, itemId, reason = 'done') {
  return reminders.map((r) => (r.itemId === itemId && r.status === 'scheduled' ? { ...r, status: 'canceled', canceledReason: reason } : r));
}

/**
 * Decide o que fazer agora.
 * @returns {{send: Array<{reminderIds:string[], payload:object, kind:string, conversationId?:string}>, defer: Array<{id:string, fireAt:string, reason:string}>, cancel: string[]}}
 */
export function planDispatch({ now, reminders, items, settings, log }) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  now = new Date(now);
  const byId = new Map(items.map((i) => [i.id, i]));
  const send = [], defer = [], cancel = [];
  const quiet = isQuiet(now, s);
  const due = reminders.filter((r) => r.status === 'scheduled' && new Date(r.fireAt) <= now);
  const groups = new Map();

  for (const r of due) {
    const item = byId.get(r.itemId);
    if (r.kind !== 'test' && (!item || item.status !== 'open')) { cancel.push(r.id); continue; }
    if (item && item.snoozedUntil && new Date(item.snoozedUntil) > now && r.kind === 'new_item') {
      defer.push({ id: r.id, fireAt: new Date(item.snoozedUntil).toISOString(), reason: 'snoozed' }); continue;
    }
    if (quiet && !r.allowQuiet && r.kind !== 'test') {
      defer.push({ id: r.id, fireAt: quietEndAfter(now, s).toISOString(), reason: 'quiet' }); continue;
    }
    if (r.kind === 'new_item') {
      if (!s.importantAlerts) { cancel.push(r.id); continue; }
      const key = item.conversationId || item.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ r, item });
      continue;
    }
    if (r.kind === 'test') { send.push({ kind: 'test', reminderIds: [r.id], payload: testPayload(now, s) }); continue; }
    send.push({ kind: 'reminder', reminderIds: [r.id], payload: reminderPayload(item, r, s) });
  }

  // agrupar alertas repetidos da mesma conversa
  for (const [conv, list] of groups) {
    list.sort((a, b) => new Date(a.item.receivedAt || a.r.fireAt) - new Date(b.item.receivedAt || b.r.fireAt));
    const last = (log || []).filter((l) => l.kind === 'new_item' && l.conversationId === conv)
      .map((l) => new Date(l.sentAt)).sort((a, b) => b - a)[0];
    const windowMs = s.groupWindowMin * 60000;
    if (last && now - last < windowMs) {
      const at = new Date(last.getTime() + windowMs).toISOString();
      for (const { r } of list) defer.push({ id: r.id, fireAt: at, reason: 'grouping' });
      continue;
    }
    send.push({ kind: 'new_item', conversationId: conv, reminderIds: list.map((x) => x.r.id), payload: newItemPayload(list.map((x) => x.item), s, list.length) });
  }

  // resumo diário (toca no horário escolhido, uma vez por dia)
  const p = tzParts(now, s.tz);
  const today = localDateKey(now, s.tz);
  const already = (log || []).some((l) => l.kind === 'summary' && l.day === today);
  const mins = p.hh * 60 + p.mm, st = toMin(s.summaryTime);
  if (!already && mins >= st && mins < st + 180) { // até 3h de tolerância se o servidor ficou fora
    send.push({ kind: 'summary', day: today, reminderIds: [], payload: summaryPayload(items, now, s) });
  }
  return { send, defer, cancel };
}

export function testPayload(now, s) {
  return { title: 'Push de teste do Prumo', body: `Se você está lendo isto, as notificações chegam. Enviado às ${hhmm(now, s.tz)}.`, tag: 'test', url: './#/config?from=test', kind: 'test' };
}
