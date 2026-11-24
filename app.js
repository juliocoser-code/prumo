// Prumo — assistente pessoal do Julio. App instalável no iPhone (PWA).
import { icon } from './icons.js';
import { CONTEXTS } from './demo-data.js';
import { createStore, serverConfig, saveServerConfig } from './store.js';
import { tzParts, zoned, localDateKey, hhmm, isQuiet, DEFAULT_SETTINGS } from './shared/scheduler.js';
import { parseNote } from './shared/nlp.js';

const TZ = 'America/Sao_Paulo';
const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = new URLSearchParams(location.search);
if (params.get('shot')) document.documentElement.classList.add('shot');

let S = { items: [], reminders: [], settings: {}, log: [] };
const ui = { loading: true, error: null, emptyDemo: false, seg: 'responder', day: null, lastTest: null, push: null };
let store, swReg;

// ---------- formatação ----------
const DOW = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const MON = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const now = () => new Date();
const T = (d) => hhmm(d, TZ);
function dayDiff(d) { const a = tzParts(now(), TZ), b = tzParts(d, TZ); return Math.round((Date.UTC(b.y, b.m - 1, b.d) - Date.UTC(a.y, a.m - 1, a.d)) / 864e5); }
function dayLabel(d, cap = true) {
  const n = dayDiff(d), p = tzParts(d, TZ);
  const s = n === 0 ? 'hoje' : n === 1 ? 'amanhã' : n === -1 ? 'ontem' : n > 1 && n < 7 ? DOW[p.wd] : `${String(p.d).padStart(2, '0')}/${String(p.m).padStart(2, '0')}`;
  return cap ? s[0].toUpperCase() + s.slice(1) : s;
}
const whenLabel = (d) => `${dayLabel(d)}, ${T(d)}`;
function ago(d) {
  const m = Math.max(1, Math.round((now() - new Date(d)) / 60e3));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h`;
  const dd = Math.floor(h / 24); return `${dd} dia${dd > 1 ? 's' : ''}`;
}
function until(d) {
  const m = Math.round((new Date(d) - now()) / 60e3);
  if (m <= 0) return 'agora';
  if (m < 60) return `em ${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return `em ${h}h${r ? String(r).padStart(2, '0') : ''}`;
  return dayLabel(d, false);
}
function greeting() { const h = tzParts(now(), TZ).hh; return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'; }
const ctx = (k) => CONTEXTS[k] || CONTEXTS.pessoal;
const chIcon = (it) => ({ whatsapp: 'chat', email: 'mail', agenda: 'calendar', manual: 'manual' }[it.channel] || 'manual');
const chLabel = (it) => ({ whatsapp: 'WhatsApp', email: 'E-mail', agenda: 'Agenda', manual: 'Anotação' }[it.channel] || '');

// ---------- classificação ----------
const isOpen = (i) => i.status === 'open';
const snoozed = (i) => i.snoozedUntil && new Date(i.snoozedUntil) > now();
function cls(i) {
  if (i.status === 'done') return 'done';
  if (i.kind === 'responder') return now() - new Date(i.receivedAt) > 24 * 3600e3 ? 'late' : 'reply';
  if (i.kind === 'retorno') return 'wait';
  if (i.kind === 'compromisso') return 'appt';
  return 'due';
}
function activeReminder(id) { return S.reminders.filter((r) => r.itemId === id && r.status === 'scheduled').sort((a, b) => new Date(a.fireAt) - new Date(b.fireAt))[0]; }
function items() { const all = S.items.filter((i) => i.status !== 'deleted'); return ui.emptyDemo ? all.filter((i) => !isOpen(i)) : all; }
function buckets() {
  const all = items().filter(isOpen), n = now();
  const live = all.filter((i) => !snoozed(i));
  const appts = live.filter((i) => i.kind === 'compromisso' && new Date(i.dueAt) > n - 10 * 60e3).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const next = appts[0] || null;
  const soon = (i) => i.dueAt && new Date(i.dueAt) - n < 3 * 3600e3;
  const attention = [
    ...live.filter((i) => cls(i) === 'late').sort((a, b) => new Date(a.receivedAt) - new Date(b.receivedAt)),
    ...live.filter((i) => cls(i) === 'reply' && i.importance === 'alta'),
    ...live.filter((i) => cls(i) === 'due' && soon(i)).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt)),
    ...live.filter((i) => cls(i) === 'reply' && i.importance !== 'alta'),
  ];
  const waiting = live.filter((i) => i.kind === 'retorno').sort((a, b) => new Date(a.waitingSince) - new Date(b.waitingSince));
  const later = live.filter((i) => i !== next && i.dueAt && dayDiff(i.dueAt) === 0 && !attention.includes(i) && i.kind !== 'retorno').sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
  const doneToday = items().filter((i) => i.status === 'done' && i.completedAt && dayDiff(i.completedAt) === 0);
  const todayAppts = all.filter((i) => i.kind === 'compromisso' && dayDiff(i.dueAt) === 0);
  return { next, attention, waiting, later, doneToday, todayAppts, snoozedN: all.filter(snoozed).length, late: attention.filter((i) => cls(i) === 'late') };
}

