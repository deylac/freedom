import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { emptyMuteList } from './moderation/policy'
import { buildDeletionEvent, buildReportEvent, buildVideoEvent, clipIdentifier, nowSeconds, parseVideoEvent } from './nostr/events'
import { emptyContext, WallStore } from './wall-store'

const flush = () => new Promise((r) => setTimeout(r, 0))
const hex = (n: number) => bytesToHex(sha256(new TextEncoder().encode(String(n))))

function video(sk: Uint8Array, n: number, over: { createdAt?: number; publishedAt?: number; tag?: string; sha?: string; title?: string } = {}) {
  const sha = over.sha ?? hex(n)
  const t = over.createdAt ?? nowSeconds() - 100 + n
  return finalizeEvent(
    buildVideoEvent({
      d: clipIdentifier(sha),
      hashtag: over.tag ?? 'mur',
      title: over.title ?? `clip ${n}`,
      content: '',
      alt: '',
      publishedAt: over.publishedAt ?? t,
      createdAt: t,
      video: { url: `https://a.example/${sha}.mp4`, sha256: sha, mime: 'video/mp4', width: 720, height: 1280, duration: 10, bitrate: 1, size: 1, images: [], fallbacks: [] },
    }),
    sk,
  )
}

const alice = generateSecretKey()
const bob = generateSecretKey()

