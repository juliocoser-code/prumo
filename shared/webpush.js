// Prumo — envio de Web Push (RFC 8291 aes128gcm + VAPID RFC 8292) usando apenas Web Crypto.
// Funciona no Deno (Supabase Edge Functions) e no Node 20+. É o mesmo protocolo que o iPhone
// usa para push de apps instalados na Tela de Início (endpoint web.push.apple.com).

const enc = new TextEncoder();
const subtle = globalThis.crypto.subtle;

export function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function unb64u(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, len) {
  const key = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

/** Gera o par de chaves VAPID (rodar uma vez e guardar como segredo) */
export async function generateVapidKeys() {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const jwk = await subtle.exportKey('jwk', kp.privateKey);
  return { publicKey: b64u(pub), privateKey: jwk.d };
}

async function vapidKey(publicKey, privateKey) {
  const pub = unb64u(publicKey);
  const jwk = { kty: 'EC', crv: 'P-256', d: privateKey, x: b64u(pub.slice(1, 33)), y: b64u(pub.slice(33, 65)), ext: true };
  return subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
}

export async function vapidHeader(endpoint, { subject, publicKey, privateKey }, nowSec = Math.floor(Date.now() / 1000)) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: nowSec + 12 * 3600, sub: subject })));
  const key = await vapidKey(publicKey, privateKey);
  const sig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`)));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${publicKey}`;
}

/** Criptografa o conteúdo para a assinatura do aparelho (aes128gcm, um único registro) */
export async function encryptPayload(plaintext, p256dh, auth, { salt, asKeys } = {}) {
  const uaPub = unb64u(p256dh);
  const authSecret = unb64u(auth);
  const as = asKeys || await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await subtle.exportKey('raw', as.publicKey));
  const uaKey = await subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  salt = salt || globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const data = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(data, new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]); // 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}

/**
 * Envia uma notificação. Retorna {ok, status, expired}.
 * expired=true quando o aparelho desinstalou/revogou (404/410) — apagar a assinatura.
 */
export async function sendPush(subscription, payload, vapid, { ttl = 86400, urgency = 'high', topic, fetchImpl = fetch } = {}) {
  const body = await encryptPayload(JSON.stringify(payload), subscription.keys.p256dh, subscription.keys.auth);
  const headers = {
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    TTL: String(ttl),
    Urgency: urgency,
    Authorization: await vapidHeader(subscription.endpoint, vapid),
  };
  if (topic) headers.Topic = topic.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const res = await fetchImpl(subscription.endpoint, { method: 'POST', headers, body });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, expired: res.status === 404 || res.status === 410, text: res.ok ? '' : await res.text().catch(() => '') };
}
