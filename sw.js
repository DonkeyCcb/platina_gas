// Service worker de Platina. Vive en la raíz para poder controlar toda la app.
const CACHE = 'platina-v7';
const ASSETS = ['./', './index.html', './css/aero-cobalt.css', './js/voice.js', './js/app.js'];
const NEVER_CACHE = ['firebaseio.com', 'generativelanguage.googleapis.com', 'nominatim.openstreetmap.org'];

self.addEventListener('install', e => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE).then(c => Promise.all(ASSETS.map(a => c.add(a).catch(() => {})))));
});

self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Red primero; si falla, lo guardado. Lo que baja bien (incluidas las tipografías) se guarda para uso sin conexión.
self.addEventListener('fetch', e => {
    const req = e.request;
    if (req.method !== 'GET' || NEVER_CACHE.some(h => req.url.includes(h))) return;
    e.respondWith(
        fetch(req).then(res => {
            if (res && (res.ok || res.type === 'opaque')) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
            return res;
        }).catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
});
