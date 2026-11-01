/**
 * Données personnelles locales : vidéos publiées (pour pouvoir les supprimer), vidéos masquées,
 * auteurs masqués, liste de serveurs déjà publiée par identité.
 */
import { emptyMuteList, type MuteList } from '../moderation/policy'
import { readJSON, writeJSON } from './local'
import type { Diagnostic } from './outbox'

export interface MyClip {
  key: string
  kind: number
  d: string
  eventId: string
  pubkey: string
  /** Clé secrète hex : présente seulement si l'utilisateur garde la possibilité de supprimer. */
  sk?: string
  sha256: string
  posterSha256?: string
  servers: string[]
  tag: string
  publishedAt: number
  posterUrl?: string
  url: string
  /** Preuve OpenTimestamps publiée (base64). */
  ots?: string
}

type Listener = () => void
const listeners = new Set<Listener>()
let version = 0
const emit = () => {
  version++
  listeners.forEach((l) => l())
}

/** Compteur de version pour useSyncExternalStore. */
export const personalVersion = (): number => version

export function subscribePersonal(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// ----- mes vidéos ---------------------------------------------------------------

export const getMyClips = (): MyClip[] => readJSON<MyClip[]>('my-clips', [])

export function saveMyClip(clip: MyClip): void {
  const rest = getMyClips().filter((c) => c.key !== clip.key)
  writeJSON('my-clips', [clip, ...rest].slice(0, 200))
  emit()
}

export function removeMyClip(key: string): void {
  writeJSON(
    'my-clips',
    getMyClips().filter((c) => c.key !== key),
  )
  emit()
}

// ----- masquage local -----------------------------------------------------------

interface LocalModeration {
  hidden: string[]
  mutedPubkeys: string[]
}

const readModeration = () => readJSON<LocalModeration>('moderation', { hidden: [], mutedPubkeys: [] })

let hiddenCache: Set<string> | null = null
let mutesCache: MuteList | null = null

export function hiddenKeys(): Set<string> {
  hiddenCache ??= new Set(readModeration().hidden)
  return hiddenCache
}

export function localMutes(): MuteList {
  mutesCache ??= { ...emptyMuteList(), pubkeys: new Set(readModeration().mutedPubkeys) }
  return mutesCache
}

function writeModeration(m: LocalModeration) {
  writeJSON('moderation', m)
  hiddenCache = null
  mutesCache = null
  emit()
}

export function hideClip(key: string): void {
  const m = readModeration()
  if (!m.hidden.includes(key)) writeModeration({ ...m, hidden: [...m.hidden, key].slice(-2000) })
}

export function unhideClip(key: string): void {
  const m = readModeration()
  writeModeration({ ...m, hidden: m.hidden.filter((k) => k !== key) })
}

export function muteAuthor(pubkey: string): void {
  const m = readModeration()
  if (!m.mutedPubkeys.includes(pubkey)) writeModeration({ ...m, mutedPubkeys: [...m.mutedPubkeys, pubkey] })
}

export function clearLocalModeration(): void {
  writeModeration({ hidden: [], mutedPubkeys: [] })
}

// ----- liste de serveurs (kind 10063) déjà publiée par identité ----------------------

export const serverListPublished = (pubkey: string): string[] | null => readJSON<string[] | null>(`servers:${pubkey}`, null)

export const markServerListPublished = (pubkey: string, servers: string[]): void => writeJSON(`servers:${pubkey}`, servers)

// ----- diagnostic du dernier envoi ------------------------------------------------------

export interface LastDiagnostics {
  at: number
  tag: string
  items: Diagnostic[]
}

export const getLastDiagnostics = (): LastDiagnostics | null => readJSON<LastDiagnostics | null>('last-diagnostics', null)

export function saveLastDiagnostics(d: LastDiagnostics): void {
  writeJSON('last-diagnostics', d)
  emit()
}
