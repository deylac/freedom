import {
  DEFAULT_BLOSSOM_SERVERS,
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
}

const KEY = 'settings'
type Listener = () => void

let current: Settings = { ...DEFAULT_SETTINGS, ...readJSON<Partial<Settings>>(KEY, {}) }
const listeners = new Set<Listener>()

export function getSettings(): Settings {
  return current
}

export function updateSettings(patch: Partial<Settings>): void {
  current = { ...current, ...patch }
  writeJSON(KEY, current)
  listeners.forEach((l) => l())
}

export function resetSettings(): void {
  current = { ...DEFAULT_SETTINGS }
  writeJSON(KEY, current)
  listeners.forEach((l) => l())
}

export function subscribeSettings(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
