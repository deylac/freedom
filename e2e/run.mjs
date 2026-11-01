// Tests d'acceptation de bout en bout (§8 du PRD) contre un relais et des serveurs Blossom simulés.
// Usage : npm run e2e           (limite de capture réduite à 5 s pour aller vite)
//         E2E_FULL=1 npm run e2e (vraie limite de 60 s)
import assert from 'node:assert/strict'
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startBlossom } from './mock-blossom.mjs'
import { startOts } from './mock-ots.mjs'
import { startRelay } from './mock-relay.mjs'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const root = fileURLToPath(new URL('../dist-e2e', import.meta.url))
const FULL = process.env.E2E_FULL === '1'
const LIMIT_MS = FULL ? 60_000 : 5_000

// ---------------------------------------------------------------------------
// Infrastructure simulée

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.tflite': 'application/octet-stream' }
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
const D = await startBlossom(3004, { refuseUploads: true }) // refuse toute clé inconnue
const E = await startBlossom(3005, { delayMs: 35_000 }) // antivirus lent : répond 35 s après réception (cas réel nostr.build)
const OTS = await startOts(3010, 3011)

const settings = {
  relays: [relay.url],
  blossomServers: [D.base, A.base, B.base, C.base],
  termsAcceptedVersion: 0,
  installBannerDismissed: true,
  otsCalendars: [OTS.calendarUrl],
  btcExplorers: [OTS.explorerUrl],
}

// ---------------------------------------------------------------------------

const browser = await chromium.launch({
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--no-proxy-server', '--autoplay-policy=no-user-gesture-required'],
})
const results = []
async function step(name, fn) {
  // E2E_ONLY=<texte> : ne lance que les scénarios indépendants dont le nom contient ce texte.
  if (process.env.E2E_ONLY && !name.includes(process.env.E2E_ONLY)) return
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

async function waitFor(predicate, timeoutMs, label) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const value = predicate()
    if (value) return value
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`délai dépassé : ${label}`)
}

/** Filme un clip (limite raccourcie) et laisse la publication automatique partir. */
async function recordClip(page, tag) {
  await page.getByRole('button', { name: new RegExp(`Filmer pour #${tag}`) }).click()
  await page.waitForFunction(() => !document.querySelector('[data-testid=record]')?.hasAttribute('disabled'), null, { timeout: 10_000 })
  await page.getByTestId('record').click()
  await page.getByTestId('review').waitFor({ timeout: 15_000 })
  await page.getByTestId('review').waitFor({ state: 'detached', timeout: 15_000 })
}

const v1Of = (tag, n = 0) => videoEvents().filter((e) => tagOf(e, 't')?.[1] === tag && !imeta(e).fallback)[n]
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
// Horodatage OpenTimestamps de l'empreinte du fichier

