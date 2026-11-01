// Serveur Blossom minimal pour les tests : BUD-01/02/04/06/09/11/12, CORS, requêtes Range.
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { verifyEvent } from 'nostr-tools/pure'

const EXT = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'image/jpeg': 'jpg' }

export function startBlossom(port, { mirror = true, refuseUploads = false } = {}) {
  const base = `http://127.0.0.1:${port}`
  const blobs = new Map()
  const log = []
  const reports = []

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, *',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE',
    'Access-Control-Expose-Headers': 'X-Reason',
  }

  function checkAuth(req, verb, sha) {
    const header = req.headers.authorization ?? ''
    if (!header.startsWith('Nostr ')) return 'missing auth'
    const b64 = header.slice(6)
    if (/[+/=]/.test(b64)) return 'auth is not base64url without padding'
    let event
    try {
      event = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'))
    } catch {
      return 'undecodable auth'
    }
    if (event.kind !== 24242 || !verifyEvent(event)) return 'invalid auth event'
    const tag = (n) => event.tags.filter((t) => t[0] === n).map((t) => t[1])
    if (tag('t')[0] !== verb) return `wrong verb ${tag('t')[0]}`
    const exp = Number(tag('expiration')[0])
    if (!(exp > Date.now() / 1000)) return 'expired'
    if (event.created_at > Date.now() / 1000 + 5) return 'created_at in future'
    const servers = tag('server')
    if (servers.length && !servers.includes('127.0.0.1')) return 'server scope mismatch'
    if (sha && !tag('x').includes(sha)) return 'x tag mismatch'
    return { event }
  }

  const descriptor = (sha) => {
    const b = blobs.get(sha)
    return { url: `${base}/${sha}.${EXT[b.type] ?? 'bin'}`, sha256: sha, size: b.data.length, type: b.type, uploaded: Math.floor(Date.now() / 1000) }
  }

  const readBody = (req) =>
    new Promise((resolve) => {
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => resolve(Buffer.concat(chunks)))
    })

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base)
    const entry = { method: req.method, path: url.pathname, headers: { ...req.headers }, at: Date.now() }
    log.push(entry)
    const send = (status, body, headers = {}) => {
      res.writeHead(status, { ...cors, ...headers })
      res.end(body)
    }
    const deny = (status, reason) => send(status, '', { 'X-Reason': reason })

    if (req.method === 'OPTIONS') return send(204, '')

    if (refuseUploads && (url.pathname === '/upload' || url.pathname === '/mirror')) {
      return deny(401, 'pubkey not whitelisted')
    }

    if (url.pathname === '/upload' && req.method === 'HEAD') {
      const sha = req.headers['x-sha-256']
      if (!/^[0-9a-f]{64}$/.test(sha ?? '')) return deny(400, 'bad X-SHA-256')
      if (!req.headers['x-content-length']) return deny(411, 'length required')
      const auth = checkAuth(req, 'upload', sha)
      entry.auth = auth
      if (typeof auth === 'string') return deny(401, auth)
      return send(200, '')
    }

    if (url.pathname === '/upload' && req.method === 'PUT') {
      const data = await readBody(req)
      const sha = createHash('sha256').update(data).digest('hex')
      const auth = checkAuth(req, 'upload', sha)
      entry.auth = auth
      if (typeof auth === 'string') return deny(401, auth)
      if (req.headers['x-sha-256'] && req.headers['x-sha-256'] !== sha) return deny(409, 'hash mismatch')
      const existed = blobs.has(sha)
      blobs.set(sha, { data, type: (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0] })
      return send(existed ? 200 : 201, JSON.stringify(descriptor(sha)), { 'Content-Type': 'application/json' })
    }

    if (url.pathname === '/mirror' && req.method === 'PUT') {
      if (!mirror) return deny(405, 'mirror not supported')
      const { url: source } = JSON.parse((await readBody(req)).toString() || '{}')
      entry.source = source
      let upstream
      try {
        upstream = await fetch(source)
      } catch {
        return deny(502, 'cannot fetch origin')
      }
      if (!upstream.ok) return deny(502, `origin ${upstream.status}`)
      const data = Buffer.from(await upstream.arrayBuffer())
      const sha = createHash('sha256').update(data).digest('hex')
      const auth = checkAuth(req, 'upload', sha)
      entry.auth = auth
      if (typeof auth === 'string') return deny(typeof auth === 'string' && auth.includes('x tag') ? 409 : 401, auth)
      blobs.set(sha, { data, type: (upstream.headers.get('content-type') ?? 'application/octet-stream').split(';')[0] })
      return send(201, JSON.stringify(descriptor(sha)), { 'Content-Type': 'application/json' })
    }

    if (url.pathname === '/report' && req.method === 'PUT') {
      const event = JSON.parse((await readBody(req)).toString() || '{}')
      if (event.kind !== 1984 || !verifyEvent(event) || !event.tags.some((t) => t[0] === 'x')) return deny(400, 'invalid report')
      reports.push(event)
      return send(200, '')
    }

    const match = url.pathname.match(/^\/([0-9a-f]{64})(\.\w+)?$/)
    if (match) {
      const sha = match[1]
      if (req.method === 'DELETE') {
        const auth = checkAuth(req, 'delete', sha)
        entry.auth = auth
        if (typeof auth === 'string') return deny(401, auth)
        blobs.delete(sha)
        return send(200, '')
      }
      const blob = blobs.get(sha)
      if (!blob) return deny(404, 'not found')
      const total = blob.data.length
      const headers = { 'Content-Type': blob.type, 'Accept-Ranges': 'bytes' }
      const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/)
      if (range && req.method === 'GET') {
        const start = range[1] ? Number(range[1]) : 0
        const end = range[2] ? Math.min(Number(range[2]), total - 1) : total - 1
        if (start >= total) return deny(416, 'range')
        res.writeHead(206, { ...cors, ...headers, 'Content-Range': `bytes ${start}-${end}/${total}`, 'Content-Length': end - start + 1 })
        return res.end(blob.data.subarray(start, end + 1))
      }
      res.writeHead(200, { ...cors, ...headers, 'Content-Length': total })
      return res.end(req.method === 'HEAD' ? undefined : blob.data)
    }

    deny(404, 'unknown route')
  })

  return new Promise((resolve) =>
    server.listen(port, '127.0.0.1', () =>
      resolve({ base, blobs, log, reports, close: () => new Promise((r) => server.close(r)) }),
    ),
  )
}
