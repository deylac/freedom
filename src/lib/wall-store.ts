/**
 * État d'un mur : agrège vidéos, suppressions, signalements, listes de serveurs et de masquage.
 * Indépendant de React (testable) ; exposé via useSyncExternalStore.
 */
import type { NostrEvent } from 'nostr-tools/pure'
import { MAX_CLIPS_PER_AUTHOR } from '../config'
import {
  isNewerVersion,
  KIND_DELETION,
  KIND_LEGACY_SHORT_VIDEO,
  KIND_MUTE_LIST,
  KIND_REPORT,
  KIND_SERVER_LIST,
  KIND_SHORT_VIDEO,
  parseVideoEvent,
  type CanPlay,
  type Clip,
  type ReportReason,
} from './nostr/events'
import {
  emptyMuteList,
  evaluateClip,
  mergeMuteLists,
  parseMuteList,
  reportTargets,
  type ModerationContext,
  type MuteList,
  type Verdict,
} from './moderation/policy'

export interface WallItem {
  clip: Clip
  verdict: Verdict
}

export interface WallSnapshot {
  items: WallItem[]
  /** Clés de tous les clips connus (pour cibler l'abonnement d'annotations). */
  loading: boolean
  version: number
}

export interface StoreContext {
  hiddenKeys: Set<string>
  localMutes: MuteList
  moderators: Set<string>
  threshold: number
  /** Clé de l'identité courante : ses propres listes kind 10000 s'appliquent aussi. */
  self?: string
}

type Listener = () => void

export class WallStore {
  private clips = new Map<string, Clip>()
  private idToKey = new Map<string, string>()
  private keyToIds = new Map<string, Set<string>>()
  private deletedIds = new Set<string>()
  private pendingIdDeletions = new Map<string, Set<string>>()
  private addressDeletions = new Map<string, number>()
  private reports = new Map<string, Map<string, ReportReason>>()
  private serverLists = new Map<string, { at: number; servers: string[] }>()
  private muteLists = new Map<string, { at: number; list: MuteList }>()
  private listeners = new Set<Listener>()
  private version = 0
  private snapshot: WallSnapshot = { items: [], loading: true, version: 0 }
  private dirty = true
  private loading = true
  private notifyScheduled = false

  constructor(
    readonly tag: string,
    private context: StoreContext,
    private readonly canPlay: CanPlay = () => true,
  ) {}

