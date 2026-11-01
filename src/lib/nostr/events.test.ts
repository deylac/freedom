import { finalizeEvent, generateSecretKey, getPublicKey, verifyEvent } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import {
  buildDeletionEvent,
  buildReportEvent,
  buildVideoEvent,
  clipIdentifier,
  clipKeyFromPointer,
  clipNaddr,
  isNewerVersion,
  parseImeta,
  parseVideoEvent,
  type VideoEventInput,
} from './events'

const SHA = 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553'
const sk = generateSecretKey()
const pk = getPublicKey(sk)

const input = (over: Partial<VideoEventInput> = {}): VideoEventInput => ({
  d: clipIdentifier(SHA),
  hashtag: '14octobre',
  title: '#14octobre - Clip citoyen',
  content: 'En direct sur place #14octobre',
  alt: 'Vidéo citoyenne de 58 secondes',
  publishedAt: 1762000005,
  createdAt: 1762000005,
  video: {
    url: `https://blossom.nostr.build/${SHA}.mp4`,
    sha256: SHA,
    mime: 'video/mp4',
    width: 720,
    height: 1280,
    duration: 58.4,
    bitrate: 2500000,
    size: 18_000_000,
    images: [`https://blossom.nostr.build/${'c'.repeat(64)}.jpg`],
    fallbacks: [`https://blosstr.com/${SHA}.mp4`],
  },
  ...over,
})

describe('buildVideoEvent (FR-05, contrat §6.3)', () => {
  const template = buildVideoEvent(input())

  it('produit un kind 34236 avec d, title, published_at, t, duration', () => {
    expect(template.kind).toBe(34236)
    const names = template.tags.map((t) => t[0])
    expect(names).toEqual(expect.arrayContaining(['d', 'title', 'published_at', 'alt', 'imeta', 'duration', 't']))
    expect(template.tags.find((t) => t[0] === 't')).toEqual(['t', '14octobre'])
    expect(template.tags.find((t) => t[0] === 'duration')).toEqual(['duration', '58.40'])
    expect(template.content).toBe('En direct sur place #14octobre')
  })

  it('imeta contient url avec extension, x, m, dim, duration, bitrate, image, fallback', () => {
    const imeta = parseImeta(template.tags.find((t) => t[0] === 'imeta')!)
    expect(imeta.url[0]).toMatch(/\.mp4$/)
    expect(imeta.x).toEqual([SHA])
    expect(imeta.m).toEqual(['video/mp4'])
    expect(imeta.dim).toEqual(['720x1280'])
    expect(imeta.duration).toEqual(['58.40'])
    expect(imeta.bitrate).toEqual(['2500000'])
    expect(imeta.image).toHaveLength(1)
    expect(imeta.fallback).toEqual([`https://blosstr.com/${SHA}.mp4`])
  })

  it('le tag d est stable pour un même fichier (idempotence des nouvelles tentatives)', () => {
    expect(clipIdentifier(SHA)).toBe(clipIdentifier(SHA))
    expect(clipIdentifier(SHA)).toMatch(/^hw-[0-9a-f]{16}$/)
  })

  it('refuse un d vide ou un hash invalide', () => {
    expect(() => buildVideoEvent(input({ d: '' }))).toThrow()
    expect(() => buildVideoEvent(input({ video: { ...input().video, sha256: 'xyz' } }))).toThrow()
  })

  it('ajoute content-warning seulement si demandé', () => {
    expect(template.tags.some((t) => t[0] === 'content-warning')).toBe(false)
    const cw = buildVideoEvent(input({ contentWarning: 'violence' }))
    expect(cw.tags.find((t) => t[0] === 'content-warning')).toEqual(['content-warning', 'violence'])
  })

  it('est signable et vérifiable', () => {
    expect(verifyEvent(finalizeEvent(template, sk))).toBe(true)
  })
})

