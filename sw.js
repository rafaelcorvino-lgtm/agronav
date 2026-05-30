/* AgroNav service worker
   Estratégia:
   - Arquivos do próprio app (mesma origem): REDE PRIMEIRO → sempre pega a versão nova
     quando há internet; cai pro cache só offline. (evita ficar preso em versão velha)
   - Recursos externos (tiles do mapa, Leaflet, FontAwesome): CACHE PRIMEIRO → rápido e
     funciona offline depois da 1ª visita. */
const CACHE = 'agronav-v25';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './data/aerodromes.js',
  './data/br-airports.json',
  './data/br-runways.json',
  './data/br-airspace.json',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => Promise.allSettled(SHELL.map(u => c.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const sameOrigin = new URL(e.request.url).origin === self.location.origin;

  if (sameOrigin) {
    // REDE PRIMEIRO p/ arquivos do app — cache:'reload' ignora o cache HTTP do navegador
    // (assim pega SEMPRE a versão mais nova do servidor); cai pro cache só offline.
    e.respondWith(
      fetch(new Request(e.request.url, { cache: 'reload' })).then(resp => {
        if (resp && resp.status === 200) {
          const copy = resp.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return resp;
      }).catch(() => caches.match(e.request))
    );
  } else {
    // CACHE PRIMEIRO p/ tiles e libs externas
    e.respondWith(
      caches.match(e.request).then(cached => {
        const network = fetch(e.request).then(resp => {
          if (resp && resp.status === 200) {
            const copy = resp.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
          }
          return resp;
        }).catch(() => cached);
        return cached || network;
      })
    );
  }
});
