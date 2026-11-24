// Prumo — camada de dados. Dois modos com a mesma interface:
//  • DemoStore: dados fictícios no aparelho (localStorage) e alertas locais enquanto o app está aberto.
//  • RemoteStore: servidor Supabase (prumo-api) — é ele que agenda e envia o push com o app fechado.
import { DEFAULT_SETTINGS, planDispatch, rescheduleItem, cancelForItem, localDateKey } from './shared/scheduler.js';
import { demoItems, demoIncoming } from './demo-data.js';

const KEY = 'prumo:v1';
const CFG = 'prumo:server';
const uid = (p = 'x') => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const clone = (o) => JSON.parse(JSON.stringify(o));

export function leadTime(item) {
  if (!item.dueAt) return null;
  const t = new Date(item.dueAt).getTime();
  if (item.kind === 'compromisso') return new Date(t - 15 * 60e3).toISOString();
  if (item.kind === 'prazo') return new Date(t - 60 * 60e3).toISOString();
  return item.dueAt;
}

export function serverConfig() { try { return JSON.parse(localStorage.getItem(CFG)) || null; } catch { return null; } }
export function saveServerConfig(cfg) { if (cfg) localStorage.setItem(CFG, JSON.stringify(cfg)); else localStorage.removeItem(CFG); }

class DemoStore {
  mode = 'demo';
  constructor(deliver) { this.deliver = deliver; }
  async init() {
    try { this.s = JSON.parse(localStorage.getItem(KEY)); } catch { this.s = null; }
    if (!this.s || this.s.version !== 3) this.reset(false);
    await new Promise((r) => setTimeout(r, 450)); // mostra o estado de carregamento
    return this.state();
  }
  reset(save = true) {
    const items = demoItems(new Date());
    const reminders = [];
    for (const i of items) {
      const at = i.reminderAt || leadTime(i);
      if (i.status === 'open' && at && new Date(at) > new Date()) reminders.push({ id: uid('r'), itemId: i.id, kind: 'reminder', fireAt: at, allowQuiet: false, status: 'scheduled' });
    }
    this.s = { version: 3, items, reminders, settings: { ...DEFAULT_SETTINGS }, log: [{ kind: 'summary', day: localDateKey(new Date(), DEFAULT_SETTINGS.tz) }], incoming: 0 };
    if (save) this.save();
    return this.state();
  }
  save() { localStorage.setItem(KEY, JSON.stringify(this.s)); }
  state() { return clone({ items: this.s.items, reminders: this.s.reminders, settings: this.s.settings, log: this.s.log.slice(-30) }); }
  item(id) { return this.s.items.find((i) => i.id === id); }
  checkpoint() { return { items: clone(this.s.items), reminders: clone(this.s.reminders) }; }

