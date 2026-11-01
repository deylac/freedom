import { readFileSync } from 'node:fs'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import { stampDigest, upgradeProof, verifyProof } from './client'
import { attestationsOf, bytesToHex, hexToBytes, parseOts, serializeOts } from './ots'

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))

/**
 * Données RÉELLES relevées le 1ᵉʳ nov. 2026 par scripts/probe-servers.mjs (GitHub Actions) :
 * racines de Merkle des blocs (identiques chez blockstream.info et mempool.space) et réponse
 * d'alice.btc.calendar.opentimestamps.org à la mise à niveau de incomplete.txt.ots.
 */
const BLOCKS: Record<number, { merkle_root: string; timestamp: number }> = {
  358391: { merkle_root: '8a1b66ecb7cbd07d8139a7e7d7f2c41aab1f5009b8364aaf61d03ad245e47e00', timestamp: 1432827678 },
  428648: { merkle_root: '078cdde9c89f2e3c58c96b1658627fd9298c63c6618954ea24ac3b5a13fe18da', timestamp: 1473227803 },
}
const ALICE_UPGRADE_HEX =
  '08f1206563bb432a829ac8d6c54d1a9330d2240664cad8338dd05e63eec12a18a68d5008f020ba83ddbe2bd6772b4584b46eaed23606b712dd740a89e99e927571f77f64aa2108f120193c81e70e4472b52811fe7837ce1293b1d3542b244f27f44182af8287fc9f4e08f120c6c57696fcd39b4d992477889d04e6882829f5fe556304a281dce258b78a1f0708f1ae010100000001b592ca038eaa9c1b698a049b09be8ee8972b5d0eca29c19946027ba9248acb03000000004847304402200f992d5dbec6edb143f76c14e4538e0a50d66bae27c683cf4291e475287ec6af022010bae9443390aadbd2e2b8b9f757beea26d3f5c345f7e6b4d81b3d390edd381801fdffffff022eb142000000000023210338b2490eaa949538423737cd83449835d1061dca88f4ffaca7181bcac67d2095ac0000000000000000226a20f004678a06000808f120977ac39d89bb8b879d4a2c38fca48a040c82637936707fc452c9db1390b515c80808f02074268b23e614997d18c7c063d8d82d7e1db57b5fc4346cc47ac2c46d54168d710808f120560c45b854f8507c8bfacf2662fef269c208a7e5df5c3145cbce417ecacc595e0808f1200dba8721b9cd4ac7c2fcc7e15ba2cb9f2906bfc577c212747cd352d61b5d7fdb0808f12081107a010d527d18baa874bc99c19a3a7a25dfe110a4c8985bf30f6c3e77baed0808f020ca3cdcd7093498b3f180b38a9773207e52fca992c2db1d660fdfa1b329500c390808f020ca6c6464dd02ced64c9c82246ccfc626caa78d9e624cc11013e3b4bbc09e98910808f0201c7ae0feac018fa19bd8459a4ae971b3e6c816a87254317e0a9f0ec9425ba7610808f12090263a73e415a975dc07706772dbb6200ef0d0a23006218e65d4a5d8112067300808f12079530163b0d912249438628bd791ac9402fa707eb314c6237b0ef90271625c840808000588960d73d7190103e8941a'
const ALICE = 'https://alice.btc.calendar.opentimestamps.org'
const INCOMPLETE_COMMITMENT = '57cfa5c46716df9bd9e83595bce439c58108d8fcc1678f30d4c6731c3f1fa6c79ed712c66fb1ac8d4e4eb0e7'

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>
function fakeFetch(handler: Handler) {
  const calls: string[] = []
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push(url)
    return handler(url, init)
  }) as typeof fetch
  return { impl, calls }
}

