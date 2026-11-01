// Relais Nostr minimal (NIP-01) pour les tests : REQ / EVENT / CLOSE, vérification des
// signatures, remplacement des événements adressables, diffusion en direct.
import { matchFilter } from 'nostr-tools/filter'
import { verifyEvent } from 'nostr-tools/pure'
import { WebSocketServer } from 'ws'

export function startRelay(port) {
  const events = []
  const received = []
  const wss = new WebSocketServer({ port, host: '127.0.0.1' })
  const subs = new Map() // ws -> Map<subId, filters>

  const isAddressable = (k) => k >= 30000 && k < 40000
  const isReplaceable = (k) => k === 0 || k === 3 || (k >= 10000 && k < 20000)
  const dTag = (e) => e.tags.find((t) => t[0] === 'd')?.[1] ?? ''

  function store(event) {
    if (isAddressable(event.kind) || isReplaceable(event.kind)) {
      const same = (e) => e.kind === event.kind && e.pubkey === event.pubkey && (!isAddressable(event.kind) || dTag(e) === dTag(event))
      const existing = events.find(same)
      if (existing && existing.created_at >= event.created_at) return false
      if (existing) events.splice(events.indexOf(existing), 1)
    }
    if (event.kind === 5) {
      for (const t of event.tags) {
        if (t[0] === 'a') {
          const [kind, pubkey, d] = t[1].split(':')
          for (let i = events.length - 1; i >= 0; i--) {
            const e = events[i]
            if (String(e.kind) === kind && e.pubkey === pubkey && dTag(e) === d && pubkey === event.pubkey) events.splice(i, 1)
          }
        }
      }
    }
    events.push(event)
    return true
  }

  wss.on('connection', (ws) => {
    subs.set(ws, new Map())
    ws.on('message', (raw) => {
      let msg
      try {
        msg = JSON.parse(raw.toString())
      } catch {
        return
      }
      const [type, ...rest] = msg
      if (type === 'EVENT') {
        const event = rest[0]
        received.push(event)
        if (!verifyEvent(event)) {
          ws.send(JSON.stringify(['OK', event.id, false, 'invalid: bad signature']))
          return
        }
        store(event)
        ws.send(JSON.stringify(['OK', event.id, true, '']))
        for (const [client, clientSubs] of subs) {
          for (const [id, filters] of clientSubs) {
            if (filters.some((f) => matchFilter(f, event))) client.send(JSON.stringify(['EVENT', id, event]))
          }
        }
      } else if (type === 'REQ') {
        const [id, ...filters] = rest
        subs.get(ws).set(id, filters)
        const out = new Map()
        for (const f of filters) {
          const matches = events.filter((e) => matchFilter(f, e)).sort((a, b) => b.created_at - a.created_at)
          for (const e of matches.slice(0, f.limit ?? 500)) out.set(e.id, e)
        }
        for (const e of out.values()) ws.send(JSON.stringify(['EVENT', id, e]))
        ws.send(JSON.stringify(['EOSE', id]))
      } else if (type === 'CLOSE') {
        subs.get(ws)?.delete(rest[0])
      }
    })
    ws.on('close', () => subs.delete(ws))
  })

  return {
    url: `ws://127.0.0.1:${port}`,
    events,
    received,
    close: () => new Promise((r) => wss.close(r)),
  }
}