  // ----- abonnement React -------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): WallSnapshot => {
    if (this.dirty) {
      this.snapshot = { items: this.computeItems(), loading: this.loading, version: this.version }
      this.dirty = false
    }
    return this.snapshot
  }

  private changed() {
    this.version++
    this.dirty = true
    if (this.notifyScheduled) return
    this.notifyScheduled = true
    // Regroupe les rafales d'événements (historique) en un seul rendu.
    queueMicrotask(() => {
      this.notifyScheduled = false
      this.listeners.forEach((l) => l())
    })
  }

  setLoading(loading: boolean) {
    if (this.loading === loading) return
    this.loading = loading
    this.changed()
  }

  setContext(context: StoreContext) {
    this.context = context
    this.changed()
  }

  // ----- ingestion --------------------------------------------------------

  ingest(event: NostrEvent): void {
    switch (event.kind) {
      case KIND_SHORT_VIDEO:
      case KIND_LEGACY_SHORT_VIDEO:
        return this.ingestVideo(event)
      case KIND_DELETION:
        return this.ingestDeletion(event)
      case KIND_REPORT:
        return this.ingestReport(event)
      case KIND_SERVER_LIST:
        return this.ingestServerList(event)
      case KIND_MUTE_LIST:
        return this.ingestMuteList(event)
    }
  }

  private ingestVideo(event: NostrEvent) {
    if (this.idToKey.has(event.id)) return
    // Les relais filtrent par #t, mais on revérifie : un relais peut être laxiste ou malveillant.
    if (!event.tags.some((t) => t[0] === 't' && t[1]?.toLowerCase() === this.tag)) return
    const clip = parseVideoEvent(event, { canPlay: this.canPlay })
    if (!clip) return
    this.idToKey.set(event.id, clip.key)
    const ids = this.keyToIds.get(clip.key) ?? new Set<string>()
    ids.add(event.id)
    this.keyToIds.set(clip.key, ids)
    const pending = this.pendingIdDeletions.get(event.id)
    if (pending?.has(event.pubkey)) this.deletedIds.add(event.id)
    const existing = this.clips.get(clip.key)
    if (existing && !isNewerVersion(event, existing.event)) return
    // Une mise à jour garde la date de première publication la plus ancienne connue.
    if (existing) clip.publishedAt = Math.min(clip.publishedAt, existing.publishedAt)
    this.clips.set(clip.key, clip)
    this.changed()
  }

  private ingestDeletion(event: NostrEvent) {
    let touched = false
    for (const [name, value] of event.tags) {
      if (name === 'a' && value) {
        // NIP-09 : seule l'autrice ou l'auteur peut supprimer son adresse.
        const [, pubkey] = value.split(':')
        if (pubkey !== event.pubkey) continue
        const prev = this.addressDeletions.get(value) ?? 0
        if (event.created_at > prev) {
          this.addressDeletions.set(value, event.created_at)
          touched = true
        }
      } else if (name === 'e' && value) {
        const key = this.idToKey.get(value)
        const clip = key ? this.clips.get(key) : undefined
        if (clip && clip.id === value) {
          if (clip.pubkey === event.pubkey) {
            this.deletedIds.add(value)
            touched = true
          }
        } else {
          // Suppression reçue avant l'événement visé : validée plus tard.
          const set = this.pendingIdDeletions.get(value) ?? new Set()
          set.add(event.pubkey)
          this.pendingIdDeletions.set(value, set)
        }
      }
    }
    if (touched) this.changed()
  }

  private ingestReport(event: NostrEvent) {
    const { targets, reason } = reportTargets(event)
    for (const target of targets) {
      const map = this.reports.get(target) ?? new Map<string, ReportReason>()
      map.set(event.pubkey, reason)
      this.reports.set(target, map)
    }
    if (targets.length) this.changed()
  }

  private ingestServerList(event: NostrEvent) {
    const prev = this.serverLists.get(event.pubkey)
    if (prev && prev.at >= event.created_at) return
    const servers = event.tags.filter((t) => t[0] === 'server' && t[1]).map((t) => t[1])
    this.serverLists.set(event.pubkey, { at: event.created_at, servers })
    this.changed()
  }

  private ingestMuteList(event: NostrEvent) {
    const allowed = this.context.moderators.has(event.pubkey) || event.pubkey === this.context.self
    if (!allowed) return
    const prev = this.muteLists.get(event.pubkey)
    if (prev && prev.at >= event.created_at) return
    this.muteLists.set(event.pubkey, { at: event.created_at, list: parseMuteList(event) })
    this.changed()
  }

  // ----- lecture ----------------------------------------------------------

  serversOf(pubkey: string): string[] {
    return this.serverLists.get(pubkey)?.servers ?? []
  }

  getClip(key: string): Clip | undefined {
    return this.clips.get(key) ?? this.clips.get(this.idToKey.get(key) ?? '')
  }

  /** Cibles pour l'abonnement d'annotations (signalements, suppressions, serveurs). */
  annotationTargets(limit = 150): { ids: string[]; addresses: string[]; hashes: string[]; pubkeys: string[] } {
    const clips = [...this.clips.values()].sort((a, b) => b.publishedAt - a.publishedAt).slice(0, limit)
    return {
      ids: clips.map((c) => c.id),
      addresses: clips.filter((c) => c.kind === KIND_SHORT_VIDEO).map((c) => c.key),
      hashes: [...new Set(clips.map((c) => c.video.sha256).filter((x): x is string => !!x))],
      pubkeys: [...new Set(clips.map((c) => c.pubkey))],
    }
  }

  reportersFor(clip: Clip): Map<string, ReportReason> {
    const out = new Map<string, ReportReason>()
    const keys = [`a:${clip.key}`, `x:${clip.video.sha256 ?? ''}`]
    this.keyToIds.get(clip.key)?.forEach((id) => keys.push(`e:${id}`))
    for (const k of keys) this.reports.get(k)?.forEach((reason, reporter) => out.set(reporter, reason))
    return out
  }

  private isDeleted(clip: Clip): boolean {
    if (this.deletedIds.has(clip.id)) return true
    const at = this.addressDeletions.get(clip.key)
    return at !== undefined && clip.createdAt <= at
  }

  private computeItems(): WallItem[] {
    const ctx: ModerationContext = {
      wallTag: this.tag,
      mutes: mergeMuteLists([this.context.localMutes, ...[...this.muteLists.values()].map((m) => m.list)]),
      hiddenKeys: this.context.hiddenKeys,
      moderators: this.context.moderators,
      threshold: this.context.threshold,
    }
    const live = [...this.clips.values()].filter((c) => !this.isDeleted(c))

    // Dédoublonnage par contenu : un même fichier republié par d'autres clés ne garde que l'original.
    const originals = new Map<string, Clip>()
    for (const c of live) {
      const sha = c.video.sha256
      if (!sha) continue
      const prev = originals.get(sha)
      if (!prev || c.publishedAt < prev.publishedAt) originals.set(sha, c)
    }
    const unique = live.filter((c) => !c.video.sha256 || originals.get(c.video.sha256) === c)

    unique.sort((a, b) => b.publishedAt - a.publishedAt || b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))

    const perAuthor = new Map<string, number>()
    const items: WallItem[] = []
    for (const clip of unique) {
      const n = (perAuthor.get(clip.pubkey) ?? 0) + 1
      perAuthor.set(clip.pubkey, n)
      if (n > MAX_CLIPS_PER_AUTHOR) continue
      const verdict = evaluateClip(clip, this.reportersFor(clip), ctx)
      if (verdict.status === 'hidden') continue
      items.push({ clip, verdict })
    }
    return items
  }
}

export const emptyContext = (): StoreContext => ({
  hiddenKeys: new Set(),
  localMutes: emptyMuteList(),
  moderators: new Set(),
  threshold: 3,
})