  async snooze(id, until, allowQuiet = false) {
    const undo = this.checkpoint();
    const it = this.item(id);
    it.snoozedUntil = new Date(until).toISOString();
    (it.history ||= []).push({ at: new Date().toISOString(), what: 'Adiado' });
    this.s.reminders = rescheduleItem(this.s.reminders, id, until, allowQuiet, uid('r'));
    this.save();
    return { state: this.state(), undo };
  }
  async complete(id) {
    const undo = this.checkpoint();
    const it = this.item(id);
    it.status = 'done'; it.completedAt = new Date().toISOString();
    this.s.reminders = cancelForItem(this.s.reminders, id);
    this.save();
    return { state: this.state(), undo };
  }
  async setReminder(id, fireAt, allowQuiet) {
    this.s.reminders = rescheduleItem(this.s.reminders, id, fireAt, allowQuiet, uid('r'));
    this.save();
    return this.state();
  }
  async undo(token) { this.s.items = token.items; this.s.reminders = token.reminders; this.save(); return this.state(); }
  async create({ title, kind, context, when, allowQuiet }) {
    const id = uid('n');
    const it = { id, kind, title, context: context || 'pessoal', channel: 'manual', status: 'open', importance: 'normal', createdAt: new Date().toISOString() };
    if (when) { if (kind === 'retorno') { it.waitingSince = new Date().toISOString(); it.reminderAt = when; } else it.dueAt = when; }
    if (kind === 'retorno' && !it.waitingSince) it.waitingSince = new Date().toISOString();
    const undo = this.checkpoint();
    this.s.items.push(it);
    const at = kind === 'retorno' ? when : (kind === 'compromisso' ? leadTime(it) : when);
    if (at) this.s.reminders.push({ id: uid('r'), itemId: id, kind: 'reminder', fireAt: new Date(at).toISOString(), allowQuiet: !!allowQuiet, status: 'scheduled' });
    this.save();
    return { state: this.state(), undo, item: it };
  }
  async updateSettings(patch) { Object.assign(this.s.settings, patch); this.save(); return this.state(); }
  async simulateIncoming() {
    const n = ++this.s.incoming;
    const msg = demoIncoming(new Date(), n);
    // mensagem nova numa conversa que já está pendente: atualiza a mesma pendência
    let it = this.s.items.find((i) => i.status === 'open' && i.conversationId === msg.conversationId);
    if (it) { it.detail = msg.detail; it.messages = (it.messages || 1) + 1; it.importance = 'alta'; it.lastMessageAt = msg.receivedAt; (it.history ||= []).push({ at: msg.receivedAt, what: 'Nova mensagem' }); }
    else { it = msg; this.s.items.push(it); }
    this.s.reminders.push({ id: uid('r'), itemId: it.id, kind: 'new_item', fireAt: new Date().toISOString(), status: 'scheduled' });
    this.save();
    const sent = await this.tick();
    return { state: this.state(), sent };
  }
  async sendTest() {
    this.s.reminders.push({ id: uid('t'), kind: 'test', fireAt: new Date().toISOString(), status: 'scheduled', allowQuiet: true });
    const sent = await this.tick();
    return { ok: sent.some((x) => x.kind === 'test'), via: 'local' };
  }
  async subscribe() { return { ok: false, reason: 'demo' }; }
  /** Roda as regras de envio (no modo servidor isto acontece no Supabase a cada minuto) */
  async tick(now = new Date()) {
    const plan = planDispatch({ now, reminders: this.s.reminders, items: this.s.items, settings: this.s.settings, log: this.s.log });
    const byId = new Map(this.s.reminders.map((r) => [r.id, r]));
    for (const id of plan.cancel) byId.get(id).status = 'canceled';
    for (const d of plan.defer) Object.assign(byId.get(d.id), { fireAt: d.fireAt, deferred: d.reason });
    for (const x of plan.send) {
      for (const id of x.reminderIds) byId.get(id).status = 'sent';
      this.s.log.push({ kind: x.kind, conversationId: x.conversationId, day: x.day, sentAt: now.toISOString(), title: x.payload.title });
      await this.deliver(x.payload);
    }
    if (plan.send.length || plan.defer.length || plan.cancel.length) this.save();
    return plan.send;
  }
}

class RemoteStore {
  mode = 'server';
  constructor(cfg) { this.cfg = cfg; }
  async call(path, body, method = body ? 'POST' : 'GET') {
    const res = await fetch(`${this.cfg.url.replace(/\/$/, '')}/prumo-api${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-prumo-key': this.cfg.key }, body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`Servidor respondeu ${res.status}`);
    return res.json();
  }
  async init() { return this.call('/state'); }
  async snooze(id, until, allowQuiet) { return this.call(`/items/${id}/snooze`, { until, allowQuiet }); }
  async complete(id) { return this.call(`/items/${id}/done`, {}); }
  async setReminder(id, fireAt, allowQuiet) { return (await this.call(`/items/${id}/reminder`, { fireAt, allowQuiet })).state; }
  async undo(token) { return (await this.call('/undo', token)).state; }
  async create(note) { return this.call('/items', note); }
  async updateSettings(patch) { return (await this.call('/settings', patch, 'PATCH')).state; }
  async simulateIncoming() { return this.call('/ingest/demo', {}); }
  async sendTest() { return this.call('/test', {}); }
  async inboxStatus() { return this.call('/inbox-status'); }
  async vapidKey() { return (await this.call('/config')).vapidPublicKey; }
  async subscribe(sub) { return this.call('/subscribe', { subscription: sub, userAgent: navigator.userAgent }); }
  async tick() { return []; }
}

export function createStore(deliver) {
  const cfg = serverConfig();
  return cfg?.url && cfg?.key ? new RemoteStore(cfg) : new DemoStore(deliver);
}
