/**
 * Utilitaires d'URL Blossom (BUD-01, BUD-03, BUD-10).
 */
import { buildBlossomURI } from 'blossom-client-sdk/helpers/blossom-uri'
import { getHashFromURL } from 'blossom-client-sdk/helpers/url'

export { getHashFromURL }

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

function parse(url: string): URL | null {
  try {
    return new URL(url)
  } catch {
    return null
  }
}

/**
 * Seules les URLs https (ou http sur la boucle locale, pour le développement) sont acceptées
 * dans les événements reçus : on écarte javascript:, data:, http: en clair, etc.
 */
export function isAllowedMediaUrl(url: string): boolean {
  const u = parse(url)
  if (!u) return false
  return u.protocol === 'https:' || (u.protocol === 'http:' && LOOPBACK.has(u.hostname))
}

export function isAllowedRelayUrl(url: string): boolean {
  const u = parse(url)
  if (!u) return false
  return u.protocol === 'wss:' || (u.protocol === 'ws:' && LOOPBACK.has(u.hostname))
}

/** Normalise une URL de serveur Blossom en origine sans barre finale ; null si invalide. */
export function normalizeServer(url: string): string | null {
  const u = parse(url.trim())
  if (!u || !isAllowedMediaUrl(u.href)) return null
  return u.origin
}

export function normalizeRelay(url: string): string | null {
  const v = url.trim()
  if (!isAllowedRelayUrl(v)) return null
  const u = new URL(v)
  return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname.replace(/\/$/, '')}`
}

const MIME_EXT: Record<string, string> = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/x-matroska': 'mkv',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/png': 'png',
}

/** Type MIME sans paramètres de codec : `video/mp4;codecs=avc1` → `video/mp4`. */
export const baseMime = (mime: string): string => mime.split(';')[0].trim().toLowerCase()

export function extFromMime(mime: string): string {
  return MIME_EXT[baseMime(mime)] ?? 'bin'
}

/** URL BUD-01 avec extension explicite : `https://serveur/<sha256>.<ext>`. */
export function blobUrl(server: string, sha256: string, ext: string): string {
  return `${server.replace(/\/+$/, '')}/${sha256}.${ext}`
}

/**
 * Angle mort « modération IA contournée » : les chemins `/<sha256>` sans extension sont ignorés
 * par certains pipelines de modération (et lus difficilement par certains navigateurs mobiles).
 * Ajoute l'extension déduite du type MIME quand le dernier segment est un hash nu.
 */
export function ensureExtension(url: string, mime: string): string {
  const u = parse(url)
  if (!u) return url
  const segments = u.pathname.split('/')
  const last = segments[segments.length - 1]
  if (/^[0-9a-f]{64}$/i.test(last)) {
    segments[segments.length - 1] = `${last}.${extFromMime(mime)}`
    u.pathname = segments.join('/')
  }
  return u.toString()
}

/**
 * Liste ordonnée et dédoublonnée des URLs candidates pour un blob :
 *  1. url + fallback déclarés dans imeta
 *  2. serveurs de l'auteur (kind 10063)
 *  3. serveurs par défaut de l'application
 * Les candidats 2 et 3 sont reconstruits à partir du hash : c'est tout l'intérêt de
 * l'adressage par contenu (le fichier a la même URL relative partout).
 */
export function candidateUrls(
  declared: string[],
  sha256: string | undefined,
  ext: string,
  extraServers: string[],
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (url: string) => {
    if (!isAllowedMediaUrl(url)) return
    const key = url.replace(/^https?:\/\//, '')
    if (seen.has(key)) return
    seen.add(key)
    out.push(url)
  }
  declared.forEach(push)
  if (sha256) {
    const hosts = new Set(out.map((u) => parse(u)?.host))
    for (const s of extraServers) {
      const server = normalizeServer(s)
      if (server && !hosts.has(new URL(server).host)) push(blobUrl(server, sha256, ext))
    }
  }
  return out
}

/** URI de résilience BUD-10 : `blossom:<sha256>.<ext>?xs=<serveur>&as=<pubkey>`. */
export function blossomUri(sha256: string, ext: string, servers: string[], author?: string, size?: number): string {
  return buildBlossomURI({
    sha256,
    ext,
    servers: servers.map((s) => normalizeServer(s) ?? s),
    authors: author ? [author] : [],
    size,
  })
}

export function hostOf(url: string): string {
  return parse(url)?.host ?? url
}
