import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'
import { minePow } from 'nostr-tools/nip13'
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
    const s = new WallStore('mur', { ...emptyContext(), threshold: 2, powBits: 0 })
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
    const s = new WallStore('mur', { ...emptyContext(), threshold: 2, powBits: 0 })
    const ev = video(alice, 1)
    s.ingest(ev)
    const clip = parseVideoEvent(ev)!
    s.ingest(finalizeEvent(buildReportEvent(clip, 'spam', '', []), alice))
    s.ingest(finalizeEvent(buildReportEvent(clip, 'spam', '', []), bob))
    s.ingest(finalizeEvent({ ...buildReportEvent(clip, 'spam', 'encore', []), created_at: nowSeconds() + 1 }, bob))
    expect(s.getSnapshot().items[0].verdict.status).toBe('visible')
  })

  describe('signalements vérifiés (anti-Sybil)', () => {
    const report = (clip: ReturnType<typeof parseVideoEvent>, sk: Uint8Array, bits: number) => {
      const t = buildReportEvent(clip!, 'spam', '', [])
      const mined = bits ? minePow({ ...t, pubkey: getPublicKey(sk) }, bits) : t
      return finalizeEvent({ kind: mined.kind, created_at: mined.created_at, content: mined.content, tags: mined.tags }, sk)
    }
    const setup = (extra = {}) => {
      const s = new WallStore('mur', { ...emptyContext(), threshold: 3, powBits: 8, ...extra })
      const ev = video(alice, 1)
      s.ingest(ev)
      return { s, clip: parseVideoEvent(ev) }
    }

    it('3 signalements de clés jetables sans preuve de travail : la vidéo reste visible', () => {
      const { s, clip } = setup()
      for (let i = 0; i < 3; i++) s.ingest(report(clip, generateSecretKey(), 0))
      const v = s.getSnapshot().items[0].verdict
      expect(v.status).toBe('visible')
      expect(v.status !== 'hidden' && v.unverified).toBe(3)
    })

    it('3 signalements avec preuve de travail suffisante : floutée', () => {
      const { s, clip } = setup()
      for (let i = 0; i < 3; i++) s.ingest(report(clip, generateSecretKey(), 8))
      expect(s.getSnapshot().items[0].verdict.status).toBe('warn')
    })

    it('un contact d’un modérateur compte sans preuve de travail', () => {
      const moderator = generateSecretKey()
      const friend = generateSecretKey()
      const { s, clip } = setup({ moderators: new Set([getPublicKey(moderator)]) })
      s.ingest(finalizeEvent({ kind: 3, created_at: nowSeconds(), content: '', tags: [['p', getPublicKey(friend)]] }, moderator))
      s.ingest(report(clip, friend, 0))
      s.ingest(report(clip, generateSecretKey(), 8))
      s.ingest(report(clip, generateSecretKey(), 8))
      expect(s.getSnapshot().items[0].verdict.status).toBe('warn')
    })

    it('une liste de contacts d’une clé non modératrice est ignorée', () => {
      const impostor = generateSecretKey()
      const friend = generateSecretKey()
      const { s, clip } = setup()
      s.ingest(finalizeEvent({ kind: 3, created_at: nowSeconds(), content: '', tags: [['p', getPublicKey(friend)]] }, impostor))
      s.ingest(report(clip, friend, 0))
      expect(s.getSnapshot().items[0].verdict.status).toBe('visible')
    })
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

  it('audit F02 : un doublon antidaté par une autre clé n’évince pas l’original', () => {
    const s = new WallStore('mur', emptyContext())
    s.ingest(video(alice, 1, { sha: hex(43), createdAt: 1000 }))
    s.ingest(video(bob, 2, { sha: hex(43), createdAt: 2000, publishedAt: 1 }))
    const items = s.getSnapshot().items
    expect(items).toHaveLength(1)
    expect(items[0].clip.pubkey).toBe(getPublicKey(alice))
    // Les autres provenances signées restent accessibles.
    expect(items[0].alsoBy.map((c) => c.pubkey)).toEqual([getPublicKey(bob)])
  })

  it('audit F02 : masquer l’auteur d’un doublon ne fait pas disparaître l’original (modération avant regroupement)', () => {
    const muted = { ...emptyMuteList(), pubkeys: new Set([getPublicKey(bob)]) }
    const s = new WallStore('mur', { ...emptyContext(), localMutes: muted })
    s.ingest(video(alice, 1, { sha: hex(44), createdAt: 1000 }))
    // Doublon entièrement antidaté (created_at compris) : il passerait devant sans la règle.
    s.ingest(video(bob, 2, { sha: hex(44), createdAt: 1, publishedAt: 1 }))
    const items = s.getSnapshot().items
    expect(items.map((i) => i.clip.pubkey)).toEqual([getPublicKey(alice)])
    expect(items[0].alsoBy).toEqual([])
  })

  it('audit F02 : un modérateur ou une clé de confiance est préféré, le doublon signalé passe après', () => {
    const mod = generateSecretKey()
    const s = new WallStore('mur', { ...emptyContext(), moderators: new Set([getPublicKey(mod)]) })
    s.ingest(video(bob, 1, { sha: hex(45), createdAt: 1 }))
    s.ingest(video(mod, 2, { sha: hex(45), createdAt: 5000 }))
    expect(s.getSnapshot().items[0].clip.pubkey).toBe(getPublicKey(mod))
  })

  it('audit F08 : un événement malformé entre deux valides ne bloque pas le traitement', () => {
    const s = new WallStore('mur', emptyContext())
    s.ingest(video(alice, 1))
    const bad = { ...video(bob, 2), tags: [['t', 'mur'], ['d', 'x'], ['imeta', 'constructor boum', '__proto__ boum'], null] } as never
    s.ingest(bad)
    s.ingest({ kind: 1984, tags: null } as never)
    s.ingest(video(alice, 3))
    expect(s.getSnapshot().items.map((i) => i.clip.title)).toEqual(['clip 3', 'clip 1'])
    expect(s.rejected).toBeGreaterThan(0)
  })

  it('audit F09 : retirer un modérateur retire immédiatement ses listes et ses suivis', () => {
    const mod = generateSecretKey()
    const ctx = { ...emptyContext(), moderators: new Set([getPublicKey(mod)]) }
    const s = new WallStore('mur', ctx)
    s.ingest(video(alice, 1))
    s.ingest(video(bob, 2))
    s.ingest(finalizeEvent({ kind: 10000, created_at: nowSeconds(), content: '', tags: [['p', getPublicKey(alice)]] }, mod))
    expect(s.getSnapshot().items.map((i) => i.clip.pubkey)).toEqual([getPublicKey(bob)])
    // Son suivi rendait bob « de confiance » pour les signalements.
    s.ingest(finalizeEvent({ kind: 3, created_at: nowSeconds(), content: '', tags: [['p', getPublicKey(bob)]] }, mod))
    expect(s.trustedKeys().has(getPublicKey(bob))).toBe(true)

    s.setContext({ ...ctx, moderators: new Set() })
    expect(s.getSnapshot().items.map((i) => i.clip.pubkey).sort()).toEqual([getPublicKey(alice), getPublicKey(bob)].sort())
    expect(s.trustedKeys().has(getPublicKey(bob))).toBe(false)
  })

  it('audit F09 : les masquages locaux et ceux d’un autre modérateur restent appliqués', () => {
    const m1 = generateSecretKey()
    const m2 = generateSecretKey()
    const ctx = { ...emptyContext(), moderators: new Set([getPublicKey(m1), getPublicKey(m2)]), localMutes: { ...emptyMuteList(), words: ['interdit'] } }
    const s = new WallStore('mur', ctx)
    s.ingest(video(alice, 1))
    s.ingest(video(bob, 2, { title: 'mot interdit' }))
    const carol = generateSecretKey()
    s.ingest(video(carol, 3))
    s.ingest(finalizeEvent({ kind: 10000, created_at: nowSeconds(), content: '', tags: [['p', getPublicKey(alice)]] }, m1))
    s.ingest(finalizeEvent({ kind: 10000, created_at: nowSeconds(), content: '', tags: [['p', getPublicKey(carol)]] }, m2))
    s.setContext({ ...ctx, moderators: new Set([getPublicKey(m2)]) })
    expect(s.getSnapshot().items.map((i) => i.clip.pubkey)).toEqual([getPublicKey(alice)])
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