await step('Horodatage Bitcoin : preuve dans imeta, en attente puis vérifiée, .ots téléchargeable', async () => {
  const v = videoEvents().at(-1)
  const sha = imeta(v).x[0]
  const ots = Buffer.from(imeta(v).ots?.[0] ?? '', 'base64')
  assert.ok(ots.length > 60, 'pas de preuve OpenTimestamps dans imeta')
  // en-tête (31 octets) + version + opération sha256 (0x08) + empreinte de la VIDÉO
  assert.equal(ots[32], 0x08)
  assert.equal(ots.subarray(33, 65).toString('hex'), sha, 'la preuve ne porte pas sur le fichier vidéo')
  assert.ok(OTS.state.submitted.length >= 1 && !OTS.state.submitted.includes(sha), 'le calendrier ne doit recevoir que sha256(empreinte ‖ nonce)')

  const card = viewer.locator('[data-clip-key]').first()
  await card.getByRole('button', { name: 'Résilience et intégrité' }).click()
  await viewer.getByRole('button', { name: 'Vérifier l’ancrage Bitcoin' }).click()
  await viewer.locator('[data-testid=ots] [data-state=pending]').waitFor({ timeout: 10_000 })
  OTS.state.upgraded = true
  await viewer.getByRole('button', { name: 'Vérifier l’ancrage Bitcoin' }).click()
  await viewer.locator('[data-testid=ots] [data-state=verified]').waitFor({ timeout: 10_000 })
  const text = await viewer.locator('[data-testid=ots] [data-state=verified]').innerText()
  assert.match(text, /bloc Bitcoin n° 800000/)
  const [download] = await Promise.all([viewer.waitForEvent('download'), viewer.getByRole('button', { name: /Preuve \.ots/ }).click()])
  const file = readFileSync(await download.path())
  assert.equal(file.subarray(33, 65).toString('hex'), sha)
  assert.ok(file.length > ots.length, 'la preuve téléchargée devrait inclure l’attestation Bitcoin')
  await viewer.keyboard.press('Escape')
  return `${ots.length} octets publiés → ${file.length} octets complétés ; ${text.slice(0, 60)}…`
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
// Serveurs lents (constaté en réel avec nostr.build : antivirus après réception)

await step('Serveur primaire lent (réponse 35 s après réception) : envoi accepté, pas d’abandon', async () => {
  const page = await newPage({
    mobile: true,
    init: { ...settings, blossomServers: [E.base, A.base], termsAcceptedVersion: 1 },
    extra: { 'hw:e2e:maxMs': '3000' },
  })
  await page.goto(`${APP}#lent`)
  await recordClip(page, 'lent')
  const v1 = await waitFor(() => v1Of('lent'), 60_000, 'v1 #lent')
  assert.match(imeta(v1).url[0], /127\.0\.0\.1:3005/, 'le serveur lent aurait dû rester primaire')
  await page.context().close()
})

await step('Deux voies : un nouveau clip n’attend pas la réplication du précédent', async () => {
  const page = await newPage({
    mobile: true,
    init: { ...settings, blossomServers: [A.base, E.base], termsAcceptedVersion: 1 },
    extra: { 'hw:e2e:maxMs': '3000' },
  })
  await page.goto(`${APP}#voies`)
  await recordClip(page, 'voies')
  const x = await waitFor(() => v1Of('voies', 0), 30_000, 'v1 du clip X')
  // X se réplique vers le serveur lent (35 s) pendant qu'on filme Y.
  await recordClip(page, 'voies')
  const y = await waitFor(() => v1Of('voies', 1), 30_000, 'v1 du clip Y')
  const xd = tagOf(x, 'd')[1]
  const xv2 = () => videoEvents().find((e) => tagOf(e, 'd')[1] === xd && imeta(e).fallback)
  assert.ok(!xv2() || relay.received.indexOf(y) < relay.received.indexOf(xv2()), 'Y a attendu la réplication de X')
  const v2 = await waitFor(xv2, 90_000, 'v2 de X avec miroir lent')
  assert.ok(imeta(v2).fallback.some((u) => u.includes(':3005/')), 'miroir lent absent des fallback')
  await page.context().close()
  return `Y publiée ${((relay.received.indexOf(v2) - relay.received.indexOf(y)) > 0 ? 'avant' : 'après')} la fin de la réplication de X`
})

// ---------------------------------------------------------------------------
// Floutage des visages (MediaPipe, worker) avec une fausse caméra contenant de vrais visages

/**
 * Compose une scène 1280×720 (fond très texturé + 3 visages) et l'écrit en Y4M pour Chromium.
 * Paysage 1280×720 = exactement nos contraintes getUserMedia : Chromium livre l'image telle quelle
 * (une scène portrait serait recadrée en 720×720). L'enregistreur en garde la bande centrale.
 */
async function makeFaceVideo(path) {
  const page = await browser.newPage()
  const face = readFileSync(new URL('./fixtures/face.jpg', import.meta.url)).toString('base64')
  const planes = await page.evaluate(async ([b64, SCENE_FACES]) => {
    const img = new Image()
    img.src = `data:image/jpeg;base64,${b64}`
    await img.decode()
    const W = 1280, H = 720
    const c = new OffscreenCanvas(W, H)
    const ctx = c.getContext('2d')
    const bg = ctx.createImageData(W, H)
    let seed = 7
    for (let i = 0; i < bg.data.length; i += 4) {
      seed = (seed * 16807) % 2147483647
      const v = 50 + (seed % 150)
      bg.data[i] = v; bg.data[i + 1] = v * 0.9; bg.data[i + 2] = v * 0.8; bg.data[i + 3] = 255
    }
    ctx.putImageData(bg, 0, 0)
    for (const [x, y, s] of SCENE_FACES) ctx.drawImage(img, x, y, s, s)
    const d = ctx.getImageData(0, 0, W, H).data
    const Y = new Uint8Array(W * H), U = new Uint8Array((W / 2) * (H / 2)), V = new Uint8Array((W / 2) * (H / 2))
    for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
      const k = (j * W + i) * 4
      Y[j * W + i] = 0.299 * d[k] + 0.587 * d[k + 1] + 0.114 * d[k + 2]
      if (i % 2 === 0 && j % 2 === 0) {
        const q = (j / 2) * (W / 2) + i / 2
        U[q] = 128 - 0.168736 * d[k] - 0.331264 * d[k + 1] + 0.5 * d[k + 2]
        V[q] = 128 + 0.5 * d[k] - 0.418688 * d[k + 1] - 0.081312 * d[k + 2]
      }
    }
    const b64of = (a) => { let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s) }
    return [b64of(Y), b64of(U), b64of(V)]
  }, [face, SCENE_FACES])
  await page.close()
  const frame = Buffer.concat([Buffer.from('FRAME\n'), ...planes.map((p) => Buffer.from(p, 'base64'))])
  mkdirSync(new URL('./artifacts/', import.meta.url), { recursive: true })
  writeFileSync(path, Buffer.concat([Buffer.from('YUV4MPEG2 W1280 H720 F30:1 Ip A1:1 C420jpeg\n'), frame, frame]))
}

