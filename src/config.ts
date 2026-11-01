/**
 * Configuration par défaut. Chaque valeur peut être surchargée au build via les variables
 * d'environnement VITE_* (voir .env.example) puis par l'utilisateur dans les Réglages.
 *
 * IMPORTANT : ces listes n'ont pas pu être validées en conditions réelles depuis
 * l'environnement de développement (réseau sortant filtré). Elles doivent être revues
 * avant la mise en production : voir docs/ANGLES-MORTS.md, section « Infrastructure par défaut ».
 */

const list = (raw: string | undefined, fallback: string[]): string[] => {
  const values = (raw ?? '')
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean)
  return values.length > 0 ? values : fallback
}

const int = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseInt(raw ?? '', 10)
  return Number.isFinite(n) ? n : fallback
}

const env = import.meta.env

/** Relais Nostr généralistes (lecture + écriture). */
export const DEFAULT_RELAYS = list(env.VITE_RELAYS, [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://nostr.mom',
  'wss://relay.nostr.net',
  'wss://offchain.pub',
])

/**
 * Serveurs Blossom, par ordre de préférence. Le client essaie chaque serveur via
 * HEAD /upload (BUD-06) et ignore ceux qui refusent (taille, paiement, liste blanche) :
 * une liste plus longue que nécessaire augmente la probabilité de trouver 3 hébergeurs.
 */
export const DEFAULT_BLOSSOM_SERVERS = list(env.VITE_BLOSSOM_SERVERS, [
  'https://blossom.nostr.build',
  'https://blossom.primal.net',
  'https://nostr.download',
  'https://blosstr.com',
  'https://cdn.nostrcheck.me',
])

/** Clés publiques (hex ou npub) de collectifs de modération dont on applique les listes kind:10000. */
export const DEFAULT_MODERATORS = list(env.VITE_MODERATORS, [])

/** Murs mis en avant sur la page d'accueil. */
export const FEATURED_TAGS = list(env.VITE_FEATURED_TAGS, [])

/** Nombre de signalements (clés distinctes) à partir duquel une vidéo est floutée. */
export const DEFAULT_REPORT_THRESHOLD = int(env.VITE_REPORT_THRESHOLD, 3)

/** Durée maximale d'un clip (FR-03). */
export const MAX_CLIP_MS = 60_000

/** Tolérance d'affichage : un événement déclarant plus que cela est considéré hors format. */
export const MAX_DECLARED_DURATION_S = 61

/** Résolution de capture (vertical 9:16). */
export const CAPTURE_WIDTH = 720
export const CAPTURE_HEIGHT = 1280
export const CAPTURE_FPS = 30

/**
 * Profils de débit. Le PRD demande 2,5–3,5 Mbps ET un fichier < 20 Mo : c'est incompatible
 * (3,5 Mbps × 60 s ≈ 26 Mo). 20 Mio ≈ 2,79 Mbps tout compris : on vise 2 Mbps vidéo + 96 kbps
 * audio (~15,7 Mo) pour garder une marge, MediaRecorder dépassant parfois la cible.
 */
export const QUALITY_PROFILES = {
  standard: { label: 'Standard (~16 Mo/min)', videoBitsPerSecond: 2_000_000, audioBitsPerSecond: 96_000 },
  eco: { label: 'Réseau saturé (~8 Mo/min)', videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 },
} as const
export type QualityProfile = keyof typeof QUALITY_PROFILES

/** Limite de sécurité côté client (palier gratuit nostr.build : 20 Mio). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

/** Nombre de miroirs visés en plus du serveur primaire. */
export const MIRROR_TARGET = 2

/** Plafond de clips affichés par auteur sur un mur (anti-inondation). */
export const MAX_CLIPS_PER_AUTHOR = 12

/** Kinds lus sur le mur : 34236 (adressable, publié par HashWall) + 22 (court, ancien format). */
export const WALL_KINDS = [34236, 22]

/** Version des CGU : l'incrémenter force une nouvelle acceptation. */
export const TERMS_VERSION = 1

export const SOURCE_URL = 'https://github.com/deylac/freedom'
