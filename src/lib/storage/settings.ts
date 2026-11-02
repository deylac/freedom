import {
  DEFAULT_BLOSSOM_SERVERS,
  DEFAULT_BTC_EXPLORERS,
  DEFAULT_OTS_CALENDARS,
  LEGACY_DEFAULT_BLOSSOM_SERVERS,
  LEGACY_DEFAULT_RELAYS,
  DEFAULT_MODERATORS,
  DEFAULT_RELAYS,
  DEFAULT_REPORT_THRESHOLD,
  type QualityProfile,
} from '../../config'
import { readJSON, writeJSON } from './local'

export interface Settings {
  relays: string[]
  blossomServers: string[]
  /** Clés publiques hex des collectifs de modération de confiance. */
  moderators: string[]
  reportThreshold: number
  /** Publication automatique après un aperçu de 3 s (sinon : bouton « Publier »). */
  autoPublish: boolean
  quality: QualityProfile
  /** Nouvelle identité Nostr pour chaque vidéo (non-corrélation maximale). */
  rotateIdentity: boolean
  /** Signer avec l'extension NIP-07 (window.nostr) plutôt qu'avec la clé locale. */
  useExtension: boolean
  /** Conserver localement les clés des vidéos publiées pour pouvoir les supprimer. */
  keepDeletionKeys: boolean
  termsAcceptedVersion: number
  installBannerDismissed: boolean
  /** Copier automatiquement (de serveur à serveur) les vidéos regardées : chaque spectateur renforce le réseau. */
  autoPreserve: boolean
  /** Calendriers OpenTimestamps (liste blanche : seuls ceux-ci sont contactés). */
  otsCalendars: string[]
  /** Explorateurs Bitcoin (API Esplora) utilisés pour vérifier les preuves. */
  btcExplorers: string[]
  /**
   * Filtre d'anonymisation à l'ouverture de la caméra (dernier choix mémorisé). « Sans flou » par
   * défaut depuis le 2 nov. : le floutage des visages (détecteur BlazeFace) donnait un rendu jugé
   * insatisfaisant en réel (zones trop grandes, fausses alertes) ; il revient par défaut avec le
   * nouveau détecteur. Le libellé du bouton reste toujours visible.
   */
  captureFilter: 'none' | 'faces' | 'pixelate'
}

export const DEFAULT_SETTINGS: Settings = {
  relays: DEFAULT_RELAYS,
  blossomServers: DEFAULT_BLOSSOM_SERVERS,
  moderators: DEFAULT_MODERATORS,
  reportThreshold: DEFAULT_REPORT_THRESHOLD,
  autoPublish: true,
  quality: 'standard',
  rotateIdentity: false,
  useExtension: false,
  keepDeletionKeys: true,
  termsAcceptedVersion: 0,
  installBannerDismissed: false,
  autoPreserve: true,
  captureFilter: 'none',
  otsCalendars: DEFAULT_OTS_CALENDARS,
  btcExplorers: DEFAULT_BTC_EXPLORERS,
}

const KEY = 'settings'
type Listener = () => void

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Seules les valeurs choisies par l'utilisateur sont enregistrées : sinon une liste par défaut
 * figée dans le stockage local empêcherait toute mise à jour de l'application de la corriger
 * (cas réel : un serveur devenu payant resté en tête de liste).
 */
export function loadOverrides(stored: Partial<Settings>): Partial<Settings> {
  const out: Partial<Settings> = { ...stored }
  if (out.blossomServers && LEGACY_DEFAULT_BLOSSOM_SERVERS.some((legacy) => same(legacy, out.blossomServers))) {
    delete out.blossomServers
  }
  if (out.relays && LEGACY_DEFAULT_RELAYS.some((legacy) => same(legacy, out.relays))) delete out.relays
  for (const key of Object.keys(out) as (keyof Settings)[]) {
    if (same(out[key], DEFAULT_SETTINGS[key])) delete out[key]
  }
  return out
}

function persist(settings: Settings) {
  writeJSON(KEY, loadOverrides(settings))
}

let current: Settings = { ...DEFAULT_SETTINGS, ...loadOverrides(readJSON<Partial<Settings>>(KEY, {})) }
const listeners = new Set<Listener>()

export function getSettings(): Settings {
  return current
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch }
  persist(current)
  listeners.forEach((l) => l())
}

export function resetSettings(): void {
  current = { ...DEFAULT_SETTINGS }
  persist(current)
  listeners.forEach((l) => l())
}

export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
