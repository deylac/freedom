// Calendrier OpenTimestamps et explorateur Bitcoin (API Esplora) simulés.
// Comme les vrais calendriers : CORS sur les réponses 200, pas sur les 404.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const PENDING_TAG = Buffer.from('83dfe30d2ef90c8e', 'hex')
const BITCOIN_TAG = Buffer.from('0588960d73d71901', 'hex')
const varuint = (n) => {
  const out = []
  do {
    let b = n & 0x7f
    n = Math.floor(n / 128)
    if (n) b |= 0x80
    out.push(b)
  } while (n)
  return Buffer.from(out)
}
const varbytes = (b) => Buffer.concat([varuint(b.length), b])
const sha256 = (b) => createHash('sha256').update(b).digest()

export async function startOts(calendarPort, explorerPort, height = 800000) {
  const base = `http://127.0.0.1:${calendarPort}`
  const state = { upgraded: false, submitted: [], roots: new Map() }
  const suffix = Buffer.alloc(8, 1)

  const calendar = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const ok = (body) => {
        res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/octet-stream' })
        res.end(body)
      }
      if (req.method === 'POST' && req.url === '/digest') {
        const commitment = Buffer.concat(chunks)
        state.submitted.push(commitment.toString('hex'))
        // append(01×8) puis attestation « en attente » chez ce calendrier
        const pending = Buffer.concat([Buffer.from([0x00]), PENDING_TAG, varbytes(varbytes(Buffer.from(base)))])
        return ok(Buffer.concat([Buffer.from([0xf0]), varbytes(suffix), pending]))
      }
      const m = req.url?.match(/^\/timestamp\/([0-9a-f]+)$/)
      if (req.method === 'GET' && m && state.upgraded) {
        const msg = Buffer.from(m[1], 'hex')
        const root = sha256(msg)
        state.roots.set(height, Buffer.from(root).reverse().toString('hex'))
        const attestation = Buffer.concat([Buffer.from([0x00]), BITCOIN_TAG, varbytes(varuint(height))])
        return ok(Buffer.concat([Buffer.from([0x08]), attestation]))
      }
      res.writeHead(404) // sans en-tête CORS, comme les vrais calendriers
      res.end('Pending confirmation in Bitcoin blockchain')
    })
  })

  const explorer = createServer((req, res) => {
    const cors = { 'Access-Control-Allow-Origin': '*' }
    const h = req.url?.match(/^\/block-height\/(\d+)$/)
    if (h && state.roots.has(Number(h[1]))) {
      res.writeHead(200, cors)
      return res.end('ab'.repeat(32))
    }
    if (req.url === `/block/${'ab'.repeat(32)}`) {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ merkle_root: state.roots.get(height), timestamp: 1767225600 }))
    }
    res.writeHead(404, cors)
    res.end()
  })

  await Promise.all([new Promise((r) => calendar.listen(calendarPort, '127.0.0.1', r)), new Promise((r) => explorer.listen(explorerPort, '127.0.0.1', r))])
  return {
    calendarUrl: base,
    explorerUrl: `http://127.0.0.1:${explorerPort}`,
    state,
    close: () => Promise.all([new Promise((r) => calendar.close(r)), new Promise((r) => explorer.close(r))]),
  }
}