// ---------- componentes ----------
function pill(i) {
  const c = cls(i);
  if (c === 'late') return `<span class="pill late">Atrasada · ${ago(i.receivedAt)}</span>`;
  if (c === 'reply') return `<span class="pill soft">Responder · ${ago(i.receivedAt)}</span>`;
  if (c === 'wait') return `<span class="pill wait">Esperando · ${ago(i.waitingSince)}</span>`;
  if (c === 'due' && i.dueAt) { const late = new Date(i.dueAt) < now(); return `<span class="pill ${late ? 'late' : 'due'}">${late ? 'Venceu ' + T(i.dueAt) : dayLabel(i.dueAt) + ' ' + T(i.dueAt)}</span>`; }
  if (c === 'appt') return `<span class="pill soft">${whenLabel(i.dueAt)}</span>`;
  if (c === 'done') return `<span class="pill soft">${i.completedBy === 'você respondeu' ? 'Respondido' : i.completedBy === 'chegou a resposta' ? 'Respondeu' : 'Feito'} ${T(i.completedAt)}</span>`;
  return '';
}
function row(i, { quick = true } = {}) {
  const c = cls(i), k = ctx(i.context);
  const cl = c === 'late' ? 'late' : c === 'wait' ? 'wait' : c === 'due' ? 'due' : c === 'done' ? 'doneitem' : '';
  const ic = c === 'wait' ? 'hourglass' : c === 'due' ? 'flag' : chIcon(i);
  const who = i.person ? `<span>${esc(i.person.split(' · ')[0])}</span><span>·</span>` : '';
  return `<div class="row ${cl}" data-id="${i.id}">
    <span class="bar"></span>
    <span class="badge">${icon(ic, { size: 19 })}</span>
    <button class="main" data-act="open" data-id="${i.id}">
      <div class="t">${esc(i.title)}${i.messages > 1 ? `<span class="msgs">${i.messages}</span>` : ''}</div>
      <div class="m">${who}<span class="ctx"><i style="background:${k.color}"></i>${k.label}</span></div>
      <div class="pillwrap">${pill(i)}</div>
    </button>
    ${quick && c !== 'done' ? `<div class="qa">
      <button data-act="snooze" data-id="${i.id}" aria-label="Adiar">${icon('clock', { size: 18 })}</button>
      <button class="done" data-act="done" data-id="${i.id}" aria-label="Concluir">${icon('check', { size: 18, stroke: 2.2 })}</button>
    </div>` : ''}
  </div>`;
}
function hero(i) {
  return `<div class="hero" data-id="${i.id}">
    <div class="row1"><span>Próximo compromisso</span><span class="in">${until(i.dueAt)}</span></div>
    <div class="time">${dayDiff(i.dueAt) === 0 ? T(i.dueAt) : `${dayLabel(i.dueAt)} · ${T(i.dueAt)}`}</div>
    <p class="what">${esc(i.title)}</p>
    ${i.place ? `<div class="where">${icon('pin', { size: 15 })}${esc(i.place)}</div>` : ''}
    <div class="acts">
      <button data-act="snooze" data-id="${i.id}">${icon('clock', { size: 18 })}Adiar</button>
      <button data-act="done" data-id="${i.id}">${icon('check', { size: 18, stroke: 2.2 })}Feito</button>
      <button class="primary" data-act="open" data-id="${i.id}">Abrir${icon('chevron', { size: 16, stroke: 2.2 })}</button>
    </div>
  </div>`;
}
const ART = `<svg class="art" viewBox="0 0 132 92" fill="none"><path d="M8 70h116" stroke="#1B1A17" stroke-width="2" stroke-linecap="round"/><path d="M30 70a36 36 0 0 1 72 0" fill="#FDEEE6"/><path d="M30 70a36 36 0 0 1 72 0" stroke="#E0521D" stroke-width="2.5" stroke-linecap="round"/><path d="M66 18v-9M98 30l6-6M34 30l-6-6M110 52h8M14 52h8" stroke="#E0521D" stroke-width="2.5" stroke-linecap="round"/><path d="M26 82h80" stroke="#CFC8BC" stroke-width="2" stroke-linecap="round" stroke-dasharray="2 8"/></svg>`;
function skeleton() {
  const line = (w, h = 14, mt = 8) => `<div class="sk" style="width:${w};height:${h}px;margin-top:${mt}px"></div>`;
  return `<div class="screen">${line('42%', 12, 4)}${line('78%', 34, 12)}${line('60%', 14, 12)}
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:20px">${'<div class="sk" style="height:62px;border-radius:16px"></div>'.repeat(3)}</div>
    <div class="sk" style="height:178px;border-radius:22px;margin-top:18px"></div>
    ${line('40%', 20, 26)}<div class="sk" style="height:230px;border-radius:22px;margin-top:12px"></div></div>`;
}
function errbar() {
  return ui.error ? `<div class="errbar">${icon('alert', { size: 20 })}<span>${esc(ui.error)}</span>${/Ajustes/.test(ui.error) ? '<a href="#/config" style="background:var(--late);color:#fff;height:32px;padding:0 12px;border-radius:9px;font-size:13.5px;font-weight:700;display:flex;align-items:center;text-decoration:none">Abrir Ajustes</a>' : '<button data-act="retry">Tentar de novo</button>'}</div>` : '';
}

// ---------- telas ----------
function screenHoje() {
  const b = buckets(), p = tzParts(now(), TZ);
  const att = b.attention.length + (b.next && new Date(b.next.dueAt) - now() < 2 * 3600e3 ? 1 : 0);
  const pushDot = ui.push?.state === 'on' ? 'var(--ok)' : '#D99A1C';
  let h = `<div class="screen">${errbar()}
    <div class="top"><div>
      <div class="eyebrow">${DOW[p.wd]}, ${p.d} de ${MON[p.m - 1]}</div>
      <h1 class="title">${greeting()}, Julio.</h1>
    </div><a class="roundbtn" href="#/config" aria-label="Notificações">${icon(ui.push?.state === 'on' ? 'bell' : 'bellOff', { size: 20 })}<span class="dot" style="background:${pushDot}"></span></a></div>`;
  if (!b.attention.length && !b.next && !b.waiting.length) {
    const upcoming = items().filter((i) => isOpen(i) && i.dueAt && new Date(i.dueAt) > now()).sort((a, c) => new Date(a.dueAt) - new Date(c.dueAt))[0];
    return h + `<div class="empty">${ART}<h3>Tudo no prumo.</h3><p>Nada pedindo sua atenção agora.${upcoming ? ` Próximo: <b>${esc(upcoming.title)}</b>, ${dayLabel(upcoming.dueAt, false)} às ${T(upcoming.dueAt)}.` : ''}</p><button class="cta" data-act="compose">${icon('pen', { size: 18 })}Anotar algo</button></div>
      ${b.doneToday.length ? `<div class="section"><div class="card"><button class="collapsed">${icon('checkCircle', { size: 20 })}${b.doneToday.length} feito${b.doneToday.length > 1 ? 's' : ''} hoje</button></div></div>` : ''}</div>`;
  }
  h += `<p class="lede">${att ? `<b>${att} ${att > 1 ? 'coisas pedem' : 'coisa pede'} você</b> agora.` : 'Nada urgente agora.'} ${b.todayAppts.length ? `${b.todayAppts.length} compromisso${b.todayAppts.length > 1 ? 's' : ''} hoje.` : ''}</p>
    <div class="stats">
      <a class="stat late" href="#/pendencias?seg=responder"><b>${b.late.length}</b><span>atrasada${b.late.length === 1 ? '' : 's'}</span></a>
      <a class="stat wait" href="#/pendencias?seg=esperando"><b>${b.waiting.length}</b><span>esperando</span></a>
      <a class="stat appt" href="#/agenda"><b>${b.todayAppts.length}</b><span>na agenda</span></a>
    </div>`;
  if (b.next) h += hero(b.next);
  if (b.attention.length) h += `<div class="section"><div class="section-h"><h2>Precisa de você</h2><span class="count">${b.attention.length}</span></div><div class="card">${b.attention.map((i) => row(i)).join('')}</div></div>`;
  if (b.waiting.length) h += `<div class="section"><div class="section-h"><h2>Esperando retorno</h2><span class="count">${b.waiting.length}</span></div><div class="card">${b.waiting.map((i) => row(i)).join('')}</div></div>`;
  if (b.later.length) h += `<div class="section"><div class="section-h"><h2>Mais tarde hoje</h2><a href="#/agenda">Agenda</a></div><div class="card timeline">${b.later.map((i) => `<div class="row" data-id="${i.id}"><button class="main" data-act="open" data-id="${i.id}" style="display:flex;gap:12px;align-items:center"><span class="when">${T(i.dueAt)}<small>${i.kind === 'compromisso' ? 'agenda' : 'lembrete'}</small></span><span style="min-width:0"><div class="t">${esc(i.title)}</div><div class="m"><span class="ctx"><i style="background:${ctx(i.context).color}"></i>${ctx(i.context).label}</span></div></span></button><div class="qa"><button class="done" data-act="done" data-id="${i.id}" aria-label="Concluir">${icon('check', { size: 18, stroke: 2.2 })}</button></div></div>`).join('')}</div></div>`;
  if (b.doneToday.length || b.snoozedN) h += `<div class="section"><div class="card">${b.doneToday.length ? `<button class="collapsed" data-act="go" data-to="#/pendencias?seg=todas">${icon('checkCircle', { size: 20 })}${b.doneToday.length} feito${b.doneToday.length > 1 ? 's' : ''} hoje</button>` : ''}${b.snoozedN ? `<button class="collapsed" data-act="go" data-to="#/pendencias?seg=todas" style="border-top:1px solid var(--line-2)">${icon('clock', { size: 20 })}${b.snoozedN} adiado${b.snoozedN > 1 ? 's' : ''} para mais tarde</button>` : ''}</div></div>`;
  return h + '</div>';
}

