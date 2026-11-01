// Sonde en LECTURE SEULE des serveurs Blossom et relais Nostr par défaut.
// Rien n'est envoyé ni publié : requêtes CORS (OPTIONS), pré-vérifications HEAD /upload
// avec un jeton signé par une clé jetable, présence d'un blob de test, NIP-11 et REQ.
// Usage : node scripts/probe-servers.mjs   (lancé par .github/workflows/probe.yml)
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import WebSocket from 'ws'

const ORIGIN = process.env.PROBE_ORIGIN ?? 'https://deylac.github.io'
const SERVERS = (process.env.PROBE_SERVERS ??
  'https://blossom.nostr.build https://blossom.primal.net https://nostr.download https://blosstr.com https://cdn.nostrcheck.me https://blossom.band https://24242.io https://blossom.yakihonne.com https://files.sovbit.host https://cdn.satellite.earth').split(/\s+/)
const RELAYS = (process.env.PROBE_RELAYS ??
  'wss://relay.damus.io wss://nos.lol wss://relay.primal.net wss://nostr.mom wss://relay.nostr.net wss://offchain.pub').split(/\s+/)
const TEST_SHA = process.env.PROBE_SHA ?? '24c0b651b034d1948aafcc83095d49db1add67200a788027c4757843aabecdd4'
const TEST_TAG = process.env.PROBE_TAG ?? 'testhashwall'
const FAKE_SHA = 'f'.repeat(63) + '0'
const sk = generateSecretKey()

function auth(verb, sha, server) {
  const now = Math.floor(Date.now() / 1000)
  const event = finalizeEvent(
    {
      kind: 24242,
      created_at: now,
      content: 'HashWall probe (no upload)',
      tags: [['t', verb], ['expiration', String(now + 600)], ['x', sha], ['server', new URL(server).hostname]],
    },
    sk,
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString('base64url')}`
}

async function req(url, init = {}, ms = 15000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  const t0 = Date.now()
  try {
    const res = await fetch(url, { ...init, signal: controller.signal, redirect: 'manual' })
    return { status: res.status, ms: Date.now() - t0, h: (n) => res.headers.get(n) }
  } catch (err) {
    return { status: 0, ms: Date.now() - t0, error: err.name === 'AbortError' ? 'TIMEOUT' : String(err.cause?.code ?? err.message), h: () => null }
  } finally {
    clearTimeout(timer)
  }
}

const fmt = (r) => (r.status ? `${r.status} (${r.ms} ms)` : `ERREUR ${r.error} (${r.ms} ms)`)

async function preflight(server, path, headers) {
  const r = await req(`${server}${path}`, {
    method: 'OPTIONS',
    headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': headers },
  })
  const allowOrigin = r.h('access-control-allow-origin')
  const allowHeaders = (r.h('access-control-allow-headers') ?? '').toLowerCase()
  const allowMethods = r.h('access-control-allow-methods')
  const wanted = headers.split(',')
  const ok =
    r.status >= 200 && r.status < 300 && (allowOrigin === '*' || allowOrigin === ORIGIN) &&
    (allowHeaders.includes('*') ? wanted.includes('authorization') ? allowHeaders.includes('authorization') : true : wanted.every((h) => allowHeaders.includes(h)))
  return `${ok ? 'OK ' : 'KO '} ${fmt(r)} origin=${allowOrigin} headers=${allowHeaders || '-'} methods=${allowMethods || '-'}`
}

const summary = []
console.log(`PROBE origine simulée : ${ORIGIN}\n`)
for (const server of SERVERS) {
  console.log(`=== ${server}`)
  const root = await req(`${server}/`, { method: 'GET' })
  console.log(`  GET /                         ${fmt(root)}`)
  console.log(`  CORS PUT /upload +x-sha-256   ${await preflight(server, '/upload', 'authorization,content-type,x-sha-256')}`)
  console.log(`  CORS PUT /upload sans x-sha   ${await preflight(server, '/upload', 'authorization,content-type')}`)
  console.log(`  CORS HEAD /upload (BUD-06)    ${await preflight(server, '/upload', 'authorization,x-sha-256,x-content-length,x-content-type').then((s) => s)}`)
  console.log(`  CORS PUT /mirror              ${await preflight(server, '/mirror', 'authorization,content-type,x-sha-256')}`)
  const headNoAuth = await req(`${server}/upload`, {
    method: 'HEAD',
    headers: { 'X-SHA-256': FAKE_SHA, 'X-Content-Length': '5000000', 'X-Content-Type': 'video/mp4' },
  })
  console.log(`  HEAD /upload sans jeton       ${fmt(headNoAuth)} reason=${headNoAuth.h('x-reason') ?? '-'}`)
  let lastHead = 0
  for (const size of [5_000_000, 19_000_000]) {
    const head = await req(`${server}/upload`, {
      method: 'HEAD',
      headers: { 'X-SHA-256': FAKE_SHA, 'X-Content-Length': String(size), 'X-Content-Type': 'video/mp4', Authorization: auth('upload', FAKE_SHA, server) },
    })
    lastHead = head.status
    console.log(`  HEAD /upload jeton ${String(size / 1e6).padStart(2)} Mo    ${fmt(head)} reason=${head.h('x-reason') ?? '-'} expose=${head.h('access-control-expose-headers') ?? '-'}`)
  }
  const blob = await req(`${server}/${TEST_SHA}.mp4`, { method: 'HEAD' })
  console.log(`  HEAD blob de test             ${fmt(blob)} type=${blob.h('content-type') ?? '-'} ranges=${blob.h('accept-ranges') ?? '-'} acao=${blob.h('access-control-allow-origin') ?? '-'} sunset=${blob.h('sunset') ?? '-'}`)
  const missing = await req(`${server}/${FAKE_SHA}.mp4`, { method: 'HEAD', headers: { Origin: ORIGIN } })
  const errCors = missing.h('access-control-allow-origin')
  console.log(`  CORS sur réponse d'erreur     ${errCors ? 'OK ' : 'KO '} ${fmt(missing)} acao=${errCors ?? '-'}`)
  console.log(`  CORS PUT /report (BUD-09)     ${await preflight(server, '/report', 'content-type')}`)
  summary.push({ server, upload: lastHead, errCors: !!errCors })
  console.log('')
}

