import { bytesToHex } from '@noble/hashes/utils.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const net = vi.hoisted(() => ({
  relaysOk: [] as string[],
  deleted: new Set<string>(),
  calls: [] as string[],
  present: true,
}))

vi.mock('./nostr/pool', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./nostr/pool')>()),
  publishEvent: () => {
    const ok = [...net.relaysOk]
    const first = ok.length ? Promise.resolve(ok[0]) : Promise.reject(new Error('aucun relais'))
    first.catch(() => {})
    return {
      first,
      all: Promise.resolve({ ok, failed: [] }),
    }
  },
}))
vi.mock('./blossom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./blossom/client')>()),
  deleteBlob: async (server: string, sha: string) => {
    net.calls.push(`${server}/${sha}`)
    return net.deleted.has(server) ? 'deleted' : net.present ? 'failed' : 'not-found'
  },
  hasBlob: async () => net.present,
}))

import { deleteMyClip } from './publish'
import { getMyClips, removeMyClip, saveMyClip, type MyClip } from './storage/personal'

const sk = generateSecretKey()
const clip = (): MyClip => ({
  key: `34236:${getPublicKey(sk)}:hw-1`,
  kind: 34236,
  d: 'hw-1',
  eventId: 'e'.repeat(64),
  pubkey: getPublicKey(sk),
  sk: bytesToHex(sk),
  sha256: 'a'.repeat(64),
  servers: ['https://a.example', 'https://b.example'],
  tag: 'mur',
  publishedAt: 1,
  url: `https://a.example/${'a'.repeat(64)}.mp4`,
})

beforeEach(() => {
  net.relaysOk = []
  net.deleted = new Set()
  net.calls = []
  net.present = true
  removeMyClip(clip().key)
})

describe('suppression distante (audit F04)', () => {
  it('échec total : le suivi et la clé sont conservés, l’échec est signalé comme tel', async () => {
    saveMyClip(clip())
    const r = await deleteMyClip(clip())
    expect(r.status).toBe('failed')
    const kept = getMyClips().find((c) => c.key === clip().key)
    expect(kept?.sk).toBe(bytesToHex(sk))
    expect(kept?.deletion?.status).toBe('failed')
  })

  it('succès partiel puis nouvelle tentative : seules les cibles restantes sont relancées', async () => {
    saveMyClip(clip())
    net.relaysOk = ['wss://r1']
    net.deleted = new Set(['https://a.example'])
    const r1 = await deleteMyClip(clip())
    expect(r1).toMatchObject({ status: 'partial', relays: 1, servers: 1, serversTotal: 2 })
    const kept = getMyClips().find((c) => c.key === clip().key)!
    expect(kept.deletion?.serversDone).toEqual(['https://a.example'])

    net.calls = []
    net.deleted = new Set(['https://b.example'])
    const r2 = await deleteMyClip(kept)
    expect(net.calls).toEqual([`https://b.example/${'a'.repeat(64)}`])
    expect(r2.status).toBe('done')
    expect(getMyClips().find((c) => c.key === clip().key)).toBeUndefined()
  })

  it('un fichier déjà absent du serveur compte comme supprimé', async () => {
    saveMyClip(clip())
    net.relaysOk = ['wss://r1']
    net.present = false
    const r = await deleteMyClip(clip())
    expect(r.status).toBe('done')
  })
})
