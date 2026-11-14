const CACHE = 'platina-v7-1';
const ASSETS = ['./', './index.html', './css/aero-cobalt.css', './js/voice.js', './js/app.js'];

self.addEventListener('install', e => {
    self.skipWaiting();
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener('activate', e => {
    e.waitUntil(caches.keys().then(keys => Promise.all(keys.map(k => k !== CACHE && caches.delete(k)))));
});
self.addEventListener('fetch', e => {
    if (e.request.method !== 'GET' || e.request.url.includes('firebaseio') || e.request.url.includes('googleapis') || e.request.url.includes('open-meteo') || e.request.url.includes('osrm')) return;
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});