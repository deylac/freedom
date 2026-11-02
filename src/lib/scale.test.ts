import { describe, expect, it } from 'vitest'
import { DEFAULT_RELAYS } from '../config'
import { READ_RELAYS, sampleRelays } from './nostr/pool'
import { AUTO_PRESERVE_RATE, autoPreserveDelayMs, ENOUGH_COPIES, mayAutoPreserve } from './preserve'

describe('montée en charge : lecture répartie sur les relais', () => {
  it('chaque visiteur lit 6 relais sur 16, toujours les mêmes pendant sa visite', () => {
    const a = sampleRelays(DEFAULT_RELAYS, READ_RELAYS, 42)
    expect(a).toHaveLength(READ_RELAYS)
    expect(sampleRelays(DEFAULT_RELAYS, READ_RELAYS, 42)).toEqual(a)
    expect(new Set(a).size).toBe(READ_RELAYS)
  })

  it('10 000 visiteurs : charge répartie à peu près également (aucun relais > 1,3 × la moyenne)', () => {
    const count = new Map<string, number>()
    for (let seed = 1; seed <= 10_000; seed++) for (const r of sampleRelays(DEFAULT_RELAYS, READ_RELAYS, seed * 2654435761)) count.set(r, (count.get(r) ?? 0) + 1)
    const mean = (10_000 * READ_RELAYS) / DEFAULT_RELAYS.length
    expect(count.size).toBe(DEFAULT_RELAYS.length)
    for (const n of count.values()) expect(n).toBeLessThan(mean * 1.3)
  })

  it('liste personnalisée courte : tous les relais sont lus', () => {
    expect(sampleRelays(['wss://a.example', 'wss://b.example'], READ_RELAYS, 7)).toHaveLength(2)
  })
})

describe('montée en charge : préservation automatique', () => {
  const sha = 'b'.repeat(64)
  it('un spectateur sur 20 environ participe', () => {
    expect(mayAutoPreserve(sha, 1_000_000, 0, AUTO_PRESERVE_RATE + 0.01)).toBe(false)
    expect(mayAutoPreserve(sha, 2_000_000, 0, 0)).toBe(true)
  })

  it('plus de copie quand la vidéo est déjà sur assez de serveurs', () => {
    expect(mayAutoPreserve('c'.repeat(64), 3_000_000, ENOUGH_COPIES, 0)).toBe(false)
  })

  it('délai étalé entre 5 et 60 s', () => {
    expect(autoPreserveDelayMs(0)).toBe(5_000)
    expect(autoPreserveDelayMs(1)).toBe(60_000)
  })
})

describe('montée en charge : répartition des téléchargements vidéo', async () => {
  const { spreadSources } = await import('../components/ResilientVideo')
  it('chaque visiteur commence par une copie différente, toutes restent essayées', () => {
    const declared = ['https://a/x.mp4', 'https://b/x.mp4', 'https://c/x.mp4']
    const firsts = new Map<string, number>()
    for (let seed = 1; seed <= 3000; seed++) {
      const order = spreadSources(declared, seed)
      expect([...order].sort()).toEqual([...declared].sort())
      firsts.set(order[0], (firsts.get(order[0]) ?? 0) + 1)
    }
    for (const n of firsts.values()) expect(n).toBe(1000)
  })
})
