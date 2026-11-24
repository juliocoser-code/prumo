// Prumo — transforma e-mails em eventos da caixa de entrada.
import { expectsReply } from './inbox.js';

const latin = new TextDecoder('latin1');
function decodeBytes(bytes, charset = 'utf-8') {
  const cs = String(charset).toLowerCase().replace(/^(us-ascii|ascii)$/, 'utf-8');
  try { return new TextDecoder(cs).decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}
const bin = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 255);
function b64(s) { try { return bin(atob(s.replace(/\s+/g, ''))); } catch { return new Uint8Array(0); } }
function qp(s, header = false) {
  if (header) s = s.replace(/_/g, ' ');
  return bin(s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
}
/** =?UTF-8?B?...?= e =?ISO-8859-1?Q?...?= */
export function decodeWords(v) {
  return String(v || '').replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, '$1')
    .replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, cs, e, t) => decodeBytes(e.toLowerCase() === 'b' ? b64(t) : qp(t, true), cs));
}
export function parseHeaders(bytes) {
  const raw = (typeof bytes === 'string' ? bytes : latin.decode(bytes)).replace(/\r?\n[ \t]+/g, ' ');
  const h = {};
  for (const line of raw.split(/\r?\n/)) { const i = line.indexOf(':'); if (i > 0) { const k = line.slice(0, i).trim().toLowerCase(); if (!(k in h)) h[k] = line.slice(i + 1).trim(); } }
  return h;
}
export function parseAddress(v) {
  v = decodeWords(v);
  const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>/);
  const email = (m ? m[2] : v).trim().toLowerCase();
  const name = (m && m[1].trim()) || email.split('@')[0];
  return { name, email };
}
const ctParam = (ct, p) => ((ct || '').match(new RegExp(p + '\\s*=\\s*"?([^";]+)"?', 'i')) || [])[1];

/** Primeira parte de texto legível do corpo (multipart, base64, quoted-printable, html) */
export function bodyText(headers, textBytes) {
  let ct = headers['content-type'] || 'text/plain', cte = headers['content-transfer-encoding'] || '7bit';
  let body = latin.decode(textBytes);
  for (let depth = 0; depth < 4 && /multipart\//i.test(ct); depth++) {
    const boundary = ctParam(ct, 'boundary'); if (!boundary) break;
    const parts = body.split('--' + boundary).slice(1).filter((p) => !p.startsWith('--'));
    const parsed = parts.map((p) => { const i = p.search(/\r?\n\r?\n/); const ph = parseHeaders(p.slice(0, i)); return { ph, body: p.slice(i).replace(/^\r?\n\r?\n/, '') }; });
    const pick = parsed.find((p) => /text\/plain/i.test(p.ph['content-type'] || 'text/plain')) || parsed.find((p) => /multipart|text\/html/i.test(p.ph['content-type'] || '')) || parsed[0];
    if (!pick) break;
    ct = pick.ph['content-type'] || 'text/plain'; cte = pick.ph['content-transfer-encoding'] || '7bit'; body = pick.body;
  }
  const bytes = /base64/i.test(cte) ? b64(body) : /quoted/i.test(cte) ? qp(body) : bin(body);
  let text = decodeBytes(bytes, ctParam(ct, 'charset') || 'utf-8');
  if (/html/i.test(ct)) text = text.replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  return cleanReply(text);
}
/** Tira citações da mensagem anterior e assinaturas, para ficar só o que a pessoa escreveu */
export function cleanReply(t) {
  const lines = t.replace(/\r/g, '').split('\n');
  const out = [];
  for (const l of lines) {
    if (/^\s*>/.test(l)) continue;
    if (/^(em|on) .{6,120}(escreveu|wrote):?\s*$/i.test(l.trim()) || /^-{2,}\s*(mensagem original|original message|forwarded)/i.test(l.trim()) || /^(de|from):\s.+/i.test(l.trim()) && out.length) break;
    if (/^--\s*$/.test(l) || /^enviado do meu (iphone|android|celular)/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 600);
}

const ROBOT = /(^|[.+_-])(no-?reply|nao-?responda|naoresponda|donotreply|mailer-daemon|postmaster|notifica\w*|news(letter)?|marketing|bounce)/i;
export function isAutomated(h, from) {
  if (h['list-unsubscribe'] || h['list-id']) return true;
  if (/bulk|list|junk/i.test(h.precedence || '')) return true;
  if (h['auto-submitted'] && !/^no$/i.test(h['auto-submitted'])) return true;
  if (ROBOT.test(from.email.split('@')[0])) return true;
  return false;
}
export function conversationId(h) {
  const ids = `${h.references || ''} ${h['in-reply-to'] || ''}`.match(/<[^>]+>/g);
  const root = ids?.[0] || (h['message-id'] || '').match(/<[^>]+>/)?.[0];
  if (root) return 'em-' + root.slice(1, -1).toLowerCase();
  return 'em-s-' + subjectOf(h).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60);
}
export const subjectOf = (h) => decodeWords(h.subject || '(sem assunto)').replace(/^\s*((re|res|enc|fw|fwd|rv)\s*:\s*)+/i, '').trim() || '(sem assunto)';