describe('WallStore', () => {
  it('trie par date de publication et ignore les autres hashtags', () => {
    const s = new WallStore('mur', emptyContext())
    s.ingest(video(alice, 1))
    s.ingest(video(alice, 2))
    s.ingest(video(alice, 3, { tag: 'autre' }))
    expect(s.getSnapshot().items.map((i) => i.clip.title)).toEqual(['clip 2', 'clip 1'])
  })

  it('remplace une vidéo adressable sans doublon et garde published_at', () => {
    const s = new WallStore('mur', emptyContext())
    const v1 = video(alice, 1, { createdAt: 1000, publishedAt: 1000 })
    const v2 = video(alice, 1, { createdAt: 1005, publishedAt: 1000, title: 'mis à jour' })
    s.ingest(v2)
    s.ingest(v1)
    const items = s.getSnapshot().items
    expect(items).toHaveLength(1)
    expect(items[0].clip.title).toBe('mis à jour')
    expect(items[0].clip.publishedAt).toBe(1000)
  })

  it('applique une suppression NIP-09 par adresse uniquement si elle vient de l’auteur', async () => {
    const s = new WallStore('mur', emptyContext())
    const ev = video(alice, 1)
    s.ingest(ev)
    const clip = parseVideoEvent(ev)!
    s.ingest(finalizeEvent(buildDeletionEvent({ addresses: [clip.key], kind: 34236 }), bob))
    expect(s.getSnapshot().items).toHaveLength(1)
    s.ingest(finalizeEvent(buildDeletionEvent({ addresses: [clip.key], kind: 34236 }), alice))
    await flush()
    expect(s.getSnapshot().items).toHaveLength(0)
  })

  it('valide une suppression par id reçue avant la vidéo', () => {
    const s = new WallStore('mur', emptyContext())
    const ev = video(alice, 1)
    s.ingest(finalizeEvent(buildDeletionEvent({ ids: [ev.id], kind: 34236 }), alice))
    s.ingest(ev)
    expect(s.getSnapshot().items).toHaveLength(0)
  })

  it('floute après N signalements de clés distinctes, quelle que soit la version signalée', () => {
    const s = new WallStore('mur', { ...emptyContext(), threshold: 2 })
    const v1 = video(alice, 1, { createdAt: 1000 })
    s.ingest(v1)
    const clipV1 = parseVideoEvent(v1)!
    // signalement sur la v1 (tag e), puis mise à jour de la vidéo
    s.ingest(finalizeEvent(buildReportEvent(clipV1, 'spam', '', []), bob))
    s.ingest(video(alice, 1, { createdAt: 1010, publishedAt: 1000 }))
    expect(s.getSnapshot().items[0].verdict.status).toBe('visible')
    // second signalement d'une autre clé, seulement par hash (BUD-09)
    const carol = generateSecretKey()
    s.ingest(finalizeEvent({ kind: 1984, created_at: nowSeconds(), content: '', tags: [['x', clipV1.video.sha256!, 'illegal'], ['e', 'f'.repeat(64)]] }, carol))
    const verdict = s.getSnapshot().items[0].verdict
    expect(verdict.status).toBe('warn')
  })

  it('ne compte pas l’auteur ni deux fois la même clé', () => {
    const s = new WallStore('mur', { ...emptyContext(), threshold: 2 })
    const ev = video(alice, 1)
    s.ingest(ev)
    const clip = parseVideoEvent(ev)!
    s.ingest(finalizeEvent(buildReportEvent(clip, 'spam', '', []), alice))
    s.ingest(finalizeEvent(buildReportEvent(clip, 'spam', '', []), bob))
    s.ingest(finalizeEvent({ ...buildReportEvent(clip, 'spam', 'encore', []), created_at: nowSeconds() + 1 }, bob))
    expect(s.getSnapshot().items[0].verdict.status).toBe('visible')
  })

  it('un signalement de modérateur suffit', () => {
    const s = new WallStore('mur', { ...emptyContext(), moderators: new Set([getPublicKey(bob)]) })
    const ev = video(alice, 1)
    s.ingest(ev)
    s.ingest(finalizeEvent(buildReportEvent(parseVideoEvent(ev)!, 'illegal', '', []), bob))
    expect(s.getSnapshot().items[0].verdict.status).toBe('warn')
  })

  it('applique les listes kind 10000 des modérateurs seulement', () => {
    const s = new WallStore('mur', { ...emptyContext(), moderators: new Set([getPublicKey(bob)]) })
    s.ingest(video(alice, 1))
    const carol = generateSecretKey()
    s.ingest(finalizeEvent({ kind: 10000, created_at: nowSeconds(), content: '', tags: [['p', getPublicKey(alice)]] }, carol))
    expect(s.getSnapshot().items).toHaveLength(1)
    s.ingest(finalizeEvent({ kind: 10000, created_at: nowSeconds(), content: '', tags: [['p', getPublicKey(alice)]] }, bob))
    expect(s.getSnapshot().items).toHaveLength(0)
  })

  it('masque localement et applique les mots masqués', () => {
    const ev = video(alice, 1, { title: 'Arnaque crypto' })
    const clip = parseVideoEvent(ev)!
    const hidden = new WallStore('mur', { ...emptyContext(), hiddenKeys: new Set([clip.key]) })
    hidden.ingest(ev)
    expect(hidden.getSnapshot().items).toHaveLength(0)
    const words = new WallStore('mur', { ...emptyContext(), localMutes: { ...emptyMuteList(), words: ['arnaque'] } })
    words.ingest(ev)
    expect(words.getSnapshot().items).toHaveLength(0)
  })

  it('dédoublonne un même fichier republié par une autre clé', () => {
    const s = new WallStore('mur', emptyContext())
    s.ingest(video(alice, 1, { sha: hex(42), createdAt: 1000 }))
    s.ingest(video(bob, 2, { sha: hex(42), createdAt: 2000 }))
    const items = s.getSnapshot().items
    expect(items).toHaveLength(1)
    expect(items[0].clip.pubkey).toBe(getPublicKey(alice))
  })

  it('plafonne le nombre de clips par auteur (anti-inondation)', () => {
    const s = new WallStore('mur', emptyContext())
    for (let i = 1; i <= 30; i++) s.ingest(video(alice, i))
    expect(s.getSnapshot().items).toHaveLength(12)
  })

  it('notifie les abonnés une seule fois par rafale', async () => {
    const s = new WallStore('mur', emptyContext())
    let calls = 0
    s.subscribe(() => calls++)
    for (let i = 1; i <= 20; i++) s.ingest(video(alice, i))
    await flush()
    expect(calls).toBe(1)
  })
})
