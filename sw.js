// Prumo — service worker: recebe o push com o app fechado, mostra a notificação
// e, ao tocar, abre direto o item correspondente.
const VERSION = 'prumo-0.1.0';
const SHELL = ['./', './index.html', './styles.css', './app.js', './store.js', './icons.js', './demo-data.js',
  './shared/scheduler.js', './shared/nlp.js', './fonts/Lora.ttf', './icons/icon-192.png', './icons/icon-180.png', './icons/badge-96.png', './manifest.webmanifest'];

self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // API do servidor nunca vem do cache
  e.respondWith(fetch(e.request).then((r) => { const copy = r.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request)));
});

self.addEventListener('push', (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: 'Prumo', body: e.data?.text() || '' }; }
  // No iPhone todo push PRECISA mostrar uma notificação, senão o iOS revoga a permissão.
  const opts = {
    body: p.body || '', tag: p.tag, renotify: !!p.tag && p.kind === 'new_item',
    icon: './icons/icon-192.png', badge: './icons/badge-96.png', timestamp: Date.now(),
    data: { url: p.url || './#/hoje', itemId: p.itemId, kind: p.kind },
    actions: (p.actions || []).slice(0, 2), // iOS ignora; Mac/Android mostram "Adiar" e "Concluir"
  };
  const tasks = [self.registration.showNotification(p.title || 'Prumo', opts)];
  if (typeof p.badge === 'number' && self.navigator.setAppBadge) tasks.push(self.navigator.setAppBadge(p.badge).catch(() => {}));
  e.waitUntil(Promise.all(tasks));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  let url = e.notification.data?.url || './#/hoje';
  if (e.action === 'snooze' || e.action === 'done') url += (url.includes('?') ? '&' : '?') + 'do=' + e.action;
  const target = new URL(url, self.registration.scope).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = all.find((c) => c.url.startsWith(self.registration.scope));
    if (win) { win.postMessage({ navigate: new URL(target).hash }); await win.focus().catch(() => {}); return; }
    await self.clients.openWindow(target);
  })());
});

self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => cs.forEach((c) => c.postMessage({ resubscribe: true }))));
});
