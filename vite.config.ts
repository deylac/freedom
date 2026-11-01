/// <reference types="vitest/config" />
import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { Script } from 'node:vm'
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

/**
 * Le service worker est un vrai fichier source (sw/service-worker.js), pas une chaîne modèle :
 * une chaîne modèle consommait l'antislash de `\/` et produisait un sw.js invalide (audit F05).
 * Le build échoue si le code généré n'est pas du JavaScript valide.
 */
export function buildServiceWorker(version: string, assets: string[]): string {
  const template = readFileSync(join(process.cwd(), 'sw', 'service-worker.js'), 'utf8')
  const source = template.replace("'__VERSION__'", JSON.stringify(version)).replace('__ASSETS__', JSON.stringify(assets))
  if (source.includes('__VERSION__') || source.includes('__ASSETS__')) throw new Error('sw.js : marqueur non remplacé')
  try {
    new Script(source, { filename: 'sw.js' })
  } catch (err) {
    throw new Error(`sw.js généré invalide : ${err instanceof Error ? err.message : String(err)}`)
  }
  return source
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
        source: buildServiceWorker(version, assets),
      })
    },
  }
}


/** Version affichée dans les Réglages : numéro + commit, pour savoir quelle version tourne sur un téléphone. */
function buildId(): string {
  const env = process.env.GITHUB_SHA?.slice(0, 7)
  if (env) return env
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim()
  } catch {
    return 'local'
  }
}

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string }

export default defineConfig(({ mode }) => ({
  define: {
    __APP_VERSION__: JSON.stringify(`${pkg.version} (${buildId()})`),
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
