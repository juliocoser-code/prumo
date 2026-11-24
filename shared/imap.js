// Prumo — cliente IMAP mínimo (somente leitura, nunca marca como lido nem apaga).
// Funciona sobre qualquer conexão TLS: Deno.connectTls (Supabase) ou tls.connect (Node, testes).

const enc = new TextEncoder();
const dec = new TextDecoder('latin1'); // bytes crus; a decodificação de charset é feita depois

export class Imap {
  constructor({ readable, write, close }) {
    this.it = readable[Symbol.asyncIterator]();
    this.writeRaw = write; this.closeRaw = close;
    this.buf = new Uint8Array(0); this.n = 0;
  }
  async fill() {
    const { value, done } = await this.it.next();
    if (done) throw new Error('conexão fechada pelo servidor de e-mail');
    const b = new Uint8Array(this.buf.length + value.length); b.set(this.buf); b.set(value, this.buf.length); this.buf = b;
  }
  async line() {
    for (;;) {
      const i = this.buf.indexOf(10);
      if (i >= 0) { const l = dec.decode(this.buf.slice(0, i)).replace(/\r$/, ''); this.buf = this.buf.slice(i + 1); return l; }
      await this.fill();
    }
  }
  async bytes(n) { while (this.buf.length < n) await this.fill(); const b = this.buf.slice(0, n); this.buf = this.buf.slice(n); return b; }
  /** Lê uma resposta lógica (linha + literais {n}) */
  async response() {
    let text = '', lits = [];
    for (;;) {
      const l = await this.line();
      const m = l.match(/\{(\d+)\}$/);
      if (!m) return { text: text + l, lits };
      text += l.slice(0, -m[0].length) + `\u0000${lits.length}\u0000`;
      lits.push(await this.bytes(+m[1]));
    }
  }
  async greet() { const r = await this.response(); if (!/^\* (OK|PREAUTH)/i.test(r.text)) throw new Error('servidor IMAP recusou: ' + r.text); }
  async cmd(c) {
    const tag = 'P' + (++this.n);
    await this.writeRaw(enc.encode(`${tag} ${c}\r\n`));
    const untagged = [];
    for (;;) {
      const r = await this.response();
      if (r.text.startsWith(tag + ' ')) {
        if (!/^\S+ OK/i.test(r.text)) throw new Error(`IMAP: ${c.split(' ')[0]} falhou — ${r.text.slice(tag.length + 1)}`);
        return untagged;
      }
      untagged.push(r);
    }
  }
  q(s) { return '"' + String(s).replace(/(["\\])/g, '\\$1') + '"'; }
  async login(user, pass) { await this.cmd(`LOGIN ${this.q(user)} ${this.q(pass)}`); }
  async list() {
    return (await this.cmd('LIST "" "*"')).map((r) => {
      const m = r.text.match(/^\* LIST \(([^)]*)\) (?:"[^"]*"|NIL) (.+)$/i); if (!m) return null;
      let name = m[2]; if (name.startsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, '$1');
      if (/^\u0000\d+\u0000$/.test(name)) name = dec.decode(r.lits[+name.slice(1, -1)]);
      return { flags: m[1].split(' '), name };
    }).filter(Boolean);
  }
  async select(box) {
    const u = await this.cmd(`EXAMINE ${this.q(box)}`); // EXAMINE = somente leitura
    const v = u.map((r) => r.text.match(/UIDVALIDITY (\d+)/i)).find(Boolean);
    const n = u.map((r) => r.text.match(/UIDNEXT (\d+)/i)).find(Boolean);
    return { uidValidity: v ? +v[1] : 0, uidNext: n ? +n[1] : 0 };
  }
  async search(criteria) {
    const out = [];
    for (const r of await this.cmd(`UID SEARCH ${criteria}`)) { const m = r.text.match(/^\* SEARCH ?(.*)$/i); if (m && m[1]) out.push(...m[1].trim().split(/\s+/).map(Number)); }
    return out;
  }
  /** Cabeçalhos + começo do corpo, sem marcar como lido */
  async fetch(uids) {
    if (!uids.length) return [];
    const rs = await this.cmd(`UID FETCH ${uids.join(',')} (UID BODY.PEEK[HEADER] BODY.PEEK[TEXT]<0.6000>)`);
    return rs.filter((r) => /^\* \d+ FETCH/i.test(r.text)).map((r) => {
      const uid = +(r.text.match(/UID (\d+)/i) || [])[1];
      const idx = (key) => { const m = r.text.match(new RegExp(key.replace(/[[\]<>.]/g, '\\$&') + '(?:<\\d+>)? \u0000(\\d+)\u0000', 'i')); return m ? r.lits[+m[1]] : new Uint8Array(0); };
      return { uid, header: idx('BODY[HEADER]'), text: idx('BODY[TEXT]') };
    });
  }
  async logout() { if (this.closed) return; this.closed = true; try { await Promise.race([this.cmd('LOGOUT'), new Promise((r) => setTimeout(r, 3000))]); } catch {} try { await this.closeRaw?.(); } catch {} }
}
