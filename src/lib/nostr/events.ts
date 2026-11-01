/**
 * FR-05 / FR-07 — Contrats de données Nostr.
 *
 *  - kind 34236 : vidéo courte adressable (NIP-71) avec tag `imeta` (NIP-92)
 *  - kind 22    : vidéo courte non modifiable (lecture seule, interopérabilité)
 *  - kind 10063 : liste de serveurs Blossom de l'auteur (BUD-03)
 *  - kind 1984  : signalement (NIP-56) — réutilisé tel quel pour PUT /report (BUD-09)
 *  - kind 5     : demande de suppression (NIP-09)
 */
import * as nip19 from 'nostr-tools/nip19'
import type { EventTemplate, NostrEvent } from 'nostr-tools/pure'
import { MAX_DECLARED_DURATION_S } from '../../config'
import { isAllowedMediaUrl } from '../blossom/urls'

export const KIND_SHORT_VIDEO = 34236
export const KIND_LEGACY_SHORT_VIDEO = 22
export const KIND_SERVER_LIST = 10063
export const KIND_REPORT = 1984
export const KIND_DELETION = 5
export const KIND_MUTE_LIST = 10000

const HEX64 = /^[0-9a-f]{64}$/

export const nowSeconds = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// imeta (NIP-92)

export type ImetaFields = Record<string, string[]>

/** Analyse un tag imeta : chaque entrée est « clé valeur », la valeur pouvant contenir des espaces. */
export function parseImeta(tag: string[]): ImetaFields {
  const fields: ImetaFields = {}
  for (const entry of tag.slice(1)) {
    if (typeof entry !== 'string') continue
    const i = entry.indexOf(' ')
    if (i <= 0) continue
    const key = entry.slice(0, i)
    const value = entry.slice(i + 1).trim()
    if (!value) continue
    ;(fields[key] ??= []).push(value)
  }
  return fields
}

export function buildImeta(entries: Array<[string, string | number | undefined]>): string[] {
  const tag = ['imeta']
  for (const [k, v] of entries) {
    if (v === undefined || v === '') continue
    tag.push(`${k} ${v}`)
  }
  return tag
}

export interface VideoVariant {
  url: string
  sha256?: string
  mime?: string
  width?: number
  height?: number
  duration?: number
  bitrate?: number
  size?: number
  images: string[]
  fallbacks: string[]
  alt?: string
  /** Preuve OpenTimestamps (.ots en base64) de l'empreinte `sha256` du fichier. */
  ots?: string
}

const OTS_B64 = /^[A-Za-z0-9+/]{40,16000}={0,2}$/

function parseDim(value?: string): { width?: number; height?: number } {
  const m = value?.match(/^(\d{1,5})x(\d{1,5})$/)
  return m ? { width: Number(m[1]), height: Number(m[2]) } : {}
}