// Visages dans la bande centrale de la scène (x de 437,5 à 842,5 : ce que garde le recadrage 9:16).
const SCENE_FACES = [[500, 20, 180], [620, 260, 110], [520, 470, 70]]
// Scène → canvas 720×1280 : échelle 1280/720, décalage horizontal de 437,5 px (recadrage centré).
const K = 1280 / 720
const toCanvas = (x, y, w, h) => ({ x: Math.round((x - 437.5) * K), y: Math.round(y * K), w: Math.round(w * K), h: Math.round(h * K) })
// Visage = 30,6 % du recadrage, décalé de 15,9 % / 20,6 % (cf. e2e/fixtures/face.jpg)
const FACES = SCENE_FACES.map(([x, y, s]) => toCanvas(x + s * 0.159, y + s * 0.206, s * 0.306, s * 0.306))
const BACKGROUND = toCanvas(700, 560, 90, 90)

/**
 * « Platitude » d'une zone du canvas : part des pixels voisins strictement identiques.
 * ≈ 1 dans une zone pixelisée (blocs uniformes), ≈ 0 dans une image naturelle ou bruitée.
 */
const flatness = (page, r) =>
  page.evaluate((r) => {
    const c = document.querySelector('canvas[aria-label="Aperçu de la caméra"]')
    const d = c.getContext('2d').getImageData(r.x, r.y, r.w, r.h).data
    let same = 0, n = 0
    for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w - 1; i++) {
      const k = (j * r.w + i) * 4
      if (d[k] === d[k + 4] && d[k + 1] === d[k + 5] && d[k + 2] === d[k + 6]) same++
      n++
    }
    return same / n
  }, r)