describe('parseVideoEvent', () => {
  const signed = finalizeEvent(buildVideoEvent(input()), sk)
  const now = 1762000100

  it('analyse un événement HashWall', () => {
    const clip = parseVideoEvent(signed, { now })!
    expect(clip.key).toBe(`34236:${pk}:${clipIdentifier(SHA)}`)
    expect(clip.video.sha256).toBe(SHA)
    expect(clip.video.width).toBe(720)
    expect(clip.video.fallbacks).toHaveLength(1)
    expect(clip.duration).toBeCloseTo(58.4)
    expect(clip.hashtags).toEqual(['14octobre'])
  })

  it('rejette un 34236 sans d', () => {
    const ev = finalizeEvent({ ...buildVideoEvent(input()), tags: buildVideoEvent(input()).tags.filter((t) => t[0] !== 'd') }, sk)
    expect(parseVideoEvent(ev, { now })).toBeNull()
  })

  it('rejette une date future (épinglage de spam)', () => {
    const ev = finalizeEvent(buildVideoEvent(input({ createdAt: now + 3600 })), sk)
    expect(parseVideoEvent(ev, { now })).toBeNull()
  })

  it('rejette une vidéo déclarée > 61 s (hors format 60 s)', () => {
    const ev = finalizeEvent(buildVideoEvent(input({ video: { ...input().video, duration: 600 } })), sk)
    expect(parseVideoEvent(ev, { now })).toBeNull()
  })

  it('écarte les URLs non https (javascript:, http:)', () => {
    const ev = finalizeEvent(
      buildVideoEvent(input({ video: { ...input().video, url: 'javascript:alert(1)', fallbacks: ['http://evil.example/a.mp4'] } })),
      sk,
    )
    expect(parseVideoEvent(ev, { now })).toBeNull()
  })

  it('borne published_at à created_at', () => {
    const ev = finalizeEvent(buildVideoEvent(input({ publishedAt: 1762000999 })), sk)
    expect(parseVideoEvent(ev, { now })!.publishedAt).toBe(1762000005)
  })

  it('préfère la variante MP4 lisible', () => {
    const base = buildVideoEvent(input())
    const webm = ['imeta', `url https://a.example/${'d'.repeat(64)}.webm`, 'm video/webm', `x ${'d'.repeat(64)}`]
    const ev = finalizeEvent({ ...base, tags: [webm, ...base.tags] }, sk)
    expect(parseVideoEvent(ev, { now, canPlay: () => true })!.video.mime).toBe('video/mp4')
    expect(parseVideoEvent(ev, { now, canPlay: (m) => m === 'video/webm' })!.video.mime).toBe('video/webm')
  })

  it('lit un ancien kind 22', () => {
    const ev = finalizeEvent({ ...buildVideoEvent(input()), kind: 22 }, sk)
    const clip = parseVideoEvent(ev, { now })!
    expect(clip.key).toBe(ev.id)
  })
})

describe('remplacement des événements adressables (NIP-01)', () => {
  it('created_at le plus récent gagne, puis le plus petit id', () => {
    const a = { created_at: 10, id: 'b' } as never
    const b = { created_at: 11, id: 'c' } as never
    const c = { created_at: 10, id: 'a' } as never
    expect(isNewerVersion(b, a)).toBe(true)
    expect(isNewerVersion(a, b)).toBe(false)
    expect(isNewerVersion(c, a)).toBe(true)
  })
})

describe('pointeurs NIP-19', () => {
  it('naddr ↔ clé de clip', () => {
    const clip = parseVideoEvent(finalizeEvent(buildVideoEvent(input()), sk), { now: 1762000100 })!
    expect(clipKeyFromPointer(clipNaddr(clip, ['wss://nos.lol']))).toBe(clip.key)
  })
})

describe('buildReportEvent (NIP-56 + BUD-09)', () => {
  const clip = parseVideoEvent(finalizeEvent(buildVideoEvent(input()), sk), { now: 1762000100 })!
  const report = buildReportEvent(clip, 'illegal', '', ['https://blossom.nostr.build'])

  it('contient e, p, x avec le motif et le tag a', () => {
    expect(report.kind).toBe(1984)
    expect(report.tags).toContainEqual(['e', clip.id, 'illegal'])
    expect(report.tags).toContainEqual(['p', clip.pubkey, 'illegal'])
    expect(report.tags).toContainEqual(['x', SHA, 'illegal'])
    expect(report.tags).toContainEqual(['a', clip.key])
    expect(report.tags).toContainEqual(['server', 'https://blossom.nostr.build'])
  })
})

describe('buildDeletionEvent (NIP-09)', () => {
  it('cible adresse + id + kind', () => {
    const ev = buildDeletionEvent({ ids: ['ab'], addresses: ['34236:pk:d'], kind: 34236 })
    expect(ev.kind).toBe(5)
    expect(ev.tags).toEqual([
      ['e', 'ab'],
      ['a', '34236:pk:d'],
      ['k', '34236'],
    ])
  })
})