function screenPendencias(q) {
  const seg = q.get('seg') || ui.seg; ui.seg = seg;
  const open = items().filter(isOpen);
  const sets = {
    responder: open.filter((i) => i.kind === 'responder'),
    esperando: open.filter((i) => i.kind === 'retorno'),
    prazos: open.filter((i) => i.kind === 'prazo' || i.kind === 'nota'),
    todas: items().filter((i) => i.kind !== 'compromisso' || i.status === 'done'),
  };
  const list = sets[seg];
  const segBtn = (k, l) => `<button class="${seg === k ? 'on' : ''}" data-act="seg" data-seg="${k}">${l}<span class="k">${k === 'todas' ? '' : sets[k].length}</span></button>`;
  let h = `<div class="screen">${errbar()}<div class="eyebrow">${open.filter((i) => i.kind !== 'compromisso').length} em aberto</div><h1 class="title">Pendências</h1>
    <div class="seg" style="margin-top:14px">${segBtn('responder', 'Responder')}${segBtn('esperando', 'Esperando')}${segBtn('prazos', 'Prazos')}${segBtn('todas', 'Todas')}</div>`;
  if (!list.length) {
    const msg = { responder: ['Ninguém esperando resposta.', 'Quando chegar algo no WhatsApp ou no e-mail que peça você, aparece aqui.'], esperando: ['Você não está esperando ninguém.', 'Anote "cobrar retorno de…" e eu te lembro de cobrar.'], prazos: ['Sem prazos em aberto.', 'Anote um prazo e escolha quando quer ser lembrado.'], todas: ['Nada por aqui ainda.', ''] }[seg];
    return h + `<div class="empty small">${icon(seg === 'esperando' ? 'hourglass' : 'checkCircle', { size: 34, cls: '', stroke: 1.5 })}<h3 style="margin-top:10px">${msg[0]}</h3><p>${msg[1]}</p></div></div>`;
  }
  const order = ['familia', 'nc-steak', 'emporio', 'distribuidora', 'rede', 'pessoal'];
  const groups = order.map((k) => [k, list.filter((i) => (i.context || 'pessoal') === k)]).filter(([, l]) => l.length);
  const sortFn = (a, b) => (a.status === 'done') - (b.status === 'done') || new Date(a.receivedAt || a.waitingSince || a.dueAt || 0) - new Date(b.receivedAt || b.waitingSince || b.dueAt || 0);
  for (const [k, l] of groups) h += `<div class="ctxh"><i style="background:${ctx(k).color}"></i>${ctx(k).label}<span style="margin-left:auto;color:var(--ink-3)">${l.length}</span></div><div class="card">${l.sort(sortFn).map((i) => row(i)).join('')}</div>`;
  return h + '</div>';
}

function screenAgenda(q) {
  const p = tzParts(now(), TZ);
  const sel = ui.day ?? 0;
  const dated = items().filter((i) => isOpen(i) && (i.dueAt || i.reminderAt));
  const at = (i) => i.dueAt || i.reminderAt;
  let week = '';
  for (let d = 0; d < 7; d++) {
    const date = zoned(p.y, p.m, p.d + d, 12, 0, TZ), dp = tzParts(date, TZ);
    const n = dated.filter((i) => dayDiff(at(i)) === d).length;
    week += `<button class="day ${d === sel ? 'on' : ''} ${d === 0 ? 'today' : ''}" data-act="day" data-d="${d}"><small>${d === 0 ? 'hoje' : DOW[dp.wd].slice(0, 3)}</small><b>${dp.d}</b><span class="dots">${'<i></i>'.repeat(Math.min(n, 3))}</span></button>`;
  }
  const list = dated.filter((i) => dayDiff(at(i)) === sel).sort((a, b) => new Date(at(a)) - new Date(at(b)));
  const selDate = zoned(p.y, p.m, p.d + sel, 12, 0, TZ), sp = tzParts(selDate, TZ);
  let h = `<div class="screen">${errbar()}<div class="eyebrow">${MON[p.m - 1]} ${p.y}</div><h1 class="title">Agenda</h1><div class="week">${week}</div>
    <div class="section-h" style="margin-top:0"><h2>${sel === 0 ? 'Hoje' : sel === 1 ? 'Amanhã' : DOW[sp.wd][0].toUpperCase() + DOW[sp.wd].slice(1)}, ${sp.d} de ${MON[sp.m - 1]}</h2><span class="count">${list.length}</span></div>`;
  if (!list.length) return h + `<div class="empty small">${icon('calendar', { size: 34, stroke: 1.5 })}<h3 style="margin-top:10px">Dia livre.</h3><p>Nada marcado. Toque em Anotar para incluir um compromisso.</p></div></div>`;
  let rows = '', placedNow = sel !== 0;
  for (const i of list) {
    if (!placedNow && new Date(at(i)) > now()) { rows += `<div class="nowline">${T(now())}</div>`; placedNow = true; }
    const c = cls(i), label = i.kind === 'compromisso' ? 'agenda' : i.kind === 'retorno' ? 'cobrar retorno' : 'lembrete';
    rows += `<div class="row ${c === 'wait' ? 'wait' : ''}" data-id="${i.id}"><span class="bar"></span><button class="main" data-act="open" data-id="${i.id}" style="display:flex;gap:12px;align-items:center"><span class="when">${T(at(i))}<small>${esc(label).slice(0, 12)}</small></span><span style="min-width:0"><div class="t">${esc(i.title)}</div><div class="m"><span class="ctx"><i style="background:${ctx(i.context).color}"></i>${ctx(i.context).label}</span>${activeReminder(i.id) ? `<span>·</span>${icon('bell', { size: 13 })}<span>${T(activeReminder(i.id).fireAt)}</span>` : ''}</div></span></button><div class="qa"><button data-act="snooze" data-id="${i.id}" aria-label="Adiar">${icon('clock', { size: 18 })}</button></div></div>`;
  }
  if (!placedNow) rows += `<div class="nowline">${T(now())}</div>`;
  return h + `<div class="card timeline">${rows}</div></div>`;
}

