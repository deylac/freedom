/**
 * Module 2 — Client Blossom.
 *
 *  BUD-01  GET/HEAD /<sha256>        (vérification de présence)
 *  BUD-02  PUT /upload               (envoi binaire brut, hash vérifié strictement)
 *  BUD-04  PUT /mirror               (réplication serveur-à-serveur : économise la bande montante 4G)
 *  BUD-06  HEAD /upload              (pré-vérification taille/type/autorisation avant d'envoyer les octets)
 *  BUD-09  PUT /report               (signalement)
 *  BUD-11  Authorization: Nostr <base64url(kind 24242)>
 *  BUD-12  DELETE /<sha256>
 */
import { createAuthEvent, encodeAuthorizationHeader, type AuthType } from 'blossom-client-sdk/auth'
import { getServerHostname } from 'blossom-client-sdk/helpers/url'
import type { NostrEvent } from 'nostr-tools/pure'
import type { Signer } from '../nostr/signer'
import { baseMime, ensureExtension } from './urls'

export interface BlobDescriptor {
  url: string
  sha256: string
  size: number
  type?: string
  uploaded?: number
  /** Accepté seulement sans l'en-tête optionnel X-SHA-256 (configuration CORS du serveur incomplète). */
  minimalHeaders?: boolean
}

export type BlossomErrorKind = 'rejected' | 'network' | 'mismatch' | 'timeout' | 'aborted'

export class BlossomError extends Error {
  readonly server: string
  readonly status: number
  readonly kind: BlossomErrorKind
  readonly reason?: string
  constructor(server: string, kind: BlossomErrorKind, status = 0, reason?: string) {
    super(`${server} : ${kind}${status ? ` (HTTP ${status})` : ''}${reason ? ` — ${reason}` : ''}`)
    this.name = 'BlossomError'
    this.server = server
    this.kind = kind
    this.status = status
    this.reason = reason
  }
}

// ---------------------------------------------------------------------------
// BUD-11 — jetons d'autorisation

export interface AuthOptions {
  sha256?: string | string[]
  /** Restreint le jeton à ces serveurs (tags `server`) : empêche le rejeu ailleurs. */
  servers?: string[]
  message?: string
  /** Durée de validité en secondes. */
  ttl?: number
}

export async function createAuthToken(signer: Signer, verb: AuthType, opts: AuthOptions = {}): Promise<NostrEvent> {
  return createAuthEvent((draft) => signer.sign(draft), verb, {
    blobs: opts.sha256,
    servers: opts.servers?.map((s) => getServerHostname(s)),
    message: opts.message ?? defaultMessage(verb),
    expiration: Math.floor(Date.now() / 1000) + (opts.ttl ?? 3600),
  })
}

function defaultMessage(verb: AuthType): string {
  switch (verb) {
    case 'upload':
      return 'Uploading 60s video clip'
    case 'delete':
      return 'Delete video clip'
    default:
      return 'HashWall'
  }
}

export const authHeader = (token: NostrEvent): string => encodeAuthorizationHeader(token)

// ---------------------------------------------------------------------------
// Utilitaires HTTP

const endpoint = (server: string, path: string) => `${server.replace(/\/+$/, '')}${path}`