/** Explorateur Esplora simulé à partir des vraies données de blocs (ou d'une racine falsifiée). */
const esplora = (override?: (height: number) => string | undefined): Handler => (url) => {
  const h = url.match(/block-height\/(\d+)$/)
  if (h) return new Response(`hash${h[1]}`.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a'), { status: 200 })
  const b = url.match(/block\/(hash\d+)/) ?? url.match(/block\/([0-9a-f]+)$/)
  if (b) {
    const height = Number(Object.keys(BLOCKS).find((k) => `hash${k}`.padEnd(64, '0').replace(/[^0-9a-f]/g, 'a') === b[1]))
    const block = BLOCKS[height]
    if (!block) return new Response('', { status: 404 })
    return Response.json({ merkle_root: override?.(height) ?? block.merkle_root, timestamp: block.timestamp })
  }
  return new Response('', { status: 404 })
}

describe('verifyProof — données Bitcoin réelles', () => {
  it('hello-world.txt est vérifié au bloc 358391 (28 mai 2015) par deux explorateurs', async () => {
    const ots = parseOts(fixture('hello-world.txt.ots'))
    const { impl } = fakeFetch(esplora())
    const status = await verifyProof(ots, sha256(fixture('hello-world.txt')), {
      fetchImpl: impl,
      explorers: ['https://blockstream.info/api', 'https://mempool.space/api'],
    })
    expect(status).toEqual({ state: 'verified', height: 358391, time: 1432827678, sources: ['blockstream.info', 'mempool.space'] })
  })

  it('bad-stamp : racine de Merkle différente → invalide', async () => {
    const ots = parseOts(fixture('bad-stamp.txt.ots'))
    const { impl } = fakeFetch(esplora())
    const status = await verifyProof(ots, sha256(fixture('bad-stamp.txt')), { fetchImpl: impl, explorers: ['https://blockstream.info/api'] })
    expect(status.state).toBe('invalid')
  })

  it('un explorateur menteur suffit à refuser (désaccord)', async () => {
    const ots = parseOts(fixture('hello-world.txt.ots'))
    let n = 0
    const { impl } = fakeFetch((url, init) => esplora((h) => (url.includes('mempool') && n++ >= 0 ? '00'.repeat(32) : BLOCKS[h].merkle_root))(url, init))
    const status = await verifyProof(ots, sha256(fixture('hello-world.txt')), {
      fetchImpl: impl,
      explorers: ['https://blockstream.info/api', 'https://mempool.space/api'],
    })
    expect(status.state).toBe('invalid')
  })

  it('explorateurs injoignables → « invérifiable », pas « valide »', async () => {
    const ots = parseOts(fixture('hello-world.txt.ots'))
    const { impl } = fakeFetch(() => {
      throw new TypeError('réseau')
    })
    const status = await verifyProof(ots, sha256(fixture('hello-world.txt')), { fetchImpl: impl, explorers: ['https://blockstream.info/api'] })
    expect(status).toEqual({ state: 'unverifiable', height: 358391, reason: 'explorateurs Bitcoin injoignables' })
  })

  it('preuve d’un autre fichier → invalide', async () => {
    const ots = parseOts(fixture('hello-world.txt.ots'))
    const status = await verifyProof(ots, sha256(new TextEncoder().encode('autre')), { fetchImpl: fakeFetch(esplora()).impl })
    expect(status).toEqual({ state: 'invalid', reason: 'la preuve porte sur un autre fichier' })
  })
})

describe('upgradeProof — réponse réelle du calendrier alice', () => {
  it('complète incomplete.txt.ots puis la vérifie au bloc 428648', async () => {
    const ots = parseOts(fixture('incomplete.txt.ots'))
    expect(await verifyProof(ots, sha256(fixture('incomplete.txt')), { fetchImpl: fakeFetch(esplora()).impl })).toMatchObject({ state: 'pending' })
    const { impl, calls } = fakeFetch((url) =>
      url === `${ALICE}/timestamp/${INCOMPLETE_COMMITMENT}` ? new Response(hexToBytes(ALICE_UPGRADE_HEX)) : new Response('', { status: 404 }),
    )
    expect(await upgradeProof(ots, { fetchImpl: impl, calendars: [ALICE] })).toBe(true)
    expect(calls).toEqual([`${ALICE}/timestamp/${INCOMPLETE_COMMITMENT}`])
    const status = await verifyProof(ots, sha256(fixture('incomplete.txt')), {
      fetchImpl: fakeFetch(esplora()).impl,
      explorers: ['https://blockstream.info/api', 'https://mempool.space/api'],
    })
    expect(status).toEqual({ state: 'verified', height: 428648, time: 1473227803, sources: ['blockstream.info', 'mempool.space'] })
    // la preuve complétée se réécrit et se relit (fichier .ots téléchargeable)
    expect(bytesToHex(serializeOts(parseOts(serializeOts(ots))))).toBe(bytesToHex(serializeOts(ots)))
  })

  it('ne contacte jamais un calendrier hors liste blanche (traceur d’IP)', async () => {
    const ots = parseOts(fixture('incomplete.txt.ots'))
    const { impl, calls } = fakeFetch(() => new Response('', { status: 404 }))
    expect(await upgradeProof(ots, { fetchImpl: impl, calendars: ['https://bob.btc.calendar.opentimestamps.org'] })).toBe(false)
    expect(calls).toEqual([])
  })
})

describe('stampDigest', () => {
  it('soumet sha256(empreinte ‖ nonce) — jamais l’empreinte — et fusionne les réponses', async () => {
    const digest = sha256(new TextEncoder().encode('vidéo'))
    const bodies: Uint8Array[] = []
    const pendingFor = (uri: string) => {
      const u = new TextEncoder().encode(uri)
      return new Uint8Array([0x00, ...hexToBytes('83dfe30d2ef90c8e'), u.length + 1, u.length, ...u])
    }
    const { impl } = fakeFetch((url, init) => {
      bodies.push(new Uint8Array(init!.body as ArrayBuffer))
      expect((init!.headers as Record<string, string>)['Content-Type']).toBe('application/x-www-form-urlencoded')
      return url.startsWith('https://down') ? new Response('', { status: 503 }) : new Response(pendingFor(url.replace('/digest', '')))
    })
    const res = await stampDigest(digest, { fetchImpl: impl, calendars: ['https://a.example', 'https://b.example', 'https://down.example'] })
    expect(res.calendars.map((c) => c.ok)).toEqual([true, true, false])
    expect(bodies[0]).toHaveLength(32)
    expect(bytesToHex(bodies[0])).not.toBe(bytesToHex(digest))
    const uris = attestationsOf(res.file!.timestamp).map((a) => (a.attestation.kind === 'pending' ? a.attestation.uri : ''))
    expect(uris.sort()).toEqual(['https://a.example', 'https://b.example'])
    expect(res.file!.timestamp.msg).toEqual(digest)
  })

  it('aucun calendrier → pas de preuve, sans exception', async () => {
    const { impl } = fakeFetch(() => new Response('', { status: 500 }))
    const res = await stampDigest(new Uint8Array(32), { fetchImpl: impl, calendars: ['https://a.example'] })
    expect(res.file).toBeNull()
  })
})