function pushStatusHtml() {
  const s = ui.push || {};
  const map = {
    on: ['ok', 'Notificações ativas neste iPhone', store.mode === 'server' ? 'Os lembretes chegam mesmo com o app fechado e a tela bloqueada.' : 'Permissão concedida. No modo demonstração os alertas são locais — conecte o servidor para recebê-los com o app fechado.'],
    install: ['warn', 'Instale o Prumo na Tela de Início', 'No iPhone, o push só funciona com o app instalado. Siga os passos abaixo e abra o Prumo pelo ícone.'],
    ask: ['warn', 'Notificações ainda não ativadas', 'Toque em Ativar e depois em Permitir.'],
    denied: ['bad', 'Notificações bloqueadas', 'Libere em Ajustes do iPhone › Notificações › Prumo › Permitir Notificações.'],
    unsupported: ['bad', 'Este navegador não recebe push', 'Use o Safari do iPhone (iOS 16.4 ou mais novo) e instale na Tela de Início.'],
    noserver: ['warn', 'Permitido, falta conectar o servidor', 'Sem o servidor o iPhone não recebe lembretes com o app fechado.'],
  };
  const [light, title, sub] = map[s.state] || map.ask;
  return `<div class="status"><span class="light ${light}"></span><div><b>${title}</b><span>${sub}</span></div></div>
    ${s.state === 'install' ? `<ol class="steps"><li>No Safari, toque em ${icon('share', { size: 14 }).replace('class="ic ', 'style="display:inline;vertical-align:-2px" class="ic ')} Compartilhar.</li><li>Escolha <b>Adicionar à Tela de Início</b>.</li><li>Abra o Prumo pelo ícone e volte aqui.</li></ol>` : ''}
    <div class="btnrow">${s.state === 'ask' || s.state === 'noserver' ? `<button class="btn accent" data-act="enable-push">${icon('bell', { size: 18 })}Ativar</button>` : ''}
    <button class="btn ${s.state === 'on' ? '' : 'light'}" data-act="test-push" ${['unsupported'].includes(s.state) ? 'disabled' : ''}>${icon('send', { size: 17 })}Enviar push de teste</button></div>
    ${ui.lastTest ? `<div class="gf" style="margin:-6px 16px 14px">${esc(ui.lastTest)}</div>` : ''}`;
}
function emailLine() {
  const e = ui.inbox?.email;
  if (!e) return 'Leitura somente, a cada 5 minutos';
  return e.ok ? `Lido às ${T(e.at)} · ${e.read} mensagem${e.read === 1 ? '' : 's'} nova${e.read === 1 ? '' : 's'}` : `Erro às ${T(e.at)}: ${e.error}`;
}
function screenConfig() {
  const st = { ...DEFAULT_SETTINGS, ...(S.settings || {}) }, cfg = serverConfig();
  const sw = (key, on) => `<button class="switch ${on ? 'on' : ''}" data-act="toggle" data-key="${key}" role="switch" aria-checked="${on}"></button>`;
  const ico = (name, bg) => `<span class="ico" style="background:${bg}">${icon(name, { size: 17, stroke: 2 })}</span>`;
  return `<div class="screen">${errbar()}<div class="eyebrow">Prumo · versão 0.1</div><h1 class="title">Ajustes</h1>
  <div class="group"><div class="gh">Notificações</div><div class="card">${pushStatusHtml()}</div></div>
  <div class="group"><div class="card">
    <div class="set">${ico('today', '#E0521D')}<div class="tx">Resumo diário<small>O que pede você e a agenda do dia</small></div><input type="time" value="${st.summaryTime}" data-set="summaryTime"></div>
    <div class="set">${ico('moon', '#4B4A7A')}<div class="tx">Silêncio a partir de</div><input type="time" value="${st.quietStart}" data-set="quietStart"></div>
    <div class="set">${ico('moon', '#4B4A7A')}<div class="tx">Silêncio até</div><input type="time" value="${st.quietEnd}" data-set="quietEnd"></div>
  </div><div class="gf">No silêncio, só tocam os lembretes marcados com "pode tocar no silêncio". O resto fica guardado e chega às ${st.quietEnd}.${isQuiet(now(), st) ? ' <b>Agora está no horário de silêncio.</b>' : ''}</div></div>
  <div class="group"><div class="card">
    <div class="set">${ico('alert', '#C8302A')}<div class="tx">Nova pendência importante<small>WhatsApp e e-mail classificados como importantes</small></div>${sw('importantAlerts', st.importantAlerts)}</div>
    <div class="set">${ico('chat', '#3557D4')}<div class="tx">Agrupar a mesma conversa<small>Um alerta a cada ${st.groupWindowMin} min por conversa</small></div><span class="val">${st.groupWindowMin} min</span></div>
  </div></div>
  <div class="group"><div class="gh">Canais conectados</div><div class="card">
    <div class="set">${ico('chat', '#23875A')}<div class="tx">WhatsApp pessoal<small>Pela API oficial, após virar Business</small></div><span class="tag">Em preparação</span></div>
    <div class="set">${ico('mail', '#3557D4')}<div class="tx">Webmail<small>${esc(emailLine())}</small></div><span class="tag ${ui.inbox?.email?.ok ? 'ok' : ''}">${ui.inbox?.email ? (ui.inbox.email.ok ? 'Conectado' : 'Com erro') : 'Em preparação'}</span></div>
    <div class="set">${ico('calendar', '#E0521D')}<div class="tx">Agenda</div><span class="tag">Em preparação</span></div>
  </div></div>
  <div class="group"><div class="gh">Família e empresas</div><div class="card" style="padding:14px"><div class="chips">${Object.entries(CONTEXTS).map(([, c]) => `<span class="chip"><i class="c" style="background:${c.color}"></i>${c.label}</span>`).join('')}</div></div></div>
  <div class="group"><div class="gh">Servidor de push</div><div class="card">
    <div class="set">${ico('phone', '#1B1A17')}<div class="tx">${cfg ? 'Conectado' : 'Modo demonstração'}<small>${cfg ? esc(cfg.url) : 'Dados no próprio aparelho'}</small></div>${cfg ? '<span class="tag ok">Ativo</span>' : ''}</div>
    ${cfg ? `<div class="btnrow" style="padding-top:4px"><button class="btn light" data-act="disconnect">Voltar ao modo demonstração</button></div>` : `
    <div class="set"><input type="url" placeholder="https://xxxx.supabase.co/functions/v1/prumo" id="srvUrl" value="https://geyecutzirvuyelnrokg.supabase.co/functions/v1/prumo"></div>
    <div class="set"><input type="password" placeholder="Chave pessoal (PRUMO_KEY)" id="srvKey"></div>
    <div class="btnrow" style="padding-top:4px"><button class="btn" data-act="connect">Conectar</button></div>`}
  </div></div>
  <div class="group"><div class="gh">Testar a primeira versão</div><div class="card">
    <button class="set" data-act="sim-incoming">${ico('sparkle', '#6E52A3')}<div class="tx">Simular mensagem importante<small>Chega uma nova do Marcos no WhatsApp</small></div>${icon('chevron', { size: 16 })}</button>
    <button class="set" data-act="sim-empty">${ico('checkCircle', '#23875A')}<div class="tx">${ui.emptyDemo ? 'Voltar com as pendências' : 'Ver tela Hoje vazia'}</div>${icon('chevron', { size: 16 })}</button>
    <button class="set" data-act="sim-error">${ico('alert', '#C8302A')}<div class="tx">${ui.error ? 'Tirar aviso de erro' : 'Ver estado de erro'}</div>${icon('chevron', { size: 16 })}</button>
    <button class="set" data-act="sim-loading">${ico('refresh', '#8F8A82')}<div class="tx">Ver carregamento</div>${icon('chevron', { size: 16 })}</button>
    <button class="set" data-act="reset">${ico('undo', '#8F8A82')}<div class="tx">Restaurar dados de exemplo</div>${icon('chevron', { size: 16 })}</button>
  </div></div></div>`;
}

