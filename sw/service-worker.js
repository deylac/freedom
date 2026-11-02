/* HashWall service worker — source ; vite.config.ts y injecte la version et la liste des fichiers au build (dist/sw.js). */
const VERSION = '__VERSION__'
const CACHE = 'hashwall-' + VERSION
const ASSETS = __ASSETS__
const NAV_TIMEOUT_MS = 4000

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k.startsWith('hashwall-') && k !== CACHE && k !== CACHE + '-ondemand').map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  )
})

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then((v) => { clearTimeout(t); resolve(v) }, (e) => { clearTimeout(t); reject(e) })
  })
}

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // Jamais de cache pour les relais / serveurs Blossom / autres origines.
  if (url.origin !== self.location.origin) return
  if (!url.href.startsWith(self.registration.scope)) return

  if (req.mode === 'navigate') {
    // Réseau d'abord (mises à jour), cache en secours (domaine bloqué, hors-ligne, DNS menteur).
    event.respondWith(
      withTimeout(fetch(req), NAV_TIMEOUT_MS)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(new URL('./', self.registration.scope).href, copy))
          }
          return res
        })
        .catch(() => caches.match(new URL('./', self.registration.scope).href)),
    )
    return
  }

  // Détecteur de visages (WASM, modèle) : mis en cache au premier usage, puis hors ligne.
  const path = url.href.slice(self.registration.scope.length)
  if (/^(ort|models)\//.test(path)) {
    event.respondWith(
      caches.open(CACHE + '-ondemand').then((cache) =>
        cache.match(req).then(
          (hit) =>
            hit ||
            fetch(req).then((res) => {
              if (res.ok) cache.put(req, res.clone())
              return res
            }),
        ),
      ),
    )
    return
  }

  event.respondWith(caches.match(req).then((hit) => hit || fetch(req)))
})