function readReason(res: { headers: { get(name: string): string | null } }): string | undefined {
  try {
    return res.headers.get('x-reason') ?? undefined
  } catch {
    return undefined
  }
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal) {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal?.addEventListener('abort', onAbort)
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    // credentials: 'omit' — aucun cookie tiers, aucune corrélation.
    return await fetch(input, { ...init, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

function toBlossomError(server: string, err: unknown, signal?: AbortSignal): BlossomError {
  if (err instanceof BlossomError) return err
  if (signal?.aborted) return new BlossomError(server, 'aborted')
  if (err instanceof DOMException && err.name === 'AbortError') return new BlossomError(server, 'timeout')
  return new BlossomError(server, 'network', 0, err instanceof Error ? err.message : String(err))
}

function validateDescriptor(server: string, raw: unknown, sha256: string, mime?: string): BlobDescriptor {
  const d = raw as Partial<BlobDescriptor> | null
  if (!d || typeof d.url !== 'string' || typeof d.sha256 !== 'string') {
    throw new BlossomError(server, 'rejected', 0, 'Descripteur de blob invalide')
  }
  // Vérification stricte : un serveur qui transforme le fichier casse l'adressage par contenu.
  if (d.sha256.toLowerCase() !== sha256) {
    throw new BlossomError(server, 'mismatch', 0, `hash renvoyé ${d.sha256} ≠ ${sha256}`)
  }
  return {
    url: mime ? ensureExtension(d.url, mime) : d.url,
    sha256,
    size: Number(d.size ?? 0),
    type: d.type,
    uploaded: d.uploaded,
  }
}

// ---------------------------------------------------------------------------
// BUD-06 — HEAD /upload

export type PreflightResult =
  | { ok: true; supported: boolean }
  | { ok: false; status: number; reason?: string }

export async function preflightUpload(
  server: string,
  blob: { sha256: string; size: number; type: string },
  token: NostrEvent,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<PreflightResult> {
  let res: Response
  try {
    res = await fetchWithTimeout(
      endpoint(server, '/upload'),
      {
        method: 'HEAD',
        headers: {
          'X-SHA-256': blob.sha256,
          'X-Content-Length': String(blob.size),
          'X-Content-Type': baseMime(blob.type),
          Authorization: authHeader(token),
        },
      },
      opts.timeoutMs ?? 8000,
      opts.signal,
    )
  } catch (err) {
    throw toBlossomError(server, err, opts.signal)
  }
  if (res.ok) return { ok: true, supported: true }
  // Serveur sans BUD-06 : on tentera directement PUT /upload.
  if (res.status === 404 || res.status === 405 || res.status === 501) return { ok: true, supported: false }
  return { ok: false, status: res.status, reason: readReason(res) }
}

// ---------------------------------------------------------------------------
// BUD-02 — PUT /upload (XHR pour la progression d'envoi)

export interface UploadOptions {
  sha256: string
  type: string
  token: NostrEvent
  onProgress?: (sent: number, total: number) => void
  signal?: AbortSignal
  /** Abandon si aucun octet n'est parti pendant ce délai (réseau saturé). */
  stallTimeoutMs?: number
  /**
   * Délai de réponse une fois le fichier entièrement envoyé. Constaté en réel : certains serveurs
   * (antivirus, transcodage d'empreinte) mettent plus de 30 s à répondre après réception.
   */
  responseTimeoutMs?: number
}

/**
 * Envoi avec repli CORS : certains serveurs n'autorisent pas l'en-tête optionnel `X-SHA-256`
 * dans leur réponse CORS ; le navigateur bloque alors la requête avant même de l'envoyer
 * (erreur réseau immédiate). On retente une fois sans cet en-tête.
 */
export async function uploadBlob(server: string, blob: Blob, opts: UploadOptions): Promise<BlobDescriptor> {
  try {
    return await uploadOnce(server, blob, opts, false)
  } catch (err) {
    if (!(err instanceof BlossomError) || err.kind !== 'network' || opts.signal?.aborted) throw err
    const descriptor = await uploadOnce(server, blob, opts, true)
    return { ...descriptor, minimalHeaders: true }
  }
}

function uploadOnce(server: string, blob: Blob, opts: UploadOptions, minimal: boolean): Promise<BlobDescriptor> {
  const mime = baseMime(opts.type)
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    let lastProgress = Date.now()
    /** Corps entièrement transmis : on attend la réponse du serveur, ce n'est plus un blocage réseau. */
    let bodySentAt = 0
    const stallMs = opts.stallTimeoutMs ?? 30_000
    const responseMs = opts.responseTimeoutMs ?? 120_000
    const watchdog = setInterval(() => {
      const now = Date.now()
      if (bodySentAt && now - bodySentAt > responseMs) {
        cleanup()
        xhr.abort()
        reject(new BlossomError(server, 'timeout', 0, `fichier reçu mais pas de réponse en ${Math.round(responseMs / 1000)} s`))
      } else if (!bodySentAt && now - lastProgress > stallMs) {
        cleanup()
        xhr.abort()
        reject(new BlossomError(server, 'timeout', 0, 'envoi bloqué (aucun octet transmis)'))
      }
    }, 1000)
    const onAbort = () => {
      cleanup()
      xhr.abort()
      reject(new BlossomError(server, 'aborted'))
    }
    const cleanup = () => {
      clearInterval(watchdog)
      opts.signal?.removeEventListener('abort', onAbort)
    }
    opts.signal?.addEventListener('abort', onAbort)

    xhr.open('PUT', endpoint(server, '/upload'))
    xhr.withCredentials = false
    xhr.setRequestHeader('Content-Type', mime)
    if (!minimal) xhr.setRequestHeader('X-SHA-256', opts.sha256)
    xhr.setRequestHeader('Authorization', authHeader(opts.token))
    xhr.upload.onprogress = (e) => {
      lastProgress = Date.now()
      const total = e.lengthComputable ? e.total : blob.size
      if (e.loaded >= total) bodySentAt ||= lastProgress
      opts.onProgress?.(e.loaded, total)
    }
    xhr.upload.onload = () => {
      bodySentAt ||= Date.now()
    }
    xhr.onload = () => {
      cleanup()
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new BlossomError(server, 'rejected', xhr.status, xhr.getResponseHeader('x-reason') ?? undefined))
        return
      }
      try {
        resolve(validateDescriptor(server, JSON.parse(xhr.responseText), opts.sha256, mime))
      } catch (err) {
        reject(err instanceof BlossomError ? err : new BlossomError(server, 'rejected', xhr.status, 'Réponse illisible'))
      }
    }
    xhr.onerror = () => {
      cleanup()
      reject(new BlossomError(server, 'network'))
    }
    xhr.send(blob)
  })
}