function screenItem(id, q) {
  const i = S.items.find((x) => x.id === id);
  if (!i) return `<div class="screen"><div class="navbar"><button class="backbtn" data-act="back">${icon('back', { size: 22 })}Voltar</button></div><div class="empty">${ART}<h3>Item não encontrado.</h3><p>Ele pode ter sido concluído ou apagado em outro aparelho.</p><a class="cta dark" href="#/hoje" style="text-decoration:none">Ir para Hoje</a></div></div>`;
  const c = cls(i), k = ctx(i.context), rem = activeReminder(i.id);
  const banner = ({
    late: () => ['late', 'alert', `Resposta atrasada`, `há ${ago(i.receivedAt)}`],
    reply: () => ['due', 'chat', 'Aguardando sua resposta', `há ${ago(i.receivedAt)}`],
    wait: () => ['wait', 'hourglass', 'Você está esperando retorno', `há ${ago(i.waitingSince)}`],
    appt: () => ['appt', 'calendar', `${whenLabel(i.dueAt)}`, until(i.dueAt)],
    due: () => ['due', 'flag', i.dueAt ? `Prazo ${whenLabel(i.dueAt).toLowerCase()}` : 'Lembrete', i.dueAt ? until(i.dueAt) : ''],
    done: () => ['ok', 'checkCircle', 'Concluído', i.completedAt ? `${dayLabel(i.completedAt, false)} ${T(i.completedAt)}` : ''],
  })[c]();
  const initials = (i.person || k.label).split(/[\s·]+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  const hist = [
    i.receivedAt && ['Mensagem recebida', i.receivedAt], i.waitingSince && ['Começou a esperar', i.waitingSince], i.createdAt && ['Anotado', i.createdAt],
    ...(i.history || []).map((x) => [x.what, x.at]),
    ...S.log.filter((l) => l.itemId === i.id).map((l) => ['Notificação enviada', l.sentAt]),
    i.completedAt && ['Concluído', i.completedAt],
  ].filter(Boolean).sort((a, b) => new Date(a[1]) - new Date(b[1]));
  const fromPush = q.get('from') === 'push';
  const replyBtn = i.kind === 'responder' ? `<button class="reply wide" data-act="reply" data-id="${i.id}">${icon(i.channel === 'email' ? 'mail' : 'chat', { size: 19 })}Responder ${i.channel === 'email' ? 'por e-mail' : 'no WhatsApp'}</button>` : '';
  return `<div class="screen" style="padding-bottom:${i.kind === 'responder' ? 200 : 140}px">
    <div class="navbar"><button class="backbtn" data-act="back">${icon('back', { size: 22 })}Voltar</button>${fromPush ? `<span class="from-push">${icon('bell', { size: 15 })}Aberto pela notificação</span>` : ''}</div>
    <div class="status-banner ${banner[0]}">${icon(banner[1], { size: 19 })}${banner[2]}<small>${banner[3]}</small></div>
    <h1 class="item-title">${esc(i.title)}</h1>
    <div class="who"><span class="avatar" style="background:${k.color}">${esc(initials)}</span><div><div class="n">${esc(i.person || k.label)}</div><div class="s">${icon(chIcon(i), { size: 14 })}${chLabel(i)} · <span style="color:${k.color};font-weight:600">${k.label}</span></div></div></div>
    ${i.detail ? `<div class="quote">${esc(i.detail)}${i.receivedAt ? `<span class="ts">${dayLabel(i.receivedAt)} · ${T(i.receivedAt)}</span>` : ''}</div>` : ''}
    <div class="opts kv">
      ${i.place ? `<div class="opt">${icon('pin', { size: 19 })}<span class="lbl">Local</span><b>${esc(i.place)}</b></div>` : ''}
      <div class="opt">${icon('bell', { size: 19 })}<span class="lbl">Lembrete</span><b>${rem ? whenLabel(rem.fireAt) : i.status === 'done' ? '—' : 'Nenhum'}</b>${i.status === 'open' ? `<button class="linkbtn" data-act="remind" data-id="${i.id}">${rem ? 'Alterar' : 'Criar'}</button>` : ''}</div>
      ${rem ? `<div class="opt">${icon('moon', { size: 19 })}<span class="lbl">Toca no silêncio</span><b>${rem.allowQuiet ? 'Sim' : 'Não'}</b></div>` : ''}
      ${i.snoozedUntil && snoozed(i) ? `<div class="opt">${icon('clock', { size: 19 })}<span class="lbl">Adiado até</span><b>${whenLabel(i.snoozedUntil)}</b></div>` : ''}
    </div>
    ${hist.length ? `<ul class="history">${hist.map(([w, t]) => `<li>${esc(w)}<time>${dayLabel(t)} ${T(t)}</time></li>`).join('')}</ul>` : ''}
  </div>
  ${i.status === 'open' ? `<div class="actionbar"><div class="in">${replyBtn}<button data-act="snooze" data-id="${i.id}">${icon('clock', { size: 19 })}Adiar</button><button class="primary" data-act="done" data-id="${i.id}">${icon('check', { size: 19, stroke: 2.4 })}Concluir</button></div></div>`
    : `<div class="actionbar"><div class="in"><button class="wide" data-act="reopen" data-id="${i.id}">${icon('undo', { size: 19 })}Reabrir</button></div></div>`}`;
}

// ---------- roteamento ----------
function route() {
  const [path, qs] = (location.hash.slice(1) || '/hoje').split('?');
  return { parts: path.split('/').filter(Boolean), q: new URLSearchParams(qs || '') };
}
function render() {
  try { renderInner(); } catch (e) {
    console.error(e);
    $('#view').innerHTML = `<div class="screen"><div class="errbar">${icon('alert', { size: 20 })}<span>Algo deu errado nesta tela (${esc(e.message)}).</span></div><div class="btnrow" style="padding:0"><button class="btn light" data-act="disconnect">Voltar ao modo demonstração</button><a class="btn" href="#/hoje" style="text-decoration:none">Ir para Hoje</a></div></div>`;
  }
}
function renderInner() {
  const { parts, q } = route();
  const view = $('#view');
  const tab = parts[0] === 'item' ? null : parts[0] || 'hoje';
  if (ui.loading) view.innerHTML = skeleton();
  else if (parts[0] === 'item') view.innerHTML = screenItem(parts[1], q);
  else view.innerHTML = { pendencias: () => screenPendencias(q), agenda: () => screenAgenda(q), config: screenConfig }[tab]?.() ?? screenHoje();
  const late = buckets().late.length;
  $('#tabbar').innerHTML = `<nav>
    ${tabLink('hoje', 'today', 'Hoje', tab)}${tabLink('pendencias', 'list', 'Pendências', tab, late)}
    <button class="fab" data-act="compose" aria-label="Anotar">${icon('pen', { size: 25, stroke: 2 })}<span class="fab-label">Anotar</span></button>
    ${tabLink('agenda', 'calendar', 'Agenda', tab)}${tabLink('config', 'settings', 'Ajustes', tab)}</nav>`;
  $('#tabbar').style.display = parts[0] === 'item' ? 'none' : '';
  if ('setAppBadge' in navigator) { const n = buckets().attention.length; (n ? navigator.setAppBadge(n) : navigator.clearAppBadge()).catch(() => {}); }
  // ações vindas do toque na notificação (ex.: #/item/p1?from=push&do=snooze)
  if (parts[0] === 'item' && q.get('do')) {
    const act = q.get('do'); q.delete('do'); history.replaceState(null, '', `#/item/${parts[1]}?${q}`);
    if (act === 'snooze') openSnooze(parts[1]); else if (act === 'done') complete(parts[1]);
  }
}
const tabLink = (k, ic, label, cur, n) => `<a class="tab ${cur === k ? 'on' : ''}" href="#/${k}">${icon(ic, { size: 25, stroke: cur === k ? 2.1 : 1.8 })}${label}${n ? `<span class="n">${n}</span>` : ''}</a>`;

// ---------- folhas ----------
function openSheet(html, mount) {
  closeSheet(true);
  const scrim = document.createElement('div'); scrim.className = 'scrim'; scrim.dataset.act = 'close-sheet';
  const sh = document.createElement('div'); sh.className = 'sheet'; sh.setAttribute('role', 'dialog'); sh.innerHTML = `<div class="grab"></div>${html}`;
  document.body.append(scrim, sh);
  requestAnimationFrame(() => { scrim.classList.add('on'); sh.classList.add('on'); });
  mount?.(sh);
  return sh;
}
function closeSheet(instant) {
  document.querySelectorAll('.sheet, .scrim').forEach((el) => { if (instant) el.remove(); else { el.classList.remove('on'); setTimeout(() => el.remove(), 320); } });
  if (rec) { try { rec.stop(); } catch {} rec = null; }
}
function snoozeOptions() {
  const p = tzParts(now(), TZ), n = now();
  const o = [{ k: '1h', label: 'Em 1 hora', at: new Date(n.getTime() + 3600e3) }];
  const tonight = zoned(p.y, p.m, p.d, 19, 0, TZ);
  if (tonight - n > 90 * 60e3) o.push({ k: 'tonight', label: 'Hoje à noite', at: tonight });
  o.push({ k: 'tomorrow', label: 'Amanhã cedo', at: zoned(p.y, p.m, p.d + 1, 8, 0, TZ) });
  const toMon = ((1 - p.wd + 7) % 7) || 7;
  if (toMon > 1) o.push({ k: 'monday', label: 'Segunda-feira', at: zoned(p.y, p.m, p.d + toMon, 8, 0, TZ) });
  return o;
}
function localInput(d) { const p = tzParts(d, TZ); const z = (x) => String(x).padStart(2, '0'); return `${p.y}-${z(p.m)}-${z(p.d)}T${z(p.hh)}:${z(p.mm)}`; }
function fromLocalInput(v) { const [d, t] = v.split('T'); const [y, m, dd] = d.split('-').map(Number); const [h, mi] = t.split(':').map(Number); return zoned(y, m, dd, h, mi, TZ); }

function openSnooze(id, mode = 'snooze') {
  const it = S.items.find((x) => x.id === id); if (!it) return;
  const rem = activeReminder(id);
  let allowQuiet = rem?.allowQuiet || false;
  const opts = snoozeOptions();
  const st = { ...DEFAULT_SETTINGS, ...(S.settings || {}) };
  const sh = openSheet(`<div class="sheet-h"><h3>${mode === 'snooze' ? 'Adiar' : 'Lembrete'}</h3><button class="xbtn" data-act="close-sheet" aria-label="Fechar">${icon('x', { size: 16, stroke: 2.2 })}</button></div>
    <p class="lede" style="margin:-4px 0 14px">${esc(it.title)}</p>
    <div class="opts">${opts.map((o) => `<button class="opt" data-pick="${o.at.toISOString()}">${icon('clock', { size: 19 })}${o.label}<small>${dayDiff(o.at) === 0 ? '' : dayLabel(o.at) + ', '}${T(o.at)}</small></button>`).join('')}
      <label class="opt">${icon('calendar', { size: 19 })}Escolher<input type="datetime-local" id="customAt" value="${localInput(new Date(now().getTime() + 2 * 3600e3))}"></label></div>
    <div class="toggle-row"><div class="tx">Pode tocar no horário de silêncio<small>${st.quietStart}–${st.quietEnd}. Desligado, o alerta espera até ${st.quietEnd}.</small></div><button class="switch ${allowQuiet ? 'on' : ''}" id="aq" role="switch"></button></div>
    <button class="cta dark" id="customGo">${icon('check', { size: 18, stroke: 2.4 })}Usar data escolhida</button>`, (el) => {
    el.querySelector('#aq').onclick = (e) => { allowQuiet = !allowQuiet; e.currentTarget.classList.toggle('on', allowQuiet); };
    const apply = async (at) => {
      closeSheet();
      if (mode === 'snooze') {
        const r = await safe(() => store.snooze(id, at.toISOString(), allowQuiet)); if (!r) return;
        S = r.state; render(); toast(`Adiado para ${dayLabel(at, false)}, ${T(at)}`, { undo: r.undo, ic: 'clock' });
      } else {
        const st2 = await safe(() => store.setReminder(id, at.toISOString(), allowQuiet)); if (!st2) return;
        S = st2; render(); toast(`Lembrete para ${dayLabel(at, false)}, ${T(at)}${allowQuiet ? ' · toca no silêncio' : ''}`, { ic: 'bell' });
      }
    };
    el.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => apply(new Date(b.dataset.pick))));
    el.querySelector('#customGo').onclick = () => { const v = el.querySelector('#customAt').value; if (v) apply(fromLocalInput(v)); };
  });
  return sh;
}

