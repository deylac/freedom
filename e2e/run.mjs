// Tests d'acceptation de bout en bout (§8 du PRD) contre un relais et des serveurs Blossom simulés.
// Usage : npm run e2e           (limite de capture réduite à 5 s pour aller vite)
//         E2E_FULL=1 npm run e2e (vraie limite de 60 s)
import assert from 'node:assert/strict'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBlossom } from './mock-blossom.mjs'
import { startRelay } from './mock-relay.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const root = fileURLToPath(new URL('../dist-e2e', import.meta.url))
const FULL = process.env.E2E_FULL === '1'
const LIMIT_MS = FULL ? 60_000 : 5_000

// ---------------------------------------------------------------------------
// Infrastructure simulée

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
const documentRequests = []
const web = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url, 'http://x').pathname)
  let file = join(root, path === '/' ? 'index.html' : path)
  if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) file = join(root, 'index.html')
  if (file.endsWith('index.html')) documentRequests.push(req.url)
  res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' })
  createReadStream(file).pipe(res)
})
await new Promise((r) => web.listen(4173, '127.0.0.1', r))
const APP = 'http://127.0.0.1:4173/'

const relay = startRelay(7777)
const A = await startBlossom(3001)
const B = await startBlossom(3002)
const C = await startBlossom(3003, { mirror: false }) // pas de BUD-04 → repli envoi direct
const D = await startBlossom(3004, { refuseUploads: true }) // refuse toute clé inconnue (cas réel nostr.build)

const settings = {
  relays: [relay.url],
  blossomServers: [D.base, A.base, B.base, C.base],
  termsAcceptedVersion: 0,
  installBannerDismissed: true,
}

// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'],
})
const results = []
async function step(name, fn) {
  const t0 = Date.now()
  try {
    const info = await fn()
    results.push({ name, ok: true, ms: Date.now() - t0, info })
    console.log(`  ✓ ${name} (${Date.now() - t0} ms)${info ? ` — ${info}` : ''}`)
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - t0, info: err.message })
    console.log(`  ✗ ${name}\n      ${err.stack?.split('\n').slice(0, 3).join('\n      ')}`)
  }
}

async function newPage({ mobile = false, init = settings, extra = {} } = {}) {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 860 },
    isMobile: mobile,
    hasTouch: mobile,
    permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'],
  })
  await context.addInitScript(
    ([s, e]) => {
      if (!sessionStorage.getItem('hw:init')) {
        localStorage.setItem('hw:settings', JSON.stringify(s))
        for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v)
        sessionStorage.setItem('hw:init', '1')
      }
    },
    [init, extra],
  )
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log('    [page error]', e.message))
  page.on('dialog', (d) => d.accept())
  return page
}

const videoEvents = () => relay.received.filter((e) => e.kind === 34236)
const tagOf = (e, n) => e.tags.find((t) => t[0] === n)
const imeta = (e) => {
  const out = {}
  for (const entry of tagOf(e, 'imeta').slice(1)) {
    const i = entry.indexOf(' ')
    ;(out[entry.slice(0, i)] ??= []).push(entry.slice(i + 1))
  }
  return out
}

console.log(`\nHashWall — tests de bout en bout (limite de capture : ${LIMIT_MS / 1000} s)\n`)

// ---------------------------------------------------------------------------
// Test 1 — Routage aveugle

const viewer = await newPage()
let viewerNavigations = 0
viewer.on('framenavigated', (f) => f === viewer.mainFrame() && viewerNavigations++)

await step('Routage : #14Octobre est normalisé en #14octobre', async () => {
  await viewer.goto(`${APP}#14Octobre`)
  await viewer.getByTestId('wall').waitFor()
  assert.equal(await viewer.getByTestId('wall').getAttribute('data-tag'), '14octobre')
  await viewer.getByText('Aucune vidéo pour #14octobre').waitFor({ timeout: 10_000 })
})

// ---------------------------------------------------------------------------
// Test 2 — Capture, limite et publication

const witness = await newPage({ mobile: true, extra: { 'hw:e2e:maxMs': String(LIMIT_MS) } })
let stopAt = 0
let mimeUsed = ''

