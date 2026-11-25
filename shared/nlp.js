// Prumo — entende datas e horas em português numa anotação ("ligar pro Marcos amanhã às 10").
import { tzParts, zoned } from './scheduler.js';

const WEEKDAYS = { domingo: 0, segunda: 1, 'segunda-feira': 1, terca: 2, 'terca-feira': 2, quarta: 3, 'quarta-feira': 3, quinta: 4, 'quinta-feira': 4, sexta: 5, 'sexta-feira': 5, sabado: 6 };
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

export function parseNote(text, now = new Date(), tz = 'America/Sao_Paulo') {
  const t = strip(text);
  const p = tzParts(now, tz);
  let dayOffset = null, hh = null, mm = 0, relMin = null;
  const found = [];

  let m;
  if ((m = t.match(/\b(?:em|daqui(?: a)?)\s+(\d{1,3})\s*(min|minutos?|h|horas?)\b/))) {
    relMin = +m[1] * (m[2].startsWith('h') ? 60 : 1); found.push(m[0]);
  }
  if (/\bdepois de amanha\b/.test(t)) { dayOffset = 2; found.push('depois de amanhã'); }
  else if (/\bamanha\b/.test(t)) { dayOffset = 1; found.push('amanhã'); }
  else if (/\bhoje\b/.test(t)) { dayOffset = 0; found.push('hoje'); }
  else {
    const wd = t.match(/\b(?:na |no |proxima |proximo )?(domingo|segunda(?:-feira)?|terca(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|sabado)\b/);
    if (wd) { const target = WEEKDAYS[wd[1]]; let d = (target - p.wd + 7) % 7; if (d === 0) d = 7; dayOffset = d; found.push(wd[0].trim()); }
    const dm = t.match(/\bdia (\d{1,2})(?:\/(\d{1,2}))?\b/);
    if (dm && dayOffset === null) {
      const day = +dm[1], mon = dm[2] ? +dm[2] : p.m;
      let target = zoned(p.y, mon, day, 0, 0, tz);
      if (target < zoned(p.y, p.m, p.d, 0, 0, tz)) target = zoned(p.y, mon + (dm[2] ? 12 : 1), day, 0, 0, tz);
      dayOffset = Math.round((target - zoned(p.y, p.m, p.d, 0, 0, tz)) / 864e5); found.push(dm[0]);
    }
  }
  if (relMin === null && ((m = t.match(/\b(?:as|a|ate as|ate)?\s*(\d{1,2})(?:[:h](\d{2}))\b/)) || (m = t.match(/\b(?:as|ate as)\s+(\d{1,2})\b/)) || (m = t.match(/\b(\d{1,2})\s*h(?:oras?)?\b/)))) {
    const h = +m[1];
    if (h <= 23) { hh = h; mm = m[2] ? +m[2] : 0; found.push(m[0].trim()); }
  }
  if (hh === null) {
    if (/\bde manha\b|\bcedo\b/.test(t)) { hh = 9; found.push('de manhã'); }
    else if (/\b(a|de) tarde\b/.test(t)) { hh = 14; found.push('à tarde'); }
    else if (/\b(a|de) noite\b/.test(t)) { hh = 19; found.push('à noite'); }
    else if (/\bmeio-?dia\b/.test(t)) { hh = 12; found.push('meio-dia'); }
  } else if (hh < 12 && /\b(da|a|de) (tarde|noite)\b/.test(t) && hh < 8) hh += 12;

  let when = null;
  if (relMin !== null) when = new Date(new Date(now).getTime() + relMin * 60000);
  else if (dayOffset !== null || hh !== null) {
    const off = dayOffset ?? 0;
    when = zoned(p.y, p.m, p.d + off, hh ?? 9, mm, tz);
    if (dayOffset === null && when <= now) when = zoned(p.y, p.m, p.d + 1, hh, mm, tz); // hora que já passou -> amanhã
  }

  let kind = 'nota';
  if (/\b(cobrar|retorno|esperando|aguardando|ver se (ele|ela) respondeu)\b/.test(t)) kind = 'retorno';
  else if (/\b(reuniao|visita|consulta|almoco com|jantar com|encontro|call)\b/.test(t)) kind = 'compromisso';
  else if (/\b(pagar|enviar|entregar|prazo|vence|vencimento|ate)\b/.test(t)) kind = 'prazo';

  let context = null;
  if (/\b(mae|pai|filh[oa]s?|esposa|familia|escola|casa)\b/.test(t)) context = 'familia';
  else if (/\b(steak|churrasc|carne|frigorifico|camara fria|garcom|cozinha)\b/.test(t)) context = 'nc-steak';
  else if (/\b(emporio|vinho|loja|clube)\b/.test(t)) context = 'emporio';
  else if (/\b(distribuidora|tabela|representante|oferta)\b/.test(t)) context = 'distribuidora';

  return { when, kind, context, matched: found };
}

// ---------- rotinas (coisas que se repetem na semana) ----------
const WD_TOKENS = [[0, /\b(dom|domingos?)\b/], [1, /\b(seg|segundas?(?:-feiras?)?)\b/], [2, /\b(ter|tercas?(?:-feiras?)?)\b/], [3, /\b(qua|quartas?(?:-feiras?)?)\b/],
  [4, /\b(qui|quintas?(?:-feiras?)?)\b/], [5, /\b(sex|sextas?(?:-feiras?)?)\b/], [6, /\b(sab|sabados?)\b/]];
/** "academia seg, qua e sex 6h30", "toda terça e quinta", "todo dia às 7", "dias úteis" → { days: [1,3,5] } ou null */
export function parseRepeat(text) {
  const t = strip(String(text || ''));
  if (/\b(todo dia|todos os dias|diariamente)\b/.test(t)) return { days: [0, 1, 2, 3, 4, 5, 6] };
  if (/\b(dias uteis|de segunda a sexta|seg(?:unda)? a sex(?:ta)?)\b/.test(t)) return { days: [1, 2, 3, 4, 5] };
  const days = WD_TOKENS.filter(([, re]) => re.test(t)).map(([d]) => d);
  const every = /\b(tod[ao]s?|sempre|toda semana|semanal)\b/.test(t) || /\b(segundas|tercas|quartas|quintas|sextas|sabados|domingos)\b/.test(t);
  if (days.length >= 2 || (days.length === 1 && every)) return { days };
  if (/\b(\d)\s*x\s*(por|na) semana\b/.test(t)) { const n = +t.match(/\b(\d)\s*x/)[1]; return { days: { 1: [1], 2: [2, 4], 3: [1, 3, 5], 4: [1, 2, 4, 5], 5: [1, 2, 3, 4, 5], 6: [1, 2, 3, 4, 5, 6] }[n] || [1, 3, 5] }; }
  return null;
}