// ---------- anotar (texto e voz) ----------
let rec = null;
function openCompose(prefill = '') {
  const draft = { text: prefill, kind: null, context: null, when: undefined, allowQuiet: false };
  const kinds = [['nota', 'Lembrete'], ['compromisso', 'Compromisso'], ['prazo', 'Prazo'], ['retorno', 'Cobrar retorno']];
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const sh = openSheet(`<div class="sheet-h"><h3>Anotar</h3><button class="xbtn" data-act="close-sheet" aria-label="Fechar">${icon('x', { size: 16, stroke: 2.2 })}</button></div>
    <div id="cbody"><div class="composer"><textarea id="note" rows="3" placeholder="Ex.: cobrar o orçamento da câmara fria sexta de manhã" enterkeyhint="done"></textarea>
      <div class="bar2"><span class="hint" id="mhint">Fale ou escreva do seu jeito</span><button class="mic" id="mic">${icon('mic', { size: 18, stroke: 2 })}<span id="micl">Falar</span><span class="wave"><i></i><i></i><i></i><i></i></span></button></div></div>
    <div class="understood">Entendi</div><div class="chips" id="cwhen"></div>
    <div class="understood">Tipo</div><div class="chips" id="ckind"></div>
    <div class="understood">Para</div><div class="chips" id="cctx"></div>
    <div class="toggle-row"><div class="tx">Pode tocar no horário de silêncio<small>${S.settings?.quietStart || '22:00'}–${S.settings?.quietEnd || '07:00'}</small></div><button class="switch" id="caq" role="switch"></button></div>
    <button class="cta" id="csave" disabled>${icon('check', { size: 19, stroke: 2.4 })}Salvar</button></div>`, (el) => {
    const ta = el.querySelector('#note'); ta.value = prefill;
    const parsed = () => parseNote(ta.value, now(), TZ);
    const paint = () => {
      const p = parsed();
      const when = draft.when !== undefined ? draft.when : p.when;
      const kind = draft.kind || p.kind, context = draft.context || p.context || 'pessoal';
      el.querySelector('#cwhen').innerHTML = when ? `<button class="chip when" data-cact="when">${icon('bell', { size: 15 })}${whenLabel(when)}</button><button class="chip" data-cact="nowhen">${icon('x', { size: 13 })}Sem lembrete</button>` : `<button class="chip when none" data-cact="when">${icon('plus', { size: 15 })}Escolher quando lembrar</button>`;
      el.querySelector('#ckind').innerHTML = kinds.map(([k, l]) => `<button class="chip ${k === kind ? 'on' : ''}" data-kind="${k}">${l}</button>`).join('');
      el.querySelector('#cctx').innerHTML = Object.entries(CONTEXTS).map(([k, c]) => `<button class="chip ${k === context ? 'on' : ''}" data-ctx="${k}"><i class="c" style="background:${c.color}"></i>${c.label}</button>`).join('');
      el.querySelector('#csave').disabled = !ta.value.trim();
      el.querySelector('#csave').innerHTML = `${icon('check', { size: 19, stroke: 2.4 })}${when ? `Salvar e lembrar ${dayLabel(when, false)}, ${T(when)}` : 'Salvar'}`;
      return { when, kind, context };
    };
    ta.addEventListener('input', paint);
    el.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.kind) { draft.kind = b.dataset.kind; paint(); }
      if (b.dataset.ctx) { draft.context = b.dataset.ctx; paint(); }
      if (b.dataset.cact === 'nowhen') { draft.when = null; paint(); }
      if (b.dataset.cact === 'when') {
        const cur = paint().when || new Date(now().getTime() + 3600e3);
        const inp = document.createElement('input'); inp.type = 'datetime-local'; inp.value = localInput(cur); inp.className = 'chip'; inp.style.cssText = 'height:36px;padding:0 10px';
        inp.onchange = () => { if (inp.value) { draft.when = fromLocalInput(inp.value); paint(); } };
        b.replaceWith(inp); inp.focus(); inp.showPicker?.();
      }
    });
    el.querySelector('#caq').onclick = (e) => { draft.allowQuiet = !draft.allowQuiet; e.currentTarget.classList.toggle('on', draft.allowQuiet); };
    el.querySelector('#mic').onclick = () => {
      if (rec) { rec.stop(); return; }
      if (!SR) { ta.focus(); el.querySelector('#mhint').textContent = 'Toque no microfone do teclado para ditar'; toast('Use o microfone do teclado do iPhone para ditar', { ic: 'mic' }); return; }
      const base = ta.value ? ta.value.trim() + ' ' : '';
      rec = new SR(); rec.lang = 'pt-BR'; rec.interimResults = true; rec.continuous = false;
      const mic = el.querySelector('#mic');
      rec.onstart = () => { mic.classList.add('rec'); el.querySelector('#micl').textContent = 'Ouvindo'; el.querySelector('#mhint').textContent = 'Fale normalmente…'; };
      rec.onresult = (ev) => { ta.value = base + [...ev.results].map((r) => r[0].transcript).join(' '); paint(); };
      rec.onerror = (ev) => { toast(ev.error === 'not-allowed' ? 'Microfone bloqueado. Libere em Ajustes › Prumo.' : 'Não consegui ouvir. Tente de novo ou use o teclado.', { err: true, ic: 'mic' }); };
      rec.onend = () => { mic.classList.remove('rec'); el.querySelector('#micl').textContent = 'Falar'; el.querySelector('#mhint').textContent = 'Fale ou escreva do seu jeito'; rec = null; };
      try { rec.start(); } catch { rec = null; }
    };
    el.querySelector('#csave').onclick = async () => {
      const { when, kind, context } = paint();
      const title = ta.value.trim().replace(/^./, (c) => c.toUpperCase());
      const r = await safe(() => store.create({ title, kind, context, when: when ? when.toISOString() : null, allowQuiet: draft.allowQuiet })); if (!r) return;
      S = r.state; render();
      el.querySelector('#cbody').innerHTML = `<div class="success"><div class="ring">${icon('check', { size: 38, stroke: 2.6 })}</div><h4>Anotado.</h4><p>${when ? `Te lembro ${dayLabel(when, false)} às ${T(when)}.` : 'Está nas suas pendências.'}</p></div>`;
      setTimeout(() => { closeSheet(); toast(when ? `Lembrete criado · ${whenLabel(when)}` : 'Anotação salva', { undo: r.undo, ic: 'check' }); }, 1300);
    };
    paint();
    setTimeout(() => ta.focus(), 350);
  });
  return sh;
}

