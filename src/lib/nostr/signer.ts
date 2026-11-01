/**
 * FR-02 — Identité cryptographique sans compte.
 *
 * - Une clé secrète locale (Uint8Array) est générée au premier lancement, sans email ni mot de passe.
 * - « Nouvelle identité anonyme » écrase cette clé pour casser toute corrélation entre vidéos.
 * - Support optionnel d'une extension NIP-07 (Alby, nos2x, Nostore…).
 * - Une clé « lecteur » distincte, jamais persistée, répond aux défis NIP-42 lors de la simple
 *   lecture : sans cela, répondre AUTH avec la clé de publication relierait l'adresse IP du
 *   spectateur à son identité de publication.
 */
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { WindowNostr } from 'nostr-tools/nip07'
import * as nip19 from 'nostr-tools/nip19'
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type EventTemplate,
  type VerifiedEvent,
} from 'nostr-tools/pure'
import { readJSON, removeKey, writeJSON } from '../storage/local'

declare global {
  interface Window {
    nostr?: WindowNostr
  }
}

export interface Signer {
  type: 'local' | 'extension'
  pubkey: string
  sign(template: EventTemplate): Promise<VerifiedEvent>
}

export function localSigner(secretKey: Uint8Array): Signer {
  const pubkey = getPublicKey(secretKey)
  return {
    type: 'local',
    pubkey,
    sign: async (template) => finalizeEvent(template, secretKey),
  }
}

export function hasExtension(): boolean {
  return typeof window !== 'undefined' && !!window.nostr
}

export async function extensionSigner(): Promise<Signer> {
  const ext = window.nostr
  if (!ext) throw new Error('Aucune extension Nostr (NIP-07) détectée')
  const pubkey = await ext.getPublicKey()
  return {
    type: 'extension',
    pubkey,
    sign: async (template) => {
      const signed = await ext.signEvent(template)
      // Ne jamais faire confiance aveuglément à l'extension.
      if (!verifyEvent(signed) || signed.pubkey !== pubkey) {
        throw new Error("Signature invalide renvoyée par l'extension")
      }
      return signed
    },
  }
}

// ---------------------------------------------------------------------------
// Identité locale persistée

interface StoredIdentity {
  sk: string
  createdAt: number
}

const IDENTITY_KEY = 'identity'

export function getOrCreateIdentity(): Uint8Array {
  const stored = readJSON<StoredIdentity | null>(IDENTITY_KEY, null)
  if (stored && /^[0-9a-f]{64}$/.test(stored.sk)) return hexToBytes(stored.sk)
  return newIdentity()
}

export function newIdentity(): Uint8Array {
  const sk = generateSecretKey()
  writeJSON(IDENTITY_KEY, { sk: bytesToHex(sk), createdAt: Date.now() } satisfies StoredIdentity)
  return sk
}

export function forgetIdentity(): void {
  removeKey(IDENTITY_KEY)
}

export function identityPubkey(): string {
  return getPublicKey(getOrCreateIdentity())
}

/** Signataire actif pour la publication, selon les réglages. */
export async function getPublishSigner(useExtension: boolean): Promise<Signer> {
  if (useExtension && hasExtension()) return extensionSigner()
  return localSigner(getOrCreateIdentity())
}

// ---------------------------------------------------------------------------
// Clé de lecture éphémère (NIP-42 sur les abonnements), propre à l'onglet.

let readerKey: Uint8Array | null = null

export function readerSigner(): Signer {
  readerKey ??= generateSecretKey()
  return localSigner(readerKey)
}

// ---------------------------------------------------------------------------
// Encodages NIP-19

export const npubOf = (pubkey: string): string => nip19.npubEncode(pubkey)
export const nsecOf = (sk: Uint8Array): string => nip19.nsecEncode(sk)

export function shortNpub(pubkey: string): string {
  const npub = npubOf(pubkey)
  return `${npub.slice(0, 10)}…${npub.slice(-4)}`
}

/** Accepte une clé publique hex ou npub ; retourne le hex ou null. */
export function parsePubkey(value: string): string | null {
  const v = value.trim()
  if (/^[0-9a-f]{64}$/i.test(v)) return v.toLowerCase()
  try {
    const decoded = nip19.decode(v)
    if (decoded.type === 'npub') return decoded.data
    if (decoded.type === 'nprofile') return decoded.data.pubkey
  } catch {
    /* entrée invalide */
  }
  return null
}

export { bytesToHex, hexToBytes }