await step('Visages floutés (MediaPipe) : visages pixelisés, fond intact, échec fermé, aucune requête externe', async () => {
  const video = fileURLToPath(new URL('./artifacts/faces.y4m', import.meta.url))
  await makeFaceVideo(video)
  const faceBrowser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`, '--no-proxy-server'],
  })
  try {
  const context = await faceBrowser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera', 'microphone'] })
  await context.addInitScript((s) => localStorage.setItem('hw:settings', JSON.stringify(s)), { ...settings, termsAcceptedVersion: 1 })
  const external = []
  context.on('request', (r) => { if (!/^(http:\/\/127\.0\.0\.1|data:|blob:)/.test(r.url())) external.push(r.url()) })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log('    [page error]', e.message))
  // Chargement du modèle ralenti de 4 s : l'état « non fiable » doit pixeliser toute l'image.
  await page.route('**/models/*.tflite', async (route) => { await new Promise((r) => setTimeout(r, 4000)); await route.continue() })
  await page.goto(`${APP}#visages`)
  await page.getByRole('button', { name: /Filmer pour #visages/ }).click()
  await page.waitForFunction(() => !document.querySelector('[data-testid=record]')?.hasAttribute('disabled'), null, { timeout: 15_000 })
  await page.waitForTimeout(800)
  const base = { faces: await Promise.all(FACES.map((f) => flatness(page, f))), bg: await flatness(page, BACKGROUND) }
  assert.ok(base.faces.every((f) => f < 0.5) && base.bg < 0.2, `scène déjà plate ? ${JSON.stringify(base)}`)

  await page.getByRole('button', { name: /Filtre d'anonymisation/ }).click() // sans filtre → visages
  await page.waitForTimeout(600)
  const loadingState = await page.getByTestId('face-status').getAttribute('data-trusted')
  const bgWhileLoading = await flatness(page, BACKGROUND)
  assert.equal(loadingState, 'false')
  assert.ok(bgWhileLoading > 0.8, `pendant le chargement, toute l'image doit être pixelisée (platitude du fond ${bgWhileLoading.toFixed(2)})`)

  await page.locator('[data-testid=face-status][data-trusted=true]').waitFor({ timeout: 60_000 })
  await page.waitForTimeout(500)
  const count = Number(await page.getByTestId('face-status').getAttribute('data-count'))
  const after = { faces: await Promise.all(FACES.map((f) => flatness(page, f))), bg: await flatness(page, BACKGROUND) }
  after.faces.forEach((f, i) => assert.ok(f > 0.8, `visage ${i} (${FACES[i].w} px) non flouté : platitude ${f.toFixed(2)} (avant ${base.faces[i].toFixed(2)})`))
  assert.ok(after.bg < 0.2, `le fond ne devrait plus être pixelisé (platitude ${after.bg.toFixed(2)})`)
  assert.deepEqual(external, [], `requêtes externes : ${external.join(', ')}`)
  return `${count} visages détectés ; platitude des visages ${FACES.map((f, i) => `${f.w}px ${base.faces[i].toFixed(2)}→${after.faces[i].toFixed(2)}`).join(', ')} ; fond ${base.bg.toFixed(2)}→${after.bg.toFixed(2)} (chargement : ${bgWhileLoading.toFixed(2)})`
  } finally {
    await faceBrowser.close()
  }
})

// ---------------------------------------------------------------------------
// Voix anonymisée : mesure hors ligne du vocodeur (src/lib/media/voice.ts)

await step('Voix robot : la hauteur de la voix d’origine disparaît, le rythme reste', async () => {
  const ts = require('typescript')
  const source = readFileSync(new URL('../src/lib/media/voice.ts', import.meta.url), 'utf8')
  const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText
  const page = await browser.newPage()
  const r = await page.evaluate(async (code) => {
    const mod = await import(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })))
    const SR = 48000, SECONDS = 3
    const ctx = new OfflineAudioContext(2, SR * SECONDS, SR)
    // « Voix » de test : hauteur montant de 100 à 220 Hz, volume modulé à 3 Hz (syllabes)
    const osc = ctx.createOscillator()
    osc.type = 'sawtooth'
    osc.frequency.setValueAtTime(100, 0)
    osc.frequency.linearRampToValueAtTime(220, SECONDS)
    const am = ctx.createGain()
    am.gain.value = 0.5
    const lfo = ctx.createOscillator()
    lfo.frequency.value = 3
    const depth = ctx.createGain()
    depth.gain.value = 0.48
    lfo.connect(depth).connect(am.gain)
    const level = ctx.createGain()
    level.gain.value = 0.3
    osc.connect(am).connect(level)
    const merger = ctx.createChannelMerger(2)
    level.connect(merger, 0, 0)
    const out = ctx.createGain()
    const vocoder = mod.buildVocoder(ctx, level, out)
    out.connect(merger, 0, 1)
    merger.connect(ctx.destination)
    osc.start(); lfo.start(); vocoder.start()
    const buf = await ctx.startRendering()
    const input = buf.getChannelData(0), output = buf.getChannelData(1)
    const rms = (x, a, n) => { let e = 0; for (let i = a; i < a + n; i++) e += x[i] * x[i]; return Math.sqrt(e / n) }
    const pitch = (x, a, n) => {
      let best = 0, lagBest = 0
      const r0 = (() => { let e = 0; for (let i = a; i < a + n; i++) e += x[i] * x[i]; return e })()
      for (let lag = Math.floor(SR / 400); lag <= Math.ceil(SR / 70); lag++) {
        let e = 0
        for (let i = a; i < a + n - lag; i++) e += x[i] * x[i + lag]
        if (e / r0 > best) { best = e / r0; lagBest = lag }
      }
      return SR / lagBest
    }
    const W = 2400 // 50 ms
    const windows = []
    for (let a = SR * 0.2; a + W < SR * SECONDS; a += W) windows.push(a)
    const outLevels = windows.map((a) => rms(output, a, W))
    const loud = Math.max(...outLevels) * 0.2
    const f0in = [], f0out = []
    windows.forEach((a, i) => { if (outLevels[i] > loud) { f0in.push(pitch(input, a, W)); f0out.push(pitch(output, a, W)) } })
    const E = 960 // 20 ms
    const envIn = [], envOut = []
    for (let a = SR * 0.2; a + E < SR * SECONDS; a += E) { envIn.push(rms(input, a, E)); envOut.push(rms(output, a, E)) }
    const mean = (v) => v.reduce((s, x) => s + x, 0) / v.length
    const mi = mean(envIn), mo = mean(envOut)
    let num = 0, di = 0, dO = 0
    for (let i = 0; i < envIn.length; i++) { num += (envIn[i] - mi) * (envOut[i] - mo); di += (envIn[i] - mi) ** 2; dO += (envOut[i] - mo) ** 2 }
    return { f0in, f0out, corr: num / Math.sqrt(di * dO), rmsIn: rms(input, 0, input.length), rmsOut: rms(output, 0, output.length) }
  }, code)
  await page.close()
  const span = Math.max(...r.f0in) - Math.min(...r.f0in)
  const near = r.f0out.filter((f) => Math.abs(f - 110) <= 6).length / r.f0out.length
  assert.ok(span > 80, `la voix d’entrée devrait varier (${span.toFixed(0)} Hz)`)
  assert.ok(near >= 0.85, `hauteur de sortie non fixe : ${r.f0out.map((f) => f.toFixed(0)).join(',')}`)
  assert.ok(r.corr > 0.6, `rythme non conservé (corrélation ${r.corr.toFixed(2)})`)
  assert.ok(r.rmsOut > r.rmsIn * 0.2 && r.rmsOut < r.rmsIn * 5, `niveau de sortie anormal (${r.rmsOut.toFixed(3)} pour ${r.rmsIn.toFixed(3)})`)
  return `entrée ${Math.min(...r.f0in).toFixed(0)}→${Math.max(...r.f0in).toFixed(0)} Hz ; sortie à 110 ± 6 Hz sur ${(near * 100).toFixed(0)} % des fenêtres ; corrélation du rythme ${r.corr.toFixed(2)} ; niveau ${r.rmsIn.toFixed(3)}→${r.rmsOut.toFixed(3)}`
})

