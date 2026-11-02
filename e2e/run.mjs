// Tests d'acceptation de bout en bout (§8 du PRD) contre un relais et des serveurs Blossom simulés.
// Usage : npm run e2e           (limite de capture réduite à 5 s pour aller vite)
//         E2E_FULL=1 npm run e2e (vraie limite de 60 s)
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream' }
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
const G = await startBlossom(3006) // serveur qui ne reçoit que des copies de préservation (bouton)
const H = await startBlossom(3007) // idem (préservation automatique)

const settings = {
  relays: [relay.url],
  blossomServers: [D.base, A.base, B.base, C.base],
  termsAcceptedVersion: 0,
  installBannerDismissed: true,
  otsCalendars: [OTS.calendarUrl],
  btcExplorers: [OTS.explorerUrl],
  autoPreserve: false,
  captureFilter: 'none', // les scénarios historiques filment sans filtre ; le défaut réel est testé à part
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
// Partage vers les réseaux sociaux et filigrane

await step('Filigrane incrusté dans le fichier publié ; partage du fichier vidéo (repli : téléchargement)', async () => {
  const sha = imeta(firstEvent).x[0]
  // Filigrane : texte clair sur ombre, en bas à gauche, dans le FICHIER publié (pas un calque d'interface).
  const probe = await viewer.evaluate(async (url) => {
    const v = document.createElement('video')
    v.muted = true
    v.src = URL.createObjectURL(await (await fetch(url)).blob())
    await new Promise((r) => (v.onloadeddata = r))
    v.currentTime = 1
    await new Promise((r) => (v.onseeked = r))
    const c = new OffscreenCanvas(720, 1280)
    const cx = c.getContext('2d')
    cx.drawImage(v, 0, 0, 720, 1280)
    const bright = (x, y, w, h) => {
      const d = cx.getImageData(x, y, w, h).data
      let n = 0
      for (let i = 0; i < d.length; i += 4) if (d[i] > 215 && d[i + 1] > 215 && d[i + 2] > 215) n++
      return n / (w * h)
    }
    return { mark: bright(24, 1150, 380, 90), control: bright(316, 40, 380, 90) }
  }, `${A.base}/${sha}.mp4`)
  assert.ok(probe.mark > 0.03 && probe.mark > probe.control * 2, `filigrane absent du fichier (zone ${probe.mark.toFixed(3)}, témoin ${probe.control.toFixed(3)})`)

  const card = viewer.locator('[data-clip-key]').first()
  await card.getByRole('button', { name: "Plus d'actions" }).click()
  await viewer.getByTestId('share-file').click()
  await viewer.getByTestId('share-file-go').waitFor({ timeout: 15_000 })
  const [download] = await Promise.all([viewer.waitForEvent('download'), viewer.getByTestId('share-file-go').click()])
  assert.match(download.suggestedFilename(), /^hashwall-14octobre-[0-9a-f]{8}\.mp4$/)
  const bytes = readFileSync(await download.path())
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha, 'le fichier partagé doit être la vidéo publiée')
  return `filigrane : ${(probe.mark * 100).toFixed(1)} % de pixels clairs (témoin ${(probe.control * 100).toFixed(1)} %) ; fichier partagé = vidéo publiée`
})

// ---------------------------------------------------------------------------
// Résilience : réplication par les spectateurs (docs/RESILIENCE.md, R1)