// ---------- toast e banner ----------
let toastTimer;
function toast(msg, { undo, ic = 'check', err = false, ms = 5000 } = {}) {
  let t = $('.toast'); if (!t) { t = document.createElement('div'); t.className = 'toast'; t.setAttribute('role', 'status'); document.body.append(t); }
  t.className = `toast ${err ? 'err' : ''}`;
  t.innerHTML = `${icon(ic, { size: 20, cls: 'lead', stroke: 2.2 })}<span class="msg">${esc(msg)}</span>${undo ? `<button class="undo">${icon('undo', { size: 16, stroke: 2.2 })}Desfazer</button>` : ''}<span class="bar3"><i style="animation-duration:${ms}ms"></i></span>`;
  if (undo) t.querySelector('.undo').onclick = async () => { clearTimeout(toastTimer); t.classList.remove('on'); const st = await safe(() => store.undo(undo)); if (st) { S = st; render(); toast('Desfeito', { ic: 'undo', ms: 1800 }); } };
  requestAnimationFrame(() => t.classList.add('on'));
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('on'), ms);
}
let bannerTimer;
function inAppBanner(p) {
  let b = $('.inbanner'); if (!b) { b = document.createElement('button'); b.className = 'inbanner'; document.body.append(b); }
  b.innerHTML = `<img class="appic" src="icons/icon-180.png" alt=""><div style="flex:1;min-width:0"><div style="display:flex"><b>${esc(p.title)}</b><small>agora</small></div><span>${esc(p.body)}</span></div>`;
  b.onclick = () => { b.classList.remove('on'); location.hash = p.url.replace('./', ''); };
  requestAnimationFrame(() => b.classList.add('on'));
  clearTimeout(bannerTimer); bannerTimer = setTimeout(() => b.classList.remove('on'), 5500);
}