await step('Voix robot en capture réelle : enregistrement et publication avec la voix anonymisée', async () => {
  const page = await newPage({ mobile: true, init: { ...settings, termsAcceptedVersion: 1 }, extra: { 'hw:e2e:maxMs': '3000' } })
  await page.goto(`${APP}#voix`)
  await page.getByRole('button', { name: /Filmer pour #voix/ }).click()
  await page.waitForFunction(() => !document.querySelector('[data-testid=record]')?.hasAttribute('disabled'), null, { timeout: 10_000 })
  await page.getByTestId('voice-toggle').click()
  await page.getByTestId('record').click()
  await page.getByTestId('review').waitFor({ timeout: 15_000 })
  assert.match(await page.getByTestId('review').innerText(), /voix anonymisée/)
  await page.getByTestId('review').waitFor({ state: 'detached', timeout: 15_000 })
  await waitFor(() => v1Of('voix'), 30_000, 'publication #voix')
  await page.context().close()
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
// Fermeture bornée : une connexion restée ouverte ne doit jamais bloquer la fin de la suite.
web.closeAllConnections?.()
await Promise.race([
  Promise.all([relay.close(), A.close(), B.close(), C.close(), D.close(), E.close(), OTS.close(), new Promise((r) => web.close(r))]),
  new Promise((r) => setTimeout(r, 3000)),
])
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} tests réussis${mimeUsed ? ` — format enregistré par Chromium : ${mimeUsed}` : ''}\n`)
process.exit(failed.length ? 1 : 0)
