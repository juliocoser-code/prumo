// Prumo — entrada do WhatsApp pela API oficial da Meta (Cloud API, modo coexistência com o app Business).
//  • field "messages": mensagens que chegaram para você
//  • field "smb_message_echoes": mensagens que VOCÊ mandou pelo app no celular/PC → dá baixa na pendência
const enc = new TextEncoder();
const KIND = { image: 'foto', audio: 'áudio', voice: 'áudio', video: 'vídeo', document: 'documento', sticker: 'figurinha', location: 'localização', contacts: 'contato' };
import { expectsReply } from './inbox.js';

/** Confere a assinatura X-Hub-Signature-256 (HMAC-SHA256 do corpo com o App Secret) */
export async function verifySignature(rawBody, header, appSecret) {
  if (!header?.startsWith('sha256=') || !appSecret) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(appSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, typeof rawBody === 'string' ? enc.encode(rawBody) : rawBody));
  const hex = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const got = header.slice(7).toLowerCase();
  if (got.length !== hex.length) return false;
  let diff = 0; for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ got.charCodeAt(i); // comparação em tempo constante
  return diff === 0;
}

const text = (m) => m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? (m[m.type]?.caption ? `[${KIND[m.type] || m.type}] ${m[m.type].caption}` : `[${KIND[m.type] || m.type}]`);
const fmtPhone = (n) => { const d = String(n).replace(/\D/g, ''); const m = d.match(/^55(\d{2})(\d{4,5})(\d{4})$/); return m ? `(${m[1]}) ${m[2]}-${m[3]}` : '+' + d; };

/** Converte o webhook da Meta em eventos da caixa de entrada. `names` = agenda {telefone: nome} opcional. */
export function webhookToEvents(body, { names = {}, contexts = {} } = {}) {
  const out = [];
  for (const entry of body?.entry || []) for (const ch of entry.changes || []) {
    const v = ch.value || {};
    const profile = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
    const nameOf = (n) => names[n] || profile[n] || fmtPhone(n);
    if (ch.field === 'messages') {
      for (const m of v.messages || []) {
        if (m.type === 'reaction' || m.type === 'system' || m.type === 'unsupported') continue;
        const t = text(m);
        out.push({ type: 'in', channel: 'whatsapp', conversationId: `wa-${m.from}`, person: nameOf(m.from), from: m.from,
          title: t.length > 60 ? t.slice(0, 57) + '…' : t, detail: t, at: new Date(+m.timestamp * 1000).toISOString(), messageId: m.id, context: contexts[m.from] || 'pessoal' });
      }
    } else if (ch.field === 'smb_message_echoes') {
      for (const m of v.message_echoes || []) {
        const t = text(m);
        out.push({ type: 'out', channel: 'whatsapp', conversationId: `wa-${m.to}`, person: nameOf(m.to), title: t.slice(0, 60), detail: t,
          at: new Date(+m.timestamp * 1000).toISOString(), messageId: m.id, expectsReply: expectsReply(t), context: contexts[m.to] || 'pessoal' });
      }
    }
    // "history" (sincronização inicial de até 6 meses) e "statuses" são ignorados aqui.
  }
  return out;
}
