// Service worker do app de campo: deixa a casca abrir sem internet. Funciona em qualquer subcaminho (ex.: GitHub Pages).
// Só guarda HTML/JS/CSS; dados da API nunca vão para o cache.
const VERSAO = 'irrivert-campo-v1';
const BASE = new URL(self.registration.scope).pathname; // ex.: "/" ou "/irrivert-campo-demo/"
self.addEventListener('install', (e) => { e.waitUntil(caches.open(VERSAO).then((c) => c.addAll([BASE, `${BASE}icone.svg`, `${BASE}manifest-campo.webmanifest`]))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.includes('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match(BASE)));
    return;
  }
  e.respondWith(
    fetch(e.request).then((r) => { if (r.ok) { const copia = r.clone(); caches.open(VERSAO).then((c) => c.put(e.request, copia)); } return r; })
      .catch(() => caches.match(e.request)),
  );
});