async function probeRelay(url) {
  const info = await req(url.replace(/^wss/, 'https'), { headers: { Accept: 'application/nostr+json' } })
  return new Promise((resolve) => {
    const t0 = Date.now()
    const lines = [`=== ${url}`, `  NIP-11 ${fmt(info)}`]
    let count = 0
    let done = false
    const finish = (msg) => {
      if (done) return
      done = true
      lines.push(`  ${msg}`)
      try {
        ws.close()
      } catch {}
      resolve(lines.join('\n'))
    }
    const ws = new WebSocket(url, { headers: { Origin: ORIGIN } })
    const timer = setTimeout(() => finish(`TIMEOUT après ${Date.now() - t0} ms (${count} événements)`), 12000)
    ws.on('open', () => {
      lines.push(`  connecté en ${Date.now() - t0} ms`)
      ws.send(JSON.stringify(['REQ', 'p', { kinds: [34236], '#t': [TEST_TAG], limit: 20 }]))
    })
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg[0] === 'EVENT') count++
      else if (msg[0] === 'EOSE') {
        clearTimeout(timer)
        finish(`EOSE en ${Date.now() - t0} ms : ${count} vidéo(s) #${TEST_TAG}`)
      } else if (msg[0] === 'CLOSED' || msg[0] === 'NOTICE' || msg[0] === 'AUTH') lines.push(`  ${msg[0]} ${JSON.stringify(msg.slice(1))}`)
    })
    ws.on('error', (err) => {
      clearTimeout(timer)
      finish(`ERREUR ${err.message}`)
    })
  })
}

for (const relay of RELAYS) console.log(await probeRelay(relay), '\n')

// --- OpenTimestamps : calendriers (POST /digest, requête « simple » sans pré-vol CORS) ---
const CALENDARS = (process.env.PROBE_CALENDARS ??
  'https://alice.btc.calendar.opentimestamps.org https://bob.btc.calendar.opentimestamps.org https://finney.calendar.eternitywall.com https://btc.calendar.catallaxy.com').split(/\s+/)
const randomDigest = crypto.getRandomValues(new Uint8Array(32))
for (const cal of CALENDARS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15000)
  const t0 = Date.now()
  try {
    const res = await fetch(`${cal}/digest`, {
      method: 'POST',
      headers: { Origin: ORIGIN, Accept: 'application/vnd.opentimestamps.v1', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: randomDigest,
      signal: controller.signal,
    })
    const bytes = new Uint8Array(await res.arrayBuffer())
    console.log(`=== ${cal}\n  POST /digest ${res.status} (${Date.now() - t0} ms) ${bytes.length} octets acao=${res.headers.get('access-control-allow-origin') ?? '-'} début=${Buffer.from(bytes.slice(0, 24)).toString('hex')}`)
    const miss = await req(`${cal}/timestamp/${'00'.repeat(32)}`, { headers: { Origin: ORIGIN, Accept: 'application/vnd.opentimestamps.v1' } })
    console.log(`  GET /timestamp/<inconnu> ${fmt(miss)} acao=${miss.h('access-control-allow-origin') ?? '-'}`)
  } catch (err) {
    console.log(`=== ${cal}\n  ERREUR ${err.name === 'AbortError' ? 'TIMEOUT' : err.message}`)
  } finally {
    clearTimeout(timer)
  }
}

// --- Explorateurs Bitcoin (vérification des attestations) ---
for (const api of ['https://blockstream.info/api', 'https://mempool.space/api']) {
  const tip = await req(`${api}/blocks/tip/height`, { headers: { Origin: ORIGIN } })
  const hash = await req(`${api}/block-height/810391`, { headers: { Origin: ORIGIN } })
  console.log(`=== ${api}\n  tip ${fmt(tip)} acao=${tip.h('access-control-allow-origin') ?? '-'} ; block-height ${fmt(hash)} acao=${hash.h('access-control-allow-origin') ?? '-'}`)
}

// --- Hébergement du modèle MediaPipe (pour information) ---
const model = await req('https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite', { method: 'HEAD', headers: { Origin: ORIGIN } })
console.log(`=== modèle MediaPipe sur storage.googleapis.com : ${fmt(model)} acao=${model.h('access-control-allow-origin') ?? '-'}`)

console.log('\n| Serveur | HEAD /upload (jeton) | CORS sur erreurs |\n|---|---|---|')
for (const r of summary) console.log(`| ${r.server.replace('https://', '')} | ${r.upload || 'erreur'} | ${r.errCors ? 'oui' : 'non'} |`)
