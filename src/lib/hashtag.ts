/**
 * FR-01 — Routage par fragment d'URL.
 *
 * Le fragment (#...) n'est jamais envoyé au serveur HTTP qui sert l'application.
 * Formes acceptées :
 *   #14octobre                 → mur « 14octobre »
 *   #14Octobre                 → normalisé en « 14octobre »
 *   #14octobre/naddr1...       → mur + clip ouvert directement
 *   #%C3%A9t%C3%A9              → « été » (fragments percent-encodés par le navigateur)
 */

export const MAX_TAG_LENGTH = 64

export type Route =
  | { view: 'home' }
  | { view: 'wall'; tag: string; clip?: string }

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Normalise un hashtag : décodage, NFC, minuscules, suppression du # et des espaces,
 * conservation des seules lettres/chiffres Unicode, « _ » et « - ».
 * Retourne une chaîne vide si rien d'exploitable ne subsiste.
 */
export function normalizeTag(raw: string): string {
  const decoded = safeDecode(raw).normalize('NFC').toLowerCase()
  const cleaned = decoded.replace(/^#+/, '').replace(/[^\p{L}\p{N}_-]+/gu, '')
  return [...cleaned].slice(0, MAX_TAG_LENGTH).join('')
}

const NADDR_RE = /^naddr1[02-9ac-hj-np-z]+$/
const NEVENT_RE = /^nevent1[02-9ac-hj-np-z]+$/

export function parseHash(hash: string): Route {
  const body = hash.replace(/^#/, '').replace(/^\//, '')
  if (!body) return { view: 'home' }
  const [first, second] = body.split('/')
  const tag = normalizeTag(first)
  if (!tag) return { view: 'home' }
  const clip = second && (NADDR_RE.test(second) || NEVENT_RE.test(second)) ? second : undefined
  return clip ? { view: 'wall', tag, clip } : { view: 'wall', tag }
}

export function routeToHash(route: Route): string {
  if (route.view === 'home') return ''
  const base = `#${encodeURIComponent(route.tag)}`
  return route.clip ? `${base}/${route.clip}` : base
}

/** URL absolue du mur, valable sur le domaine courant, un miroir ou une passerelle IPFS. */
export function wallUrl(tag: string, clip?: string, location: Pick<Location, 'origin' | 'pathname'> = window.location): string {
  return `${location.origin}${location.pathname}${routeToHash({ view: 'wall', tag, clip })}`
}