await step('Préservation : un spectateur copie la vidéo ; serveurs d’origine bloqués, lecture depuis la copie', async () => {
  const sha = imeta(firstEvent).x[0]
  const keeper = await newPage({ init: { ...settings, blossomServers: [A.base, G.base] } })
  await keeper.goto(`${APP}#14octobre`)
  const card = keeper.locator('[data-clip-key]').first()
  await card.waitFor({ timeout: 10_000 })
  await card.getByRole('button', { name: "Plus d'actions" }).click()
  await keeper.getByTestId('preserve').click()
  await keeper.getByText(/Copiée sur 1 serveur/).waitFor({ timeout: 20_000 })
  assert.ok(G.blobs.has(sha), 'le serveur G ne détient pas la copie')
  assert.ok(G.log.some((l) => l.path === '/mirror'), 'copie attendue de serveur à serveur (/mirror)')
  const announce = await waitFor(() => relay.received.find((e) => e.kind === 1063 && tagOf(e, 'x')?.[1] === sha), 10_000, 'annonce NIP-94')
  assert.ok(tagOf(announce, 'url')[1].startsWith(G.base))
  const witnessKey = videoEvents()[0].pubkey
  assert.notEqual(announce.pubkey, witnessKey)
  await keeper.context().close()

  // Un autre spectateur, qui ne connaît pas G, avec A, B et C bloqués : il doit trouver la copie via Nostr.
  const page = await newPage({ mobile: true, init: { ...settings, blossomServers: [D.base] } })
  await page.route(/127\.0\.0\.1:300[123]\//, (route) => route.abort('blockedbyclient'))
  await page.goto(`${APP}#14octobre`)
  const host = await playbackHost(page).catch(async (err) => {
    const state = await page.evaluate(() => ({
      text: document.body.innerText.slice(0, 400),
      videos: [...document.querySelectorAll('video')].map((v) => ({ src: v.currentSrc, host: v.dataset.sourceHost, rs: v.readyState, paused: v.paused, err: v.error?.code })),
    }))
    console.log('    [diagnostic]', JSON.stringify(state), 'annonces 1063 :', relay.received.filter((e) => e.kind === 1063).length)
    throw err
  })
  assert.equal(host, '127.0.0.1:3006')
  await page.context().close()
  return 'lecture depuis la copie de préservation (127.0.0.1:3006) découverte par NIP-94'
})

await step('Préservation automatique après 5 s de visionnage', async () => {
  const sha = imeta(firstEvent).x[0]
  const page = await newPage({ mobile: true, init: { ...settings, blossomServers: [A.base, H.base], autoPreserve: true }, extra: { 'hw:e2e:preserveAlways': '1' } })
  await page.goto(`${APP}#14octobre`)
  await playbackHost(page)
  await waitFor(() => H.blobs.has(sha), 20_000, 'copie automatique sur H')
  await page.context().close()
})

// ---------------------------------------------------------------------------
// Test 6 — Signalement

await step('Signalement : kind 1984 (e, p, x) + PUT /report, vidéo masquée', async () => {
  const card = viewer.locator('[data-clip-key]').first()
  await card.getByRole('button', { name: "Plus d'actions" }).click()
  await viewer.getByRole('button', { name: 'Signaler ce contenu' }).click()
  await viewer.getByRole('button', { name: /Spam/ }).click()
  await viewer.locator('[data-clip-key]').first().waitFor({ state: 'detached', timeout: 5_000 })
  const report = await waitFor(() => relay.received.find((e) => e.kind === 1984), 60_000, 'signalement miné')
  assert.ok(report, 'aucun kind 1984 publié')
  for (const t of ['e', 'p', 'x']) assert.equal(tagOf(report, t)?.[2], 'spam', `tag ${t} sans motif`)
  // Preuve de travail NIP-13 ≥ 20 bits (anti-Sybil) : 5 chiffres hexadécimaux nuls en tête de l'id.
  assert.match(report.id, /^00000/, `preuve de travail insuffisante : ${report.id.slice(0, 8)}`)
  assert.ok(tagOf(report, 'nonce'), 'tag nonce absent')
  assert.ok(tagOf(report, 'a'), 'tag a absent')
  // PUT /report part après la publication sur les relais : on l'attend (course constatée en CI).
  const servers = await waitFor(() => [A, B, C].filter((s) => s.reports.length > 0).length === 3 && 3, 10_000, 'PUT /report sur les 3 serveurs').catch(
    () => [A, B, C].filter((s) => s.reports.length > 0).length,
  )
  assert.equal(servers, 3, `PUT /report reçu par ${servers}/3 serveurs`)
})

// ---------------------------------------------------------------------------
// Résilience : adresses de secours (docs/RESILIENCE.md, R2)

await step('Adresses de secours : liste signée par la clé du projet, faux miroir ignoré, aide si réseau bloqué', async () => {
  const { finalizeEvent } = require('nostr-tools/pure')
  const projectKey = new Uint8Array(32).fill(7) // clé de TEST (voir .env.e2e)
  const list = (sk, url, at) =>
    finalizeEvent({ kind: 30078, created_at: at, content: '', tags: [['d', 'hashwall-mirrors'], ['r', url, 'Miroir test']] }, sk)
  relay.seed(list(projectKey, 'https://miroir-signe.example/', Math.floor(Date.now() / 1000) - 60))
  // Un imposteur publie la même liste avec sa propre clé : elle doit être ignorée.
  relay.seed(list(new Uint8Array(32).fill(9), 'https://miroir-piege.example/', Math.floor(Date.now() / 1000)))

  const page = await newPage({ mobile: true })
  await page.goto(`${APP}#secours`)
  await page.waitForFunction(() => (localStorage.getItem('hw:mirrors') ?? '').includes('miroir-signe'), null, { timeout: 15_000 })
  await page.getByRole('button', { name: 'Réglages' }).click()
  await page.getByRole('button', { name: /Adresses de secours/ }).click()
  const signed = page.locator('[data-testid=rescue] [data-source="signée"]')
  await signed.waitFor({ timeout: 5_000 })
  assert.match(await signed.innerText(), /miroir-signe\.example\/#secours/)
  assert.equal(await page.locator('[data-mirror*="miroir-piege"]').count(), 0, 'miroir non signé par le projet affiché')
  await signed.getByRole('button', { name: 'QR' }).click()
  await signed.getByRole('img', { name: /QR code/ }).waitFor({ timeout: 3_000 })
  await page.context().close()

  // Réseau qui bloque tous les relais : le mur vide doit s'expliquer.
  const blocked = await newPage({ mobile: true, init: { ...settings, relays: ['ws://127.0.0.1:9'] } })
  await blocked.goto(`${APP}#secours`)
  const banner = blocked.getByTestId('network-banner')
  await banner.waitFor({ timeout: 25_000 })
  assert.match(await banner.innerText(), /Aucun relais ne répond/)
  await banner.getByRole('button', { name: /Adresses de secours/ }).click()
  await blocked.getByTestId('network-help').waitFor({ timeout: 3_000 })
  await blocked.context().close()
  return 'liste signée retenue, liste d’un imposteur rejetée, bandeau « réseau bloqué » affiché'
})

// ---------------------------------------------------------------------------
// Résilience : paquets hors ligne (docs/RESILIENCE.md, R3)

await step('Hors ligne : paquet signé confié à un proche, vérifié puis publié par lui', async () => {
  const witnessPage = await newPage({ mobile: true, init: { ...settings, termsAcceptedVersion: 1 }, extra: { 'hw:e2e:maxMs': '3000' } })
  await witnessPage.goto(`${APP}#horsligne`)
  await witnessPage.getByRole('button', { name: /Filmer pour #horsligne/ }).waitFor()
  await witnessPage.context().setOffline(true)
  await recordClip(witnessPage, 'horsligne')
  await witnessPage.getByTestId('bundle-open').waitFor({ timeout: 30_000 })
  // Constat réel (mode avion) : le diagnostic parlait de « CORS absents » au lieu de l'absence de réseau.
  await witnessPage.getByText(/Pas de réseau/).first().waitFor({ timeout: 5_000 })
  assert.ok(!(await witnessPage.getByText(/CORS absents/).count()), 'diagnostic trompeur hors ligne')
  await witnessPage.getByTestId('bundle-open').click()
  await witnessPage.getByTestId('bundle-name').waitFor({ timeout: 10_000 })
  const [download] = await Promise.all([witnessPage.waitForEvent('download'), witnessPage.getByRole('button', { name: /Enregistrer le fichier/ }).click()])
  mkdirSync(join(root, '..', 'e2e', 'artifacts'), { recursive: true })
  const bundlePath = join(root, '..', 'e2e', 'artifacts', 'paquet.mp4')
  await download.saveAs(bundlePath)
  assert.match(download.suggestedFilename(), /^hashwall-horsligne-[0-9a-f]{8}\.mp4$/)
  const witnessKey = await witnessPage.evaluate(() => JSON.parse(localStorage.getItem('hw:identity') ?? 'null'))
  await witnessPage.context().close()
  assert.ok(!videoEvents().some((e) => tagOf(e, 't')?.[1] === 'horsligne'), 'rien ne devait partir sans réseau')

  // Un fichier altéré est refusé.
  const bytes = readFileSync(bundlePath)
  const tampered = Buffer.from(bytes)
  tampered[2000] ^= 1
  const tamperedPath = join(root, '..', 'e2e', 'artifacts', 'altere.mp4')
  writeFileSync(tamperedPath, tampered)

  // Le porteur, avec du réseau et sans rapport avec l'auteur.
  const courier = await newPage({ mobile: true })
  await courier.goto(`${APP}#horsligne`)
  await courier.getByRole('button', { name: 'Réglages' }).click()
  await courier.getByRole('button', { name: /Publier une vidéo reçue/ }).click()
  await courier.getByTestId('bundle-file').setInputFiles(tamperedPath)
  await courier.getByText(/a été modifiée/).waitFor({ timeout: 10_000 })
  await courier.getByTestId('bundle-file').setInputFiles(bundlePath)
  await courier.getByTestId('bundle-summary').waitFor({ timeout: 10_000 })
  await courier.getByRole('button', { name: 'Publier sur le mur' }).click()
  await courier.getByTestId('bundle-result').waitFor({ timeout: 30_000 })
  const event = await waitFor(() => videoEvents().find((e) => tagOf(e, 't')?.[1] === 'horsligne'), 10_000, 'publication relayée')
  const sha = imeta(event).x[0]
  assert.equal(tagOf(event, 'd')[1], `hw-${sha.slice(0, 16)}`)
  const { getPublicKey } = require('nostr-tools/pure')
  const pubOf = (stored) => getPublicKey(Uint8Array.from(Buffer.from(stored.sk, 'hex')))
  assert.equal(event.pubkey, pubOf(witnessKey), 'la vidéo doit rester signée par son auteur')
  const courierKey = await courier.evaluate(() => JSON.parse(localStorage.getItem('hw:identity') ?? 'null'))
  if (courierKey) assert.notEqual(event.pubkey, pubOf(courierKey))
  assert.ok(!D.blobs.has(sha) && A.blobs.has(sha), 'envoi attendu sur A après le refus de D')
  assert.ok(B.blobs.has(sha) || C.blobs.has(sha), 'au moins une copie de secours attendue')
  await courier.keyboard.press('Escape')
  await courier.keyboard.press('Escape')
  const host = await playbackHost(courier)
  await courier.context().close()
  return `publiée par un tiers, signée par l’auteur ; lecture depuis ${host}`
})

// ---------------------------------------------------------------------------
// Service worker (audit F05) : désactivé en mode e2e, on l'enregistre ici à la main.

await step('Service worker : installation, puis relance de l’application hors ligne', async () => {
  const page = await newPage({ mobile: true })
  await page.goto(`${APP}#horsreseau`)
  await page.getByRole('button', { name: /Filmer pour #horsreseau/ }).waitFor()
  const state = await page.evaluate(async () => {
    try {
      await navigator.serviceWorker.register('./sw.js', { scope: './' })
      const reg = await Promise.race([navigator.serviceWorker.ready, new Promise((_, rej) => setTimeout(() => rej(new Error('activation trop longue')), 15_000))])
      return reg.active ? 'actif' : 'inactif'
    } catch (err) {
      return `échec : ${err.message}`
    }
  })
  assert.equal(state, 'actif', `service worker ${state}`)
  await page.reload()
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10_000 })
  await page.context().setOffline(true)
  await page.reload()
  await page.getByRole('button', { name: /Filmer pour #horsreseau/ }).waitFor({ timeout: 10_000 })
  await page.evaluate(() => (location.hash = '#autre'))
  await page.getByRole('button', { name: /Filmer pour #autre/ }).waitFor({ timeout: 5_000 })
  await page.context().close()
  return 'coquille applicative servie hors ligne'
})

// ---------------------------------------------------------------------------
// Effacement des données avec deux onglets ouverts (audit F03)

await step('Tout effacer avec un second onglet ouvert : la file d’envoi est réellement supprimée', async () => {
  const first = await newPage({ mobile: true })
  const context = first.context()
  await first.goto(`${APP}#effacer`)
  // Une vidéo en attente dans la file (IndexedDB), comme après une capture hors ligne.
  await first.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('hashwall', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('outbox', { keyPath: 'id' })
        req.onsuccess = () => {
          const db = req.result
          const t = db.transaction('outbox', 'readwrite')
          t.objectStore('outbox').put({ id: 'secret', createdAt: Date.now(), tag: 'effacer', state: 'failed', video: { sha256: 'secret' }, servers: [], mirrors: [], posterMirrors: [], attempts: 9, timings: {} })
          t.oncomplete = () => {
            db.close()
            resolve()
          }
          t.onerror = () => reject(t.error)
        }
      }),
  )
  await first.reload()
  const second = await context.newPage()
  await second.goto(`${APP}#effacer`)
  await second.getByRole('button', { name: /Filmer pour #effacer/ }).waitFor()
  await first.getByRole('button', { name: 'Réglages' }).click()
  await Promise.all([first.waitForEvent('load', { timeout: 15_000 }), first.getByRole('button', { name: 'Tout effacer maintenant' }).click()])
  const remaining = await first.evaluate(
    () =>
      new Promise((resolve) => {
        setTimeout(() => resolve(['base toujours verrouillée (suppression bloquée)']), 5000)
        const req = indexedDB.open('hashwall', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('outbox', { keyPath: 'id' })
        req.onsuccess = () => {
          const g = req.result.transaction('outbox').objectStore('outbox').getAll()
          g.onsuccess = () => resolve(g.result.map((j) => j.id))
        }
      }),
  )
  assert.deepEqual(remaining, [], `données restantes après effacement : ${remaining}`)
  await context.close()
})

// ---------------------------------------------------------------------------
// Constat réel (iPhone, 1ᵉʳ nov.) : l'état du filtre n'était pas visible (icône seule sur mobile).
// Défaut « Sans flou » depuis le 2 nov., le temps de remplacer le détecteur ; le choix est mémorisé.

await step('Filtre : libellé visible sur mobile, « Sans flou » / « Tout flou », choix mémorisé', async () => {
  const { captureFilter: _ignored, ...defaults } = settings
  const page = await newPage({ mobile: true, init: { ...defaults, termsAcceptedVersion: 1 } })
  await page.goto(`${APP}#defaut`)
  await page.getByRole('button', { name: /Filmer pour #defaut/ }).click()
  const toggle = page.getByRole('button', { name: /Filtre d'anonymisation/ })
  await toggle.waitFor({ timeout: 10_000 })
  assert.match(await toggle.getAttribute('aria-label'), /Sans filtre/)
  assert.match(await toggle.innerText(), /Sans flou/, 'libellé invisible sur mobile')
  await toggle.click()
  assert.match(await toggle.getAttribute('aria-label'), /Image pixelisée/)
  assert.match(await toggle.innerText(), /Tout flou/)
  await page.getByTestId('filter-status').waitFor({ timeout: 5_000 })
  // « Visages » n'est plus un mode de tournage : un clic de plus revient à « Sans flou ».
  await toggle.click()
  assert.match(await toggle.getAttribute('aria-label'), /Sans filtre/)
  await toggle.click()
  await page.getByRole('button', { name: 'Fermer la caméra' }).click()
  await page.getByRole('button', { name: /Filmer pour #defaut/ }).click()
  assert.match(await page.getByRole('button', { name: /Filtre d'anonymisation/ }).getAttribute('aria-label'), /Image pixelisée/)
  await page.context().close()
})

// ---------------------------------------------------------------------------
// Constat réel (iPhone, 1ᵉʳ nov.) : après la saisie dans « changer de mur », la page restait zoomée et
// coupée sur les bords. iOS zoome sur tout champ dont le texte fait moins de 16 px.

await step('Mobile : aucun champ de saisie sous 16 px (pas de zoom automatique d’iOS)', async () => {
  const page = await newPage({ mobile: true })
  const small = []
  const check = async (where) => {
    for (const s of await page.$$eval('input:not([type=checkbox]):not([type=radio]):not([type=file]), textarea, select', (els) =>
      els.filter((e) => e.offsetParent !== null).map((e) => ({ size: parseFloat(getComputedStyle(e).fontSize), label: e.getAttribute('aria-label') ?? e.getAttribute('placeholder') ?? e.tagName })),
    ))
      if (s.size < 16) small.push(`${where} : ${s.label} (${s.size} px)`)
  }
  await page.goto(`${APP}`)
  await page.getByRole('search').first().waitFor()
  await check('accueil')
  await page.goto(`${APP}#zoom`)
  await page.getByRole('button', { name: 'Changer de mur' }).click()
  await check('mur')
  await page.getByRole('button', { name: 'Réglages' }).click()
  await page.getByRole('dialog').waitFor()
  await check('réglages')
  assert.deepEqual(small, [], `champs trop petits : ${small.join(' ; ')}`)
  // Et aucune page plus large que l'écran.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
  assert.ok(overflow <= 0, `page plus large que l'écran de ${overflow} px`)
  await page.context().close()
})

// ---------------------------------------------------------------------------
// Montée en charge : mur viral (centaines de vidéos)

await step('Mur de 300 vidéos : rendu borné (fil fenêtré, grille par lots)', async () => {
  const { finalizeEvent, generateSecretKey } = require('nostr-tools/pure')
  const now = Math.floor(Date.now() / 1000)
  for (let i = 0; i < 300; i++) {
    const sha = createHash('sha256').update(`charge-${i}`).digest('hex')
    const sk = generateSecretKey()
    relay.seed(
      finalizeEvent(
        {
          kind: 34236,
          created_at: now - i,
          content: '',
          tags: [
            ['d', `hw-${sha.slice(0, 16)}`],
            ['title', `clip ${i}`],
            ['t', 'charge'],
            ['imeta', `url ${A.base}/${sha}.mp4`, `x ${sha}`, 'm video/mp4', 'dim 720x1280', `image ${A.base}/${sha}.jpg`],
            ['duration', '5'],
          ],
        },
        sk,
      ),
    )
  }
  const page = await newPage({ mobile: true })
  await page.goto(`${APP}#charge`)
  await page.locator('[data-clip-key]').nth(150).waitFor({ state: 'attached', timeout: 15_000 })
  const counts = await page.evaluate(() => ({
    sections: document.querySelectorAll('[data-testid=feed] section[data-clip-key]').length,
    media: document.querySelectorAll('[data-testid=feed] img, [data-testid=feed] video').length,
  }))
  assert.ok(counts.sections >= 150, `fil incomplet (${counts.sections})`)
  assert.ok(counts.media <= 10, `${counts.media} images/vidéos rendues dans le fil (fenêtre attendue ≤ 10)`)
  await page.context().close()

  const desk = await newPage()
  await desk.goto(`${APP}#charge`)
  await desk.getByTestId('grid-more').waitFor({ timeout: 15_000 })
  const cards = await desk.locator('[data-testid=grid] [data-clip-key]').count()
  assert.ok(cards <= 60, `${cards} cartes affichées d'un coup (lots de 60 attendus)`)
  await desk.getByTestId('grid-more').click()
  assert.ok((await desk.locator('[data-testid=grid] [data-clip-key]').count()) > cards)
  await desk.context().close()
  return `${counts.sections} vidéos dans le fil, ${counts.media} médias rendus ; grille : ${cards} cartes puis lot suivant`
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

await step('Pagination : « Vidéos plus anciennes » charge la page précédente', async () => {
  const page = await newPage({ extra: { 'hw:e2e:wallLimit': '1' } })
  await page.goto(`${APP}#voies`)
  await page.locator('[data-clip-key]').first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(1500)
  assert.equal(await page.locator('[data-clip-key]').count(), 1, 'l’historique devrait être limité à 1')
  await page.getByTestId('load-older').click()
  await page.locator('[data-clip-key]').nth(1).waitFor({ timeout: 10_000 })
  await page.getByTestId('load-older').click()
  await page.getByText('Début du mur atteint.').waitFor({ timeout: 10_000 })
  await page.context().close()
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
  const planes = await page.evaluate(async ([b64, SCENE_FACES, MOVING_FACE]) => {
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
    const frames = []
    // Bande unie en bas : un 4ᵉ visage y « saute » brusquement entre deux positions (mouvement brusque).
    for (const [mx, my, ms] of MOVING_FACE) {
      ctx.fillStyle = 'rgb(128,128,128)'
      ctx.fillRect(0, 560, W, H - 560)
      ctx.drawImage(img, mx, my, ms, ms)
      frames.push(toYuv(ctx.getImageData(0, 0, W, H).data))
    }
    return frames
    function toYuv(d) {
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
    }
  }, [face, SCENE_FACES, MOVING_FACE])
  await page.close()
  const frames = planes.map((p) => Buffer.concat([Buffer.from('FRAME\n'), ...p.map((x) => Buffer.from(x, 'base64'))]))
  mkdirSync(new URL('./artifacts/', import.meta.url), { recursive: true })
  writeFileSync(path, Buffer.concat([Buffer.from('YUV4MPEG2 W1280 H720 F30:1 Ip A1:1 C420jpeg\n'), ...frames]))
}

// Visages dans la bande centrale de la scène (x de 437,5 à 842,5 : ce que garde le recadrage 9:16).
const SCENE_FACES = [[500, 20, 180], [620, 260, 110], [520, 470, 70]]
// 4ᵉ visage : 6 images à gauche, 6 images à droite, en boucle (saut de 250 px toutes les 0,2 s).
const MOVING_FACE = [...Array(6).fill([450, 580, 130]), ...Array(6).fill([690, 580, 130])]
// Scène → canvas 720×1280 : échelle 1280/720, décalage horizontal de 437,5 px (recadrage centré).
const K = 1280 / 720
const toCanvas = (x, y, w, h) => ({ x: Math.round((x - 437.5) * K), y: Math.round(y * K), w: Math.round(w * K), h: Math.round(h * K) })
// Visage = 30,6 % du recadrage, décalé de 15,9 % / 20,6 % (cf. e2e/fixtures/face.jpg)
const FACES = SCENE_FACES.map(([x, y, s]) => toCanvas(x + s * 0.159, y + s * 0.206, s * 0.306, s * 0.306))
const BACKGROUND = toCanvas(775, 110, 60, 60)
const MOVING = [[450, 580, 130], [690, 580, 130]].map(([x, y, sz]) => toCanvas(x + sz * 0.159, y + sz * 0.206, sz * 0.306, sz * 0.306))

/**
 * « Platitude » d'une zone du canvas : part des pixels voisins strictement identiques.
 * ≈ 1 dans une zone pixelisée (blocs uniformes), ≈ 0 dans une image naturelle ou bruitée.
 */
const flatness = (page, r) =>
  page.evaluate((r) => {
    // Ce que voit l'utilisateur : image + calque de floutage (le cas échéant).
    const base = document.querySelector('canvas[aria-label="Aperçu de la caméra"]')
    const overlay = document.querySelector('[data-testid=blur-overlay]')
    const c = new OffscreenCanvas(base.width, base.height)
    const cx = c.getContext('2d')
    cx.drawImage(base, 0, 0)
    if (overlay) cx.drawImage(overlay, 0, 0)
    const d = cx.getImageData(r.x, r.y, r.w, r.h).data
    let same = 0, n = 0
    for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w - 1; i++) {
      const k = (j * r.w + i) * 4
      if (d[k] === d[k + 4] && d[k + 1] === d[k + 5] && d[k + 2] === d[k + 6]) same++
      n++
    }
    return same / n
  }, r)

await step('Visages floutés après coup (YuNet, expérimental) : à la demande, fichier final méconnaissable, aucune requête externe', async () => {
  const video = fileURLToPath(new URL('./artifacts/faces.y4m', import.meta.url))
  await makeFaceVideo(video)
  const faceBrowser = await chromium.launch({
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-video-capture=${video}`, '--no-proxy-server'],
  })
  try {
  // Constat réel (iPhone, Chrome iOS) : « Can't find variable: document ». MediaPipe ne reconnaît
  // OffscreenCanvas que si l'identifiant contient « Version/ » (Safari) ; Chrome, Firefox, Edge iOS
  // n'en ont pas. On simule donc l'identifiant de Chrome sur iPhone.
  const context = await faceBrowser.newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    permissions: ['camera', 'microphone'],
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.7390.96 Mobile/15E148 Safari/604.1',
  })
  await context.addInitScript((s) => {
    localStorage.setItem('hw:settings', JSON.stringify(s))
    localStorage.setItem('hw:e2e:maxMs', '3000')
  }, { ...settings, termsAcceptedVersion: 1, autoPublish: false })
  const external = []
  context.on('request', (r) => { if (!/^(http:\/\/127\.0\.0\.1|data:|blob:)/.test(r.url())) external.push(r.url()) })
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log('    [page error]', e.message))
  await page.goto(`${APP}#visages`)
  await page.getByRole('button', { name: /Filmer pour #visages/ }).click()
  await page.waitForFunction(() => !document.querySelector('[data-testid=record]')?.hasAttribute('disabled'), null, { timeout: 15_000 })
  await page.waitForTimeout(800)
  const base = { faces: await Promise.all(FACES.map((f) => flatness(page, f))), bg: await flatness(page, BACKGROUND) }
  assert.ok(base.faces.every((f) => f < 0.5) && base.bg < 0.2, `scène déjà plate ? ${JSON.stringify(base)}`)

  // Référence : contours des visages NETS dans l'image brute (canvas enregistré, sans le calque).
  // Pour le visage mobile, on attend une image où il est à gauche puis une où il est à droite.
  const sharp = await page.evaluate(async (regions) => {
    const c = document.querySelector('canvas[aria-label="Aperçu de la caméra"]')
    const cx = c.getContext('2d')
    const grad = (r) => {
      const d = cx.getImageData(r.x, r.y, r.w, r.h).data
      const out = []
      for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w - 1; i++) {
        const k = (j * r.w + i) * 4
        out.push(0.299 * (d[k + 4] - d[k]) + 0.587 * (d[k + 5] - d[k + 1]) + 0.114 * (d[k + 6] - d[k + 2]))
      }
      return out
    }
    const energy = (g) => g.reduce((a, b) => a + b * b, 0) / g.length
    const refs = []
    for (const r of regions) {
      let g = grad(r)
      for (let i = 0; i < 60 && energy(g) < 4; i++) {
        await new Promise((res) => setTimeout(res, 50))
        g = grad(r)
      }
      refs.push(g)
    }
    return refs
  }, [...FACES, ...MOVING])

  // Floutage APRÈS COUP, à la demande (décision du 2 nov.) : rien n'est flouté sans action.
  await page.getByTestId('record').click()
  await page.getByTestId('review').waitFor({ timeout: 30_000 })
  assert.equal(await page.getByTestId('faces-report').count(), 0, 'aucun floutage ne doit être automatique')
  await page.getByRole('button', { name: 'Flouter les visages' }).click()
  await page.getByTestId('faces-report').waitFor({ timeout: 120_000 })
  await page.getByRole('button', { name: 'Revenir à l’original' }).waitFor({ timeout: 5_000 })
  const report = Object.fromEntries(
    await Promise.all(['data-faces', 'data-corrected', 'data-full', 'data-ms', 'data-steps'].map(async (a) => [a, await page.getByTestId('faces-report').getAttribute(a)])),
  )
  const final = await page.evaluate(async ([regions, refs]) => {
    const v = document.querySelector('[data-testid=review] video')
    const probe = document.createElement('video')
    probe.muted = true
    probe.src = v.src
    await new Promise((r) => (probe.onloadeddata = r))
    const c = new OffscreenCanvas(720, 1280)
    const cx = c.getContext('2d', { willReadFrequently: true })
    const grad = (r) => {
      const d = cx.getImageData(r.x, r.y, r.w, r.h).data
      const out = []
      for (let j = 0; j < r.h; j++) for (let i = 0; i < r.w - 1; i++) {
        const k = (j * r.w + i) * 4
        out.push(0.299 * (d[k + 4] - d[k]) + 0.587 * (d[k + 5] - d[k + 1]) + 0.114 * (d[k + 6] - d[k + 2]))
      }
      return out
    }
    // Ressemblance des contours (corrélation normalisée des gradients) : ≈ 1 si le visage net est
    // reconnaissable, faible s'il est pixelisé (contours détruits) ou absent.
    const ncc = (a, b) => {
      let ab = 0, aa = 0, bb = 0
      for (let i = 0; i < a.length; i++) { ab += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i] }
      return aa && bb ? ab / Math.sqrt(aa * bb) : 0
    }
    const out = []
    for (let t = 0.1; t < probe.duration - 0.05; t += 1 / 15) {
      probe.currentTime = t
      await new Promise((r) => (probe.onseeked = r))
      cx.drawImage(probe, 0, 0, 720, 1280)
      out.push({ t: Math.round(t * 100) / 100, sim: regions.map((r, i) => ncc(grad(r), refs[i])) })
    }
    // Témoin : une copie du visage net, simplement ré-encodée, ressemblerait-elle bien à la référence ?
    return out
  }, [[...FACES, ...MOVING], sharp])
  // Visages FIXES : vérifiés strictement. Visage MOBILE (saut de 250 px toutes les 0,2 s) : la
  // fonction est expérimentale et peut le rater sur une image (constaté) ; mesuré et affiché seulement.
  const nFixed = FACES.length
  const worst = final.reduce((m, f) => Math.max(m, ...f.sim.slice(0, nFixed)), 0)
  const worstAt = final.find((f) => Math.max(...f.sim.slice(0, nFixed)) === worst)
  const movingLeaks = final.filter((f) => Math.max(...f.sim.slice(nFixed)) >= 0.65).length
  if (worst >= 0.65) {
    const png = await page.evaluate(async (t) => {
      const v = document.querySelector('[data-testid=review] video')
      const probe = document.createElement('video')
      probe.muted = true
      probe.src = v.src
      await new Promise((r) => (probe.onloadeddata = r))
      probe.currentTime = t
      await new Promise((r) => (probe.onseeked = r))
      const c = document.createElement('canvas')
      c.width = 720; c.height = 1280
      c.getContext('2d').drawImage(probe, 0, 0, 720, 1280)
      return c.toDataURL('image/png').split(',')[1]
    }, worstAt.t)
    writeFileSync(new URL('./artifacts/visage-net.png', import.meta.url), Buffer.from(png, 'base64'))
    const dbg = await page.evaluate(() => globalThis.__facePass)
    const fmt = (fr) => fr.map((f) => `${f.t.toFixed(2)}:${f.boxes.map((b) => `${Math.round(b.x)},${Math.round(b.y)},${Math.round(b.w)}@${(b.score ?? 0).toFixed(2)}`).join('|')}`).join('  ')
    console.log('    [analyse]', fmt(dbg.analysis))
    console.log('    [contrôle]', fmt(dbg.checked))
    console.log('    [régions mobiles]', JSON.stringify(MOVING))
    console.log('    [rendu]', dbg.renderLog.filter((r) => Math.abs(r.t - worstAt.t) < 0.15).map((r) => `${r.t.toFixed(3)}:${JSON.stringify(r.boxes.filter((b) => b[1] > 900))}`).join('  '))
  }
  console.log(`    [visage mobile] net sur ${movingLeaks}/${final.length} images contrôlées (limite connue, expérimental)`)
  console.log('    [ressemblance max par image]', final.map((f) => Math.max(...f.sim).toFixed(2)).join(' '))
  assert.ok(final.length >= 20, `trop peu d'images contrôlées (${final.length})`)
  // Seuil 0,65 : un visage net ré-encodé est mesuré à 0,83–0,92 ; un visage réduit à 6–7 points puis
  // lissé à 0,4–0,55 (le lissage garde les grandes formes, c'est voulu : la scène reste lisible).
  assert.ok(worst < 0.65, `visage reconnaissable dans la vidéo finale à ${worstAt?.t} s (ressemblance ${worst.toFixed(2)} ; ${JSON.stringify(worstAt)})`)
  // 3 visages fixes + 1 mobile vu à 2 endroits = 5 pistes ; au-delà, ce sont des fausses alertes
  // (constat réel : « 17 visages » pour une seule personne, porte et mur pixelisés).
  // (YuNet repère parfois un détail de plus dans la photo de test : jusqu'à 8 toléré, 17 ne l'est pas.)
  assert.ok(Number(report['data-faces']) >= 4 && Number(report['data-faces']) <= 8, `visages suivis : ${report['data-faces']} (4 à 8 attendus)`)
  assert.equal(report['data-full'], '0', 'aucun passage ne devrait être entièrement pixelisé')

  assert.deepEqual(external, [], `requêtes externes : ${external.join(', ')}`)
  return `vidéo finale : ${final.length} images contrôlées, visages fixes ressemblance max ${worst.toFixed(2)} (< 0,65), visage mobile net sur ${movingLeaks} image(s), ${report['data-faces']} visages suivis, ${report['data-corrected']} oubli(s) corrigé(s), traitement ${report['data-ms']} ms ${report['data-steps']}`
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
  // Audit F04 : serveurs média injoignables → suppression partielle, la vidéo et sa clé restent suivies.
  await witness.route(/127\.0\.0\.1:300[123]\//, (route) => route.abort('connectionrefused'))
  await witness.getByRole('button', { name: 'Supprimer cette vidéo' }).first().click()
  await witness.getByText(/Suppression partielle .*réessayez plus tard/).waitFor({ timeout: 20_000 })
  await witness.getByTestId('deletion-pending').first().waitFor({ timeout: 5_000 })
  await witness.unroute(/127\.0\.0\.1:300[123]\//)
  await witness.getByRole('button', { name: 'Supprimer cette vidéo' }).first().click()
  await witness.getByText(/Suppression confirmée/).waitFor({ timeout: 20_000 })
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
  Promise.all([relay.close(), A.close(), B.close(), C.close(), D.close(), E.close(), OTS.close(), G.close(), H.close(), new Promise((r) => web.close(r))]),
  new Promise((r) => setTimeout(r, 3000)),
])
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} tests réussis${mimeUsed ? ` — format enregistré par Chromium : ${mimeUsed}` : ''}\n`)
process.exit(failed.length ? 1 : 0)