function parseNumber(value?: string): number | undefined {
  if (value === undefined) return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

export function variantFromImeta(fields: ImetaFields): VideoVariant | null {
  const url = fields.url?.[0]
  if (!url || !isAllowedMediaUrl(url)) return null
  const x = fields.x?.[0]?.toLowerCase()
  return {
    url,
    sha256: x && HEX64.test(x) ? x : undefined,
    mime: fields.m?.[0]?.toLowerCase(),
    ...parseDim(fields.dim?.[0]),
    duration: parseNumber(fields.duration?.[0]),
    bitrate: parseNumber(fields.bitrate?.[0]),
    size: parseNumber(fields.size?.[0]),
    images: (fields.image ?? []).filter(isAllowedMediaUrl),
    fallbacks: (fields.fallback ?? []).filter(isAllowedMediaUrl),
    alt: fields.alt?.[0],
    ots: fields.ots?.[0] && OTS_B64.test(fields.ots[0]) ? fields.ots[0] : undefined,
  }
}

// ---------------------------------------------------------------------------
// Construction de l'événement vidéo (kind 34236)

export interface VideoEventInput {
  /** Identifiant stable : DOIT rester identique entre versions d'une même vidéo. */
  d: string
  hashtag: string
  title: string
  content: string
  alt: string
  publishedAt: number
  createdAt?: number
  contentWarning?: string
  video: {
    url: string
    sha256: string
    mime: string
    width: number
    height: number
    duration: number
    bitrate: number
    size: number
    images: string[]
    fallbacks: string[]
    ots?: string
  }
}

export function buildVideoEvent(input: VideoEventInput): EventTemplate {
  const { video } = input
  if (!input.d) throw new Error('Tag d obligatoire pour un événement adressable')
  if (!HEX64.test(video.sha256)) throw new Error('Empreinte SHA-256 invalide')
  const duration = video.duration.toFixed(2)
  const tags: string[][] = [
    ['d', input.d],
    ['title', input.title],
    ['published_at', String(input.publishedAt)],
    ['alt', input.alt],
    buildImeta([
      ['url', video.url],
      ['m', video.mime],
      ['x', video.sha256],
      ['dim', `${video.width}x${video.height}`],
      ['duration', duration],
      ['bitrate', Math.round(video.bitrate)],
      ['size', video.size],
      ...video.images.map((u): [string, string] => ['image', u]),
      ...video.fallbacks.map((u): [string, string] => ['fallback', u]),
      ['ots', video.ots],
    ]),
    ['duration', duration],
    ['t', input.hashtag],
  ]
  if (input.contentWarning !== undefined) tags.push(['content-warning', input.contentWarning])
  return {
    kind: KIND_SHORT_VIDEO,
    created_at: input.createdAt ?? nowSeconds(),
    content: input.content,
    tags,
  }
}

/** Identifiant d stable dérivé du contenu : un nouvel essai ne crée jamais de doublon. */
export const clipIdentifier = (sha256: string): string => `hw-${sha256.slice(0, 16)}`

export const addressOf = (kind: number, pubkey: string, d: string): string => `${kind}:${pubkey}:${d}`

// ---------------------------------------------------------------------------
// Analyse d'un événement vidéo reçu → modèle Clip

export interface Clip {
  /** Adresse `kind:pubkey:d` (adressable) ou id (kind 22). */
  key: string
  event: NostrEvent
  id: string
  pubkey: string
  kind: number
  d?: string
  createdAt: number
  publishedAt: number
  title: string
  content: string
  alt?: string
  hashtags: string[]
  variants: VideoVariant[]
  /** Variante retenue pour la lecture. */
  video: VideoVariant
  duration?: number
  contentWarning?: string
}

const tagValue = (event: NostrEvent, name: string): string | undefined =>
  event.tags.find((t) => t[0] === name)?.[1]

export type CanPlay = (mime: string) => boolean

/** Choisit la variante lisible : formats vidéo supportés, MP4 de préférence (iOS). */
export function pickVariant(variants: VideoVariant[], canPlay: CanPlay): VideoVariant | undefined {
  const video = variants.filter((v) => !v.mime || v.mime.startsWith('video/'))
  const playable = video.filter((v) => !v.mime || canPlay(v.mime))
  const rank = (v: VideoVariant) => (v.mime === 'video/mp4' ? 0 : v.mime ? 1 : 2)
  return [...playable].sort((a, b) => rank(a) - rank(b))[0] ?? video[0]
}

export interface ParseOptions {
  canPlay?: CanPlay
  now?: number
}

export function parseVideoEvent(event: NostrEvent, opts: ParseOptions = {}): Clip | null {
  if (event.kind !== KIND_SHORT_VIDEO && event.kind !== KIND_LEGACY_SHORT_VIDEO) return null
  const now = opts.now ?? nowSeconds()
  // Les dates futures servent à épingler du spam en haut du mur.
  if (event.created_at > now + 600) return null

  const d = tagValue(event, 'd')
  if (event.kind === KIND_SHORT_VIDEO && !d) return null

  const variants = event.tags
    .filter((t) => t[0] === 'imeta')
    .map((t) => variantFromImeta(parseImeta(t)))
    .filter((v): v is VideoVariant => v !== null)
  // Ancien format NIP-71 sans imeta : tag url direct.
  if (variants.length === 0) {
    const url = tagValue(event, 'url')
    if (url && isAllowedMediaUrl(url)) {
      const x = tagValue(event, 'x')
      variants.push({
        url,
        mime: tagValue(event, 'm'),
        sha256: x && HEX64.test(x) ? x : undefined,
        images: [tagValue(event, 'thumb'), tagValue(event, 'image')].filter(
          (u): u is string => !!u && isAllowedMediaUrl(u),
        ),
        fallbacks: [],
      })
    }
  }
  const video = pickVariant(variants, opts.canPlay ?? (() => true))
  if (!video) return null

  const durationTag = parseNumber(tagValue(event, 'duration'))
  const duration = video.duration ?? durationTag
  if (duration !== undefined && duration > MAX_DECLARED_DURATION_S) return null

  const publishedTag = Number.parseInt(tagValue(event, 'published_at') ?? '', 10)
  const publishedAt =
    Number.isFinite(publishedTag) && publishedTag > 0 ? Math.min(publishedTag, event.created_at) : event.created_at

  const cwTag = event.tags.find((t) => t[0] === 'content-warning')

  return {
    key: event.kind === KIND_SHORT_VIDEO ? addressOf(event.kind, event.pubkey, d!) : event.id,
    event,
    id: event.id,
    pubkey: event.pubkey,
    kind: event.kind,
    d,
    createdAt: event.created_at,
    publishedAt,
    title: tagValue(event, 'title') ?? '',
    content: event.content,
    alt: tagValue(event, 'alt'),
    hashtags: event.tags.filter((t) => t[0] === 't' && t[1]).map((t) => t[1].toLowerCase()),
    variants,
    video,
    duration,
    contentWarning: cwTag ? (cwTag[1] ?? '') : undefined,
  }
}

/** Règle NIP-01 de remplacement : created_at le plus récent, puis plus petit id. */
export function isNewerVersion(candidate: NostrEvent, existing: NostrEvent): boolean {
  if (candidate.created_at !== existing.created_at) return candidate.created_at > existing.created_at
  return candidate.id < existing.id
}

export function clipNaddr(clip: Clip, relays: string[] = []): string {
  if (clip.kind === KIND_SHORT_VIDEO && clip.d) {
    return nip19.naddrEncode({ kind: clip.kind, pubkey: clip.pubkey, identifier: clip.d, relays: relays.slice(0, 2) })
  }
  return nip19.neventEncode({ id: clip.id, author: clip.pubkey, kind: clip.kind, relays: relays.slice(0, 2) })
}

/** Décode un pointeur naddr/nevent en clé de Clip. */
export function clipKeyFromPointer(pointer: string): string | null {
  try {
    const decoded = nip19.decode(pointer)
    if (decoded.type === 'naddr') return addressOf(decoded.data.kind, decoded.data.pubkey, decoded.data.identifier)
    if (decoded.type === 'nevent') return decoded.data.id
  } catch {
    /* pointeur invalide */
  }
  return null
}

// ---------------------------------------------------------------------------
// BUD-03 — liste de serveurs

export function buildServerListEvent(servers: string[]): EventTemplate {
  return {
    kind: KIND_SERVER_LIST,
    created_at: nowSeconds(),
    content: '',
    tags: servers.map((s) => ['server', s]),
  }
}

// ---------------------------------------------------------------------------
// NIP-56 + BUD-09 — signalement

export type ReportReason = 'illegal' | 'spam' | 'nudity' | 'profanity' | 'other'

export function buildReportEvent(clip: Clip, reason: ReportReason, comment: string, servers: string[]): EventTemplate {
  const tags: string[][] = [
    // NIP-56 : `e` obligatoire dès qu'un `x` est présent.
    ['e', clip.id, reason],
    ['p', clip.pubkey, reason],
  ]
  if (clip.video.sha256) tags.push(['x', clip.video.sha256, reason])
  // L'événement adressable change d'id à chaque mise à jour : le tag `a` rattache le
  // signalement à la vidéo et non à une version particulière.
  if (clip.kind === KIND_SHORT_VIDEO) tags.push(['a', clip.key])
  for (const s of servers) tags.push(['server', s])
  tags.push(['k', String(clip.kind)])
  return { kind: KIND_REPORT, created_at: nowSeconds(), content: comment, tags }
}

// ---------------------------------------------------------------------------
// NIP-09 — suppression

export function buildDeletionEvent(targets: { ids?: string[]; addresses?: string[]; kind: number }): EventTemplate {
  const tags: string[][] = [
    ...(targets.ids ?? []).map((id) => ['e', id]),
    ...(targets.addresses ?? []).map((a) => ['a', a]),
    ['k', String(targets.kind)],
  ]
  return { kind: KIND_DELETION, created_at: nowSeconds(), content: 'Suppression demandée par l’auteur', tags }
}