// ---------- push ----------
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
async function refreshPushStatus() {
  let state;
  if (!('serviceWorker' in navigator) || !('Notification' in window) || !('PushManager' in window)) state = isIOS && !standalone() ? 'install' : 'unsupported';
  else if (isIOS && !standalone()) state = 'install';
  else if (Notification.permission === 'denied') state = 'denied';
  else if (Notification.permission === 'default') state = 'ask';
  else if (store.mode === 'server') { const sub = await swReg?.pushManager.getSubscription().catch(() => null); state = sub ? 'on' : 'noserver'; }
  else state = 'on';
  ui.push = { state };
}
async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { await refreshPushStatus(); render(); return toast('Sem permissão, não consigo avisar você', { err: true, ic: 'bellOff' }); }
  if (store.mode === 'server') {
    try {
      const key = await store.vapidKey();
      const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
      await store.subscribe(sub.toJSON());
    } catch (e) { toast(`Não consegui registrar o aparelho: ${e.message}`, { err: true, ic: 'alert' }); }
  }
  await refreshPushStatus(); render(); toast('Notificações ativadas', { ic: 'bell' });
}
async function deliverLocal(p) {
  if (swReg && 'Notification' in window && Notification.permission === 'granted') {
    await swReg.showNotification(p.title, { body: p.body, tag: p.tag, data: { url: p.url, itemId: p.itemId, kind: p.kind }, icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', actions: p.actions?.slice(0, 2) });
  }
  if (document.visibilityState === 'visible') inAppBanner(p);
}
async function testPush() {
  const at = T(now());
  const r = await safe(() => store.sendTest()); if (!r) return;
  if (store.mode === 'server') ui.lastTest = r.sent ? `Enviado pelo servidor às ${at} para ${r.sent} aparelho${r.sent > 1 ? 's' : ''}. Bloqueie a tela e confira se chegou.` : `O servidor não achou nenhum aparelho registrado. Toque em Ativar primeiro.`;
  else ui.lastTest = `Teste local às ${at}. Para testar com o app fechado, conecte o servidor.`;
  render();
}

// ---------- ações ----------
async function safe(fn) {
  try { const r = await fn(); if (ui.error && store.mode === 'server') ui.error = null; return r; }
  catch (e) { ui.error = `Não consegui falar com o servidor (${e.message}). Tente de novo.`; render(); toast('Não deu certo. Nada foi alterado.', { err: true, ic: 'alert' }); return null; }
}
async function complete(id) {
  const el = document.querySelector(`.row[data-id="${id}"]`); el?.classList.add('leaving');
  const it = S.items.find((x) => x.id === id);
  await new Promise((r) => setTimeout(r, el ? 220 : 0));
  const r = await safe(() => store.complete(id)); if (!r) return;
  S = r.state;
  if (route().parts[0] === 'item') history.back(); else render();
  toast(`Concluído · ${it?.title.slice(0, 32)}${it?.title.length > 32 ? '…' : ''}`, { undo: r.undo, ic: 'check' });
}
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]'); if (!b) return;
  const { act, id } = b.dataset;
  if (act !== 'open' && act !== 'go' && b.tagName !== 'A') e.preventDefault();
  switch (act) {
    case 'open': location.hash = `#/item/${id}`; break;
    case 'go': location.hash = b.dataset.to; break;
    case 'back': history.length > 1 ? history.back() : (location.hash = '#/hoje'); break;
    case 'snooze': openSnooze(id); break;
    case 'remind': openSnooze(id, 'remind'); break;
    case 'done': complete(id); break;
    case 'reopen': { const it = S.items.find((x) => x.id === id); const r = await store.undo({ items: S.items.map((x) => (x.id === id ? { ...x, status: 'open', completedAt: null } : x)), reminders: S.reminders }); S = r; render(); toast('Reaberto', { ic: 'undo' }); break; }
    case 'reply': toast(store.mode === 'server' ? 'Abrindo a conversa…' : 'Resposta direta chega com a integração do WhatsApp/webmail', { ic: 'chat' }); break;
    case 'compose': openCompose(); break;
    case 'close-sheet': closeSheet(); break;
    case 'seg': location.hash = `#/pendencias?seg=${b.dataset.seg}`; break;
    case 'day': ui.day = +b.dataset.d; render(); break;
    case 'toggle': { const k = b.dataset.key; const st = await safe(() => store.updateSettings({ [k]: !S.settings[k] })); if (st) { S = st; render(); toast('Ajuste salvo', { ic: 'check', ms: 1800 }); } break; }
    case 'enable-push': enablePush(); break;
    case 'test-push': testPush(); break;
    case 'retry': ui.error = null; ui.loading = true; render(); setTimeout(async () => { ui.loading = false; const st = await safe(() => store.init()); if (st) S = st; render(); toast('Atualizado', { ic: 'refresh', ms: 1800 }); }, 700); break;
    case 'sim-incoming': { const r = await safe(() => store.simulateIncoming()); if (r) { S = r.state; render(); if (!r.sent?.length) toast('Mensagem recebida — agrupada com o alerta anterior desta conversa', { ic: 'chat' }); } break; }
    case 'sim-empty': ui.emptyDemo = !ui.emptyDemo; location.hash = ui.emptyDemo ? '#/hoje' : location.hash; render(); break;
    case 'sim-error': ui.error = ui.error ? null : 'Não consegui atualizar agora. Mostrando o que tinha às ' + T(now()) + '.'; location.hash = ui.error ? '#/hoje' : location.hash; render(); break;
    case 'sim-loading': ui.loading = true; location.hash = '#/hoje'; render(); setTimeout(() => { ui.loading = false; render(); }, 1800); break;
    case 'reset': S = store.reset ? store.reset() : S; ui.emptyDemo = false; ui.error = null; render(); toast('Dados de exemplo restaurados', { ic: 'refresh' }); break;
    case 'connect': { const url = $('#srvUrl').value.trim(), key = $('#srvKey').value.trim(); if (!url || !key) return toast('Preencha o endereço e a chave', { err: true, ic: 'alert' }); saveServerConfig({ url, key }); location.reload(); break; }
    case 'disconnect': saveServerConfig(null); location.reload(); break;
  }
});
document.addEventListener('change', async (e) => {
  const k = e.target.dataset.set; if (!k || !e.target.value) return;
  const st = await safe(() => store.updateSettings({ [k]: e.target.value })); if (st) { S = st; render(); toast('Horário salvo', { ic: 'clock', ms: 1800 }); }
});
window.addEventListener('hashchange', () => { closeSheet(true); render(); window.scrollTo(0, 0); });

// ---------- início ----------
async function boot() {
  store = createStore(deliverLocal);
  render();
  if ('serviceWorker' in navigator) {
    try { swReg = await navigator.serviceWorker.register('./sw.js'); await navigator.serviceWorker.ready; } catch (e) { console.warn('SW', e); }
    navigator.serviceWorker.addEventListener('message', (ev) => { if (ev.data?.resubscribe && store.mode === 'server' && Notification.permission === 'granted') enablePush(); if (ev.data?.navigate) location.hash = ev.data.navigate.replace(/^\.?\/?/, '').replace(/^#?/, '#'); });
  }
  try { S = await store.init(); } catch (e) { ui.error = `Não consegui carregar do servidor (${e.message}).`; }
  ui.loading = false;
  if (store.inboxStatus) ui.inbox = await store.inboxStatus().catch(() => null);
  await refreshPushStatus();
  render();
  const tick = async () => { if (store.mode === 'demo' && !ui.loading) { const sent = await store.tick(); if (sent.length) { S = store.state(); render(); } } };
  setInterval(tick, 15000); tick();
  document.addEventListener('visibilitychange', async () => { if (document.visibilityState === 'visible') { if (store.mode === 'server') { const st = await safe(() => store.init()); if (st) S = st; } await refreshPushStatus(); render(); } });
}
window.__prumo = { get state() { return S; }, ui, openCompose, openSnooze, toast, inAppBanner, render, get store() { return store; } };
boot();