await step('Capture : CGU en 1 clic puis caméra ouverte', async () => {
  await witness.goto(`${APP}#14octobre`)
  await witness.getByRole('button', { name: /Filmer pour #14octobre/ }).click()
  await witness.getByTestId('accept-terms').click()
  const t0 = Date.now()
  await witness.getByTestId('record').waitFor()
  await witness.waitForFunction(() => !document.querySelector('[data-testid=record]')?.hasAttribute('disabled'), null, { timeout: 10_000 })
  return `Time-to-Camera ${Date.now() - t0} ms`
})

await step(`Capture : arrêt automatique à ${LIMIT_MS / 1000} s sans action`, async () => {
  const t0 = Date.now()
  await witness.getByTestId('record').click()
  await witness.getByTestId('review').waitFor({ timeout: LIMIT_MS + 10_000 })
  stopAt = Date.now()
  const elapsed = stopAt - t0
  assert.ok(elapsed >= LIMIT_MS - 200, `arrêt trop tôt (${elapsed} ms)`)
  assert.ok(elapsed < LIMIT_MS + 3000, `arrêt trop tard (${elapsed} ms)`)
  const text = await witness.getByTestId('review').innerText()
  mimeUsed = text.match(/video\/\w+/)?.[0] ?? '?'
  return `${elapsed} ms, format ${mimeUsed}`
})

let firstEvent
await step('Publication automatique après 3 s d’aperçu (zéro clic)', async () => {
  await witness.getByTestId('review').waitFor({ state: 'detached', timeout: 15_000 })
  await witness.locator('[data-testid=publish-tray] [data-state=done]').waitFor({ timeout: 30_000 })
  firstEvent = videoEvents()[0]
  assert.ok(firstEvent, 'aucun événement 34236 reçu par le relais')
})

await step('Blossom : HEAD /upload puis PUT /upload signé (BUD-06/02/11)', async () => {
  const head = A.log.find((l) => l.method === 'HEAD' && l.path === '/upload')
  const put = A.log.find((l) => l.method === 'PUT' && l.path === '/upload')
  assert.ok(head && put, 'HEAD ou PUT manquant sur le serveur primaire')
  assert.ok(head.at <= put.at, 'HEAD doit précéder PUT')
  assert.equal(typeof put.auth, 'object', `jeton refusé : ${put.auth}`)
  const token = put.auth.event
  assert.equal(token.kind, 24242)
  assert.ok(token.tags.some((t) => t[0] === 'x'), 'tag x absent')
  const exp = Number(tagOf(token, 'expiration')[1])
  assert.ok(exp - token.created_at >= 3500, 'expiration < 1 h')
  return `${A.blobs.size} blobs sur le primaire`
})

await step('Réplication : /mirror sur B, repli envoi direct sur C (sans BUD-04)', async () => {
  const sha = imeta(firstEvent).x[0]
  assert.ok(B.log.some((l) => l.path === '/mirror' && l.method === 'PUT'), 'pas de PUT /mirror sur B')
  assert.ok(B.blobs.has(sha), 'B ne détient pas la vidéo')
  assert.ok(C.log.some((l) => l.path === '/mirror'), 'C aurait dû être sollicité en /mirror')
  assert.ok(C.blobs.has(sha), 'C ne détient pas la vidéo (repli)')
})

await step('Diagnostic : refus du 1er serveur et repli visibles dans les Réglages', async () => {
  assert.ok(D.log.some((l) => l.method === 'HEAD' && l.path === '/upload'), 'le serveur qui refuse n’a pas été essayé en premier')
  await witness.getByRole('button', { name: 'Réglages' }).click()
  const text = await witness.getByTestId('diagnostics').innerText()
  await witness.keyboard.press('Escape')
  assert.match(text, /127\.0\.0\.1:3004[^\n]*HTTP 401/, 'refus HTTP 401 absent')
  assert.match(text, /127\.0\.0\.1:3001[^\n]*primaire/)
  assert.match(text, /127\.0\.0\.1:3003[^\n]*envoi direct/)
  return text.split('\n').length + ' lignes'
})

await step('Événement NIP-71 : kind 34236, d stable, imeta complet, v2 avec fallback', async () => {
  const versions = videoEvents()
  assert.ok(versions.length >= 2, `attendu v1 + v2, reçu ${versions.length}`)
  const [v1, v2] = [versions[0], versions.at(-1)]
  assert.equal(tagOf(v1, 'd')[1], tagOf(v2, 'd')[1], 'le tag d doit rester identique')
  assert.ok(v2.created_at > v1.created_at, 'v2 doit être plus récente')
  assert.deepEqual(tagOf(v2, 't'), ['t', '14octobre'])
  assert.equal(tagOf(v2, 'published_at')[1], tagOf(v1, 'published_at')[1])
  const m = imeta(v2)
  assert.match(m.url[0], /^http:\/\/127\.0\.0\.1:3001\/[0-9a-f]{64}\.(mp4|webm)$/)
  assert.match(m.x[0], /^[0-9a-f]{64}$/)
  assert.equal(m.dim[0], '720x1280')
  assert.ok(Number(m.duration[0]) <= LIMIT_MS / 1000 + 0.05, `durée ${m.duration[0]}`)
  assert.equal(m.fallback.length, 2)
  assert.ok(m.image?.length >= 1, 'vignette absente')
  const relayCopy = relay.events.filter((e) => e.kind === 34236)
  assert.equal(relayCopy.length, 1, 'le relais doit avoir remplacé v1 par v2 (pas de doublon)')
  assert.ok(relay.received.some((e) => e.kind === 10063), 'liste de serveurs kind 10063 non publiée')
  return `durée ${m.duration[0]} s, ${m.m[0]}, ${(Number(m.size[0]) / 1e6).toFixed(2)} Mo`
})

await step('Temps réel : la vidéo apparaît sur l’autre écran sans rechargement', async () => {
  await viewer.locator('[data-clip-key]').first().waitFor({ timeout: 10_000 })
  const shownAt = Date.now()
  assert.equal(viewerNavigations, 1, 'la page du spectateur a été rechargée')
  return `affichée ${((shownAt - stopAt) / 1000).toFixed(1)} s après la fin de l’enregistrement (réseau local, aperçu de 3 s inclus)`
})

await step('Forensique : aucune trace GPS / appareil dans le fichier publié', async () => {
  const sha = imeta(firstEvent).x[0]
  const data = A.blobs.get(sha).data
  const text = data.toString('latin1')
  for (const marker of ['©xyz', 'GPS', 'Make', 'Model', 'udta', 'Location', 'SerialNumber']) {
    assert.ok(!text.includes(marker), `marqueur trouvé : ${marker}`)
  }
  let dates = 'WebM : pas de boîte de date'
  if (text.slice(4, 8) === 'ftyp') {
    for (const box of ['mvhd', 'tkhd', 'mdhd']) {
      const at = text.indexOf(box)
      assert.ok(at > 0, `boîte ${box} absente`)
      const version = data[at + 4]
      const len = version === 1 ? 16 : 8
      assert.ok(data.subarray(at + 8, at + 8 + len).every((b) => b === 0), `dates non effacées dans ${box}`)
    }
    dates = 'dates mvhd/tkhd/mdhd à zéro'
  }
  return `${data.length} octets inspectés, ${dates}`
})

// ---------------------------------------------------------------------------
// Test 5 — Résistance à la censure

async function playbackHost(page) {
  await page.waitForFunction(
    () => {
      const v = document.querySelector('video[data-source-host]')
      return v && v.readyState >= 2 && !v.paused && v.currentTime > 0
    },
    null,
    { timeout: 25_000 },
  )
  return page.evaluate(() => document.querySelector('video[data-source-host]').dataset.sourceHost)
}

await step('Autoplay refusé (iOS économie d’énergie) : bouton « Lire », pas de fausse bascule', async () => {
  const page = await newPage({ mobile: true })
  // Simule Safari en mode économie d'énergie : play() refusé tant qu'aucun geste de l'utilisateur.
  await page.addInitScript(() => {
    let gesture = false
    window.addEventListener('pointerdown', () => (gesture = true), true)
    const original = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function () {
      if (!gesture) return Promise.reject(new DOMException('autoplay refusé', 'NotAllowedError'))
      return original.call(this)
    }
  })
  await page.goto(`${APP}#14octobre`)
  await page.getByTestId('tap-to-play').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(9_000) // plus que le délai de bascule (7 s)
  const host = await page.evaluate(() => document.querySelector('video[data-source-host]')?.dataset.sourceHost)
  assert.equal(host, '127.0.0.1:3001', `bascule à tort vers ${host}`)
  assert.equal(await page.getByText(/Vidéo introuvable/).count(), 0, 'déclarée introuvable à tort')
  await page.getByTestId('tap-to-play').click()
  const playing = await playbackHost(page)
  assert.equal(playing, '127.0.0.1:3001')
  await page.context().close()
  return 'reste sur le primaire, lecture au toucher'
})

await step('Censure (requête bloquée) : bascule immédiate sur un miroir', async () => {
  const page = await newPage({ mobile: true })
  await page.route('http://127.0.0.1:3001/**', (route) => route.abort('blockedbyclient'))
  const t0 = Date.now()
  await page.goto(`${APP}#14octobre`)
  const host = await playbackHost(page)
  assert.notEqual(host, '127.0.0.1:3001')
  await page.context().close()
  return `lecture depuis ${host} en ${Date.now() - t0} ms`
})

await step('Censure (IP en trou noir, aucune réponse) : bascule après délai', async () => {
  const page = await newPage({ mobile: true })
  await page.route('http://127.0.0.1:3001/**', () => {}) // ne répond jamais
  const t0 = Date.now()
  await page.goto(`${APP}#14octobre`)
  const host = await playbackHost(page)
  assert.notEqual(host, '127.0.0.1:3001')
  await page.context().close()
  return `lecture depuis ${host} en ${Date.now() - t0} ms`
})

// ---------------------------------------------------------------------------
// Test 6 — Signalement

await step('Signalement : kind 1984 (e, p, x) + PUT /report, vidéo masquée', async () => {
  const card = viewer.locator('[data-clip-key]').first()
  await card.getByRole('button', { name: "Plus d'actions" }).click()
  await viewer.getByRole('button', { name: 'Signaler ce contenu' }).click()
  await viewer.getByRole('button', { name: /Spam/ }).click()
  await viewer.locator('[data-clip-key]').first().waitFor({ state: 'detached', timeout: 5_000 })
  const report = relay.received.find((e) => e.kind === 1984)
  assert.ok(report, 'aucun kind 1984 publié')
  for (const t of ['e', 'p', 'x']) assert.equal(tagOf(report, t)?.[2], 'spam', `tag ${t} sans motif`)
  assert.ok(tagOf(report, 'a'), 'tag a absent')
  const servers = [A, B, C].filter((s) => s.reports.length > 0).length
  assert.equal(servers, 3, `PUT /report reçu par ${servers}/3 serveurs`)
})

// ---------------------------------------------------------------------------
// Test 1 (suite) — changement de hashtag sans requête HTTP

await step('Routage : passage à #15octobre sans requête au serveur web', async () => {
  const before = documentRequests.length
  await viewer.evaluate(() => (window.__sansRechargement = true))
  await viewer.evaluate(() => (location.hash = '#15octobre'))
  await viewer.getByText('Aucune vidéo pour #15octobre').waitFor({ timeout: 10_000 })
  assert.equal(documentRequests.length, before, 'une requête de document a été émise')
  assert.equal(await viewer.evaluate(() => window.__sansRechargement), true, 'la page a été rechargée')
})

// ---------------------------------------------------------------------------
// Suppression par l'auteur (NIP-09 + BUD-12)

await step('Suppression : kind 5 + DELETE sur les serveurs, retirée des murs', async () => {
  const watcher = await newPage()
  await watcher.goto(`${APP}#14octobre`)
  await watcher.locator('[data-clip-key]').first().waitFor({ timeout: 10_000 })
  await witness.getByRole('button', { name: 'Réglages' }).click()
  await witness.getByRole('button', { name: 'Supprimer cette vidéo' }).first().click()
  await witness.getByText(/Suppression demandée/).waitFor({ timeout: 10_000 })
  const deletion = relay.received.find((e) => e.kind === 5)
  assert.ok(deletion && tagOf(deletion, 'a') && tagOf(deletion, 'k'), 'kind 5 incomplet')
  const sha = imeta(firstEvent).x[0]
  assert.ok(![A, B, C].some((s) => s.blobs.has(sha)), 'le fichier existe encore sur un serveur')
  await watcher.locator('[data-clip-key]').first().waitFor({ state: 'detached', timeout: 10_000 })
  await watcher.context().close()
})

// ---------------------------------------------------------------------------

await browser.close()
await Promise.all([relay.close(), A.close(), B.close(), C.close(), D.close(), new Promise((r) => web.close(r))])
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} tests réussis${mimeUsed ? ` — format enregistré par Chromium : ${mimeUsed}` : ''}\n`)
process.exit(failed.length ? 1 : 0)