/**
 * @param msg {header, text} vindos do IMAP; folder 'inbox' | 'sent'; me = seus endereços
 * @returns evento ou null (newsletter, robô, cópia de você mesmo)
 */
export function mailToEvent(msg, folder, { me = [], contexts = {} } = {}) {
  const h = parseHeaders(msg.header);
  const from = parseAddress(h.from || '');
  const to = parseAddress((h.to || '').split(',')[0] || '');
  const mine = me.map((x) => x.toLowerCase());
  const date = new Date(h.date || Date.now());
  const at = isNaN(date) ? new Date().toISOString() : date.toISOString();
  const detail = bodyText(h, msg.text);
  const ev = { channel: 'email', conversationId: conversationId(h), title: subjectOf(h), detail, at, messageId: (h['message-id'] || `uid-${folder}-${msg.uid}`).trim() };
  const who = folder === 'sent' ? to : from;
  ev.person = who.name; ev.from = who.email;
  const dom = who.email.split('@')[1] || '';
  ev.context = Object.entries(contexts).find(([d]) => dom.endsWith(d))?.[1] || 'pessoal';
  if (folder === 'sent') return { ...ev, type: 'out', expectsReply: expectsReply(detail) };
  if (mine.includes(from.email) || isAutomated(h, from)) return null;
  return { ...ev, type: 'in' };
}

/** Lê INBOX e Enviados a partir do último ponto e devolve os eventos. `state` guarda o último UID de cada pasta. */
export async function pollMailbox(imap, { user, pass, me, contexts, state = {}, sinceDays = 3, now = new Date(), greeted = false }) {
  try { return await poll(imap, { user, pass, me, contexts, state, sinceDays, now, greeted }); }
  finally { await imap.logout(); }
}
async function poll(imap, { user, pass, me, contexts, state, sinceDays, now, greeted }) {
  if (!greeted) await imap.greet();
  await imap.login(user, pass);
  const boxes = await imap.list();
  const sent = boxes.find((b) => b.flags.some((f) => /\\Sent/i.test(f))) || boxes.find((b) => /^(inbox[./])?(sent|enviad|itens enviados|sent items|sent messages)/i.test(b.name));
  const out = [], next = { ...state };
  for (const [folder, box] of [['inbox', 'INBOX'], ['sent', sent?.name]]) {
    if (!box) continue;
    const sel = await imap.select(box);
    const st = state[folder];
    let uids;
    if (st && st.uidValidity === sel.uidValidity) uids = (await imap.search(`UID ${st.lastUid + 1}:*`)).filter((u) => u > st.lastUid);
    else { const d = new Date(now.getTime() - sinceDays * 864e5); uids = await imap.search(`SINCE ${d.getUTCDate()}-${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}-${d.getUTCFullYear()}`); }
    uids = uids.slice(-200);
    for (let i = 0; i < uids.length; i += 25) {
      for (const m of await imap.fetch(uids.slice(i, i + 25))) { const ev = mailToEvent(m, folder, { me, contexts }); if (ev) out.push(ev); }
    }
    next[folder] = { uidValidity: sel.uidValidity, lastUid: Math.max(st?.uidValidity === sel.uidValidity ? st.lastUid : 0, ...uids, 0) };
  }
  return { events: out, state: next, sentFolder: sent?.name || null };
}
