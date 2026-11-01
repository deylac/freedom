/// <reference types="vitest/config" />
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Content-Security-Policy injectée en <meta> au build.
 * - Une balise <meta> fonctionne aussi sur IPFS / miroirs où l'on ne contrôle pas les en-têtes HTTP.
 * - connect-src/media-src/img-src doivent rester ouverts à `https:` et `wss:` car les relais
 *   et serveurs Blossom sont choisis par les utilisateurs (pas de liste fermée possible).
 * - Le mode `e2e` autorise en plus les serveurs simulés sur la boucle locale.
 */
function cspPlugin(mode: string): Plugin {
  const loopback = mode === 'e2e' ? ' http://127.0.0.1:* ws://127.0.0.1:*' : ''
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    `img-src 'self' https: data: blob:${loopback}`,
    `media-src 'self' https: blob:${loopback}`,
    `connect-src 'self' https: wss:${loopback}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return {
    name: 'hashwall-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<!--CSP-->',
        `<meta http-equiv="Content-Security-Policy" content="${csp}" />`,
      )
    },
  }
}

/** Liste récursive des fichiers de /public (copiés tels quels par Vite). */
function listPublicFiles(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return listPublicFiles(path, root)
    return [relative(root, path).split('\\').join('/')]
  })
}

/**
 * MediaPipe embarque une télémétrie (POST vers odml.pa.googleapis.com toutes les 60 s) : elle
 * révélerait à Google l'adresse IP de quiconque active le floutage. On remplace l'URL par une
 * adresse inerte. Si l'URL disparaît d'une future version, le build échoue : il faudra revérifier.
 */
const MEDIAPIPE_TELEMETRY_URL = 'https://odml.pa.googleapis.com/v1/log'
function mediapipeNoTelemetry(): Plugin {
  return {
    name: 'hashwall-mediapipe-no-telemetry',
    transform(code, id) {
      if (!id.includes('@mediapipe/tasks-vision')) return null
      if (!code.includes(MEDIAPIPE_TELEMETRY_URL)) {
        this.error(`MediaPipe : télémétrie introuvable dans ${id} — auditer la nouvelle version avant de l'utiliser`)
      }
      return { code: code.replaceAll(MEDIAPIPE_TELEMETRY_URL, 'data:,telemetrie-desactivee'), map: null }
    },
  }
}

/** Fichiers WASM du détecteur de visages, servis depuis /mediapipe/ (jamais depuis un CDN). */
const MEDIAPIPE_WASM_DIR = join(process.cwd(), 'node_modules/@mediapipe/tasks-vision/wasm')
const MEDIAPIPE_FILES = ['vision_wasm_internal.js', 'vision_wasm_internal.wasm', 'vision_wasm_nosimd_internal.js', 'vision_wasm_nosimd_internal.wasm']
function mediapipeAssets(): Plugin {
  return {
    name: 'hashwall-mediapipe-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/\/mediapipe\/([\w.]+)$/)
        if (!m || !MEDIAPIPE_FILES.includes(m[1])) return next()
        res.setHeader('Content-Type', m[1].endsWith('.wasm') ? 'application/wasm' : 'text/javascript')
        res.end(readFileSync(join(MEDIAPIPE_WASM_DIR, m[1])))
      })
    },
    generateBundle() {
      if (this.environment?.config.consumer && this.environment.config.consumer !== 'client') return
      for (const file of MEDIAPIPE_FILES) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/${file}`, source: readFileSync(join(MEDIAPIPE_WASM_DIR, file)) })
      }
    },
  }
}

/** Gros fichiers chargés seulement à l'usage : jamais pré-téléchargés par le service worker. */
const ON_DEMAND = /^(mediapipe|models)\//

/**
 * Génère /sw.js au build avec la liste exacte des fichiers à pré-cacher (coquille applicative).
 * Le SW ne touche jamais aux requêtes cross-origin (relais, serveurs Blossom) : seules
 * les ressources de l'application sont mises en cache, ce qui permet à la PWA de se
 * relancer même si le nom de domaine est ensuite bloqué.
 */
function serviceWorkerPlugin(): Plugin {
  return {
    name: 'hashwall-sw',
    apply: 'build',
    generateBundle(_options, bundle) {
      const publicFiles = listPublicFiles(join(process.cwd(), 'public')).filter(
        (f) => !f.startsWith('_') && f !== 'sw.js',
      )
      const files = [...Object.keys(bundle).filter((f) => !f.endsWith('.map')), ...publicFiles].filter((f) => !ON_DEMAND.test(f))
      const assets = ['./', ...files.map((f) => `./${f}`)]
      const version = createHash('sha256').update(assets.join('\n')).digest('hex').slice(0, 12)
      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: SW_TEMPLATE.replace('__VERSION__', version).replace(
          '__ASSETS__',
          JSON.stringify(assets),
        ),
      })
    },
  }
}

const SW_TEMPLATE = `/* HashWall service worker — généré au build, ne pas éditer. */
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
  if (/^(mediapipe|models)\//.test(path)) {
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
`

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  // Chemins relatifs : indispensable pour IPFS (/ipfs/<cid>/) et les miroirs en sous-dossier.
  base: './',
  plugins: [react(), tailwindcss(), mediapipeNoTelemetry(), mediapipeAssets(), cspPlugin(mode), serviceWorkerPlugin()],
  worker: {
    // Worker classique : le chargeur de MediaPipe utilise importScripts.
    format: 'iife' as const,
    plugins: () => [mediapipeNoTelemetry()],
  },
  build: {
    sourcemap: false,
    // Pas de module inline : compatible avec script-src 'self'.
    assetsInlineLimit: 0,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
}))