// ---------------------------------------------------------------------------
// BUD-04 — PUT /mirror

export interface MirrorOptions {
  sha256: string
  type: string
  size: number
  token: NostrEvent
  timeoutMs?: number
  signal?: AbortSignal
}

/** PUT /mirror avec le même repli CORS que l'envoi (nouvel essai sans X-SHA-256). */
export async function mirrorBlob(server: string, sourceUrl: string, opts: MirrorOptions): Promise<BlobDescriptor> {
  try {
    return await mirrorOnce(server, sourceUrl, opts, false)
  } catch (err) {
    if (!(err instanceof BlossomError) || err.kind !== 'network' || opts.signal?.aborted) throw err
    return { ...(await mirrorOnce(server, sourceUrl, opts, true)), minimalHeaders: true }
  }
}

async function mirrorOnce(server: string, sourceUrl: string, opts: MirrorOptions, minimal: boolean): Promise<BlobDescriptor> {
  let res: Response
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: authHeader(opts.token) }
  if (!minimal) headers['X-SHA-256'] = opts.sha256
  try {
    res = await fetchWithTimeout(
      endpoint(server, '/mirror'),
      { method: 'PUT', headers, body: JSON.stringify({ url: sourceUrl }) },
      // Le serveur télécharge puis analyse le fichier : peut dépasser la minute (nostr.build).
      opts.timeoutMs ?? 120_000,
      opts.signal,
    )
  } catch (err) {
    throw toBlossomError(server, err, opts.signal)
  }
  if (!res.ok) throw new BlossomError(server, 'rejected', res.status, readReason(res))
  return validateDescriptor(server, await res.json().catch(() => null), opts.sha256, opts.type)
}

// ---------------------------------------------------------------------------
// BUD-01 — HEAD /<sha256> (présence)

export async function hasBlob(url: string, timeoutMs = 6000): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(url, { method: 'HEAD' }, timeoutMs)
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// BUD-12 — DELETE /<sha256>

export async function deleteBlob(server: string, sha256: string, token: NostrEvent): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      endpoint(server, `/${sha256}`),
      { method: 'DELETE', headers: { Authorization: authHeader(token) } },
      10_000,
    )
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// BUD-09 — PUT /report

export async function reportBlob(server: string, report: NostrEvent): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      endpoint(server, '/report'),
      { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report) },
      10_000,
    )
    return res.ok
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Téléchargement vérifié (persona journaliste)

export async function downloadVerified(
  urls: string[],
  sha256: string,
  verify: (blob: Blob) => Promise<string>,
): Promise<{ blob: Blob; url: string }> {
  let lastError: unknown
  for (const url of urls) {
    try {
      const res = await fetchWithTimeout(url, {}, 120_000)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const blob = await res.blob()
      const actual = await verify(blob)
      if (actual !== sha256) throw new Error(`Empreinte différente sur ${url}`)
      return { blob, url }
    } catch (err) {
      lastError = err
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Aucune source valide')
}
