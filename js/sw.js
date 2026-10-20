const CACHE = 'platina-v6';
const ASSETS = ['./', './index.html', './css/aero-cobalt.css', './js/app.js'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))));
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET' || e.request.url.includes('firebaseio') || e.request.url.includes('googleapis')) return;
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
