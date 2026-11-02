/**
 * Adresses de secours (docs/RESILIENCE.md, R2).
 *
 * L'application connaît ses miroirs par trois sources :
 *   1. la liste intégrée au build (VITE_MIRRORS) ;
 *   2. une liste SIGNÉE par la clé du projet (VITE_PROJECT_NPUB), publiée sur Nostr
 *      (kind 30078, d = "hashwall-mirrors") : si tous les domaines connus tombent, une app déjà
 *      installée apprend les nouvelles adresses par les relais ;
 *   3. l'adresse d'où elle est servie.
 * Seule la clé du projet peut publier la liste : un miroir piégé ne peut pas s'y inviter.
 */
import type { EventTemplate, NostrEvent } from 'nostr-tools/pure'
import { verifyEvent } from 'nostr-tools/pure'
import { MIRRORS, PROJECT_PUBKEY } from '../config'
import { nowSeconds } from './nostr/events'
import { queryOnce } from './nostr/pool'
import { readJSON, writeJSON } from './storage/local'

export const KIND_APP_DATA = 30078
export const MIRRORS_D = 'hashwall-mirrors'

export interface Mirror {
  url: string
  label?: string
  source: 'intégrée' | 'signée' | 'actuelle'
}

/** https partout ; http accepté seulement pour une adresse .onion (Tor chiffre déjà). */
export function isValidMirror(url: string): boolean {
  try {
    const u = new URL(url)
    if (u.username || u.password || u.hash || u.search) return false
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname.endsWith('.onion'))
  } catch {
    return false
  }
}

const normalize = (url: string) => (url.endsWith('/') ? url : `${url}/`)

export function buildMirrorListEvent(mirrors: { url: string; label?: string }[]): EventTemplate {
  return {
    kind: KIND_APP_DATA,
    created_at: nowSeconds(),
    content: 'Adresses de secours HashWall',
    tags: [['d', MIRRORS_D], ...mirrors.filter((m) => isValidMirror(m.url)).map((m) => ['r', normalize(m.url), ...(m.label ? [m.label] : [])])],
  }
}

export function parseMirrorList(event: NostrEvent, projectPubkey: string): { url: string; label?: string }[] | null {
  if (event.kind !== KIND_APP_DATA || event.pubkey !== projectPubkey || !verifyEvent(event)) return null
  if (!event.tags.some((t) => t[0] === 'd' && t[1] === MIRRORS_D)) return null
  return event.tags
    .filter((t) => t[0] === 'r' && t[1] && isValidMirror(t[1]))
    .slice(0, 50)
    .map((t) => ({ url: normalize(t[1]), label: t[2] }))
}

interface Cached {
  at: number
  mirrors: { url: string; label?: string }[]
}

const CACHE_KEY = 'mirrors'

/** Récupère la liste signée la plus récente et la garde en cache (elle survit aux blocages). */
export async function refreshSignedMirrors(relays: string[], projectPubkey = PROJECT_PUBKEY): Promise<number> {
  if (!projectPubkey) return 0
  const events = await queryOnce(relays, { kinds: [KIND_APP_DATA], authors: [projectPubkey], '#d': [MIRRORS_D] }, 6000)
  const latest = events.sort((a, b) => b.created_at - a.created_at)[0]
  const cached = readJSON<Cached | null>(CACHE_KEY, null)
  if (!latest || (cached && cached.at >= latest.created_at)) return cached?.mirrors.length ?? 0
  const mirrors = parseMirrorList(latest, projectPubkey)
  if (!mirrors) return cached?.mirrors.length ?? 0
  writeJSON(CACHE_KEY, { at: latest.created_at, mirrors } satisfies Cached)
  return mirrors.length
}

export function knownMirrors(current = `${window.location.origin}${window.location.pathname}`): Mirror[] {
  const out = new Map<string, Mirror>()
  const add = (url: string, source: Mirror['source'], label?: string) => {
    const key = normalize(url)
    if (!out.has(key) && (isValidMirror(key) || source === 'actuelle')) out.set(key, { url: key, label, source })
  }
  add(current, 'actuelle')
  for (const m of readJSON<Cached | null>(CACHE_KEY, null)?.mirrors ?? []) add(m.url, 'signée', m.label)
  for (const url of MIRRORS) add(url, 'intégrée')
  return [...out.values()]
}

/**
 * Le miroir est-il joignable DEPUIS LE RÉSEAU de l'utilisateur ? (requête sans lecture de réponse :
 * une réponse opaque suffit à prouver que ni le DNS ni la connexion ne sont bloqués). Seulement sur
 * action de l'utilisateur ; ne contacte que les adresses du projet.
 */
export async function probeMirror(url: string, timeoutMs = 8000): Promise<boolean> {
  if (url.includes('.onion')) return false
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    await fetch(new URL('manifest.webmanifest', url).href, { mode: 'no-cors', cache: 'no-store', signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
    return true
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}
