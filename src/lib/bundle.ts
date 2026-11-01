/**
 * Paquets hors ligne : stocker, transporter, publier (docs/RESILIENCE.md, R3).
 *
 * Sans réseau, le témoin prépare un PAQUET : la vidéo + l'événement Nostr déjà signé + une
 * autorisation d'envoi Blossom (BUD-11) déjà signée, valable 7 jours. Il le transmet par le partage
 * natif du téléphone (AirDrop, Quick Share, Bluetooth, clé USB, messagerie maillée type BitChat…).
 * N'importe qui ayant du réseau l'ouvre dans HashWall et le publie : il ne fait que TRANSPORTER, il
 * ne peut ni modifier la vidéo (empreinte), ni le texte (signature), ni en usurper l'auteur.
 *
 * Format : le fichier reste une vraie vidéo (.mp4 lisible partout) à laquelle on ajoute une boîte
 * MP4 `uuid` finale, ignorée des lecteurs, qui contient le JSON signé. Les messageries qui
 * recompressent les vidéos (WhatsApp…) détruisent le paquet : l'envoyer « comme fichier ».
 */
import { generateSecretKey, verifyEvent, type NostrEvent } from 'nostr-tools/pure'
import { createAuthToken, mirrorBlob, preflightUpload, uploadBlob, BlossomError, type BlobDescriptor } from './blossom/client'
import { blobUrl, hostOf, isAllowedMediaUrl, normalizeServer } from './blossom/urls'
import { sha256Hex } from './media/hash'
import { buildVideoEvent, clipIdentifier, KIND_FILE_METADATA, KIND_SHORT_VIDEO, nowSeconds, parseVideoEvent, type Clip } from './nostr/events'
import { publishEvent } from './nostr/pool'
import { localSigner, type Signer } from './nostr/signer'
import { getSettings } from './storage/settings'
import type { OutboxJob } from './storage/outbox'

/** Identifiant de la boîte `uuid` HashWall (aléatoire, fixe). */
const BOX_UUID = new Uint8Array([0x9b, 0x2f, 0x4c, 0x61, 0x1e, 0x8d, 0x4a, 0x07, 0xb3, 0x55, 0x48, 0x57, 0x42, 0x55, 0x4e, 0x31])
const MAGIC = new TextEncoder().encode('HWBUNDL1')
export const BUNDLE_TTL_S = 7 * 24 * 3600
const MAX_PAYLOAD = 256 * 1024

export interface BundlePayload {
  v: 1
  /** Événement vidéo kind 34236 signé par l'auteur. */
  event: NostrEvent
  /** Autorisation d'envoi (kind 24242) signée par l'auteur, limitée à cette empreinte et ces serveurs. */
  token: NostrEvent
  /** Serveurs Blossom autorisés par le jeton, dans l'ordre de préférence de l'auteur. */
  servers: string[]
}

// ---------------------------------------------------------------------------
// Encodage

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255])
const readU32 = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0

/** Boîte : [taille][`uuid`][UUID 16 o][JSON][longueur JSON 4 o][HWBUNDL1]. */
export function encodeBundle(video: Blob, payload: BundlePayload): Blob {
  const json = new TextEncoder().encode(JSON.stringify(payload))
  const size = 8 + 16 + json.length + 4 + MAGIC.length
  return new Blob([video, u32(size), new TextEncoder().encode('uuid'), BOX_UUID, json, u32(json.length), MAGIC], { type: video.type })
}

/** Sépare la vidéo d'origine et le paquet ; null si le fichier n'en contient pas. */
export async function decodeBundle(file: Blob): Promise<{ video: Blob; payload: BundlePayload } | null> {
  if (file.size < 40) return null
  const tail = new Uint8Array(await file.slice(file.size - 12).arrayBuffer())
  if (!MAGIC.every((b, i) => tail[4 + i] === b)) return null
  const jsonLength = readU32(tail, 0)
  if (jsonLength > MAX_PAYLOAD) return null
  const boxSize = 8 + 16 + jsonLength + 4 + MAGIC.length
  if (boxSize > file.size) return null
  const box = new Uint8Array(await file.slice(file.size - boxSize).arrayBuffer())
  if (readU32(box, 0) !== boxSize || new TextDecoder().decode(box.subarray(4, 8)) !== 'uuid') return null
  if (!BOX_UUID.every((b, i) => box[8 + i] === b)) return null
  try {
    const payload = JSON.parse(new TextDecoder().decode(box.subarray(24, 24 + jsonLength))) as BundlePayload
    return { video: file.slice(0, file.size - boxSize, file.type || 'video/mp4'), payload }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Préparation (côté témoin, sans réseau)

export async function createBundle(job: OutboxJob, signer: Signer, serverList = getSettings().blossomServers): Promise<File> {
  if (!job.videoBlob) throw new Error('Fichier vidéo introuvable sur l’appareil')
  const servers = [...new Set(serverList.map(normalizeServer).filter((s): s is string => !!s))].slice(0, 6)
  if (servers.length === 0) throw new Error('Aucun serveur Blossom configuré')
  const { sha256, ext, mime } = job.video
  const createdAt = nowSeconds()
  const seconds = Math.round(job.video.duration)
  // Adresses PRÉVUES (convention BUD-01 serveur/empreinte.ext) : le lecteur essaie chacune.
  const urls = servers.map((s) => blobUrl(s, sha256, ext))
  const event = await signer.sign(
    buildVideoEvent({
      d: clipIdentifier(sha256),
      hashtag: job.tag,
      title: `#${job.tag} - Clip citoyen`,
      content: job.caption || `#${job.tag}`,
      alt: `Vidéo citoyenne de ${seconds} secondes filmée pour #${job.tag}`,
      publishedAt: Math.floor(job.timings.recordedAt / 1000),
      createdAt,
      contentWarning: job.contentWarning,
      video: { ...job.video, url: urls[0], images: [], fallbacks: urls.slice(1, 4), ots: job.ots },
    }),
  )
  const token = await createAuthToken(signer, 'upload', {
    sha256,
    servers,
    ttl: BUNDLE_TTL_S,
    message: 'Paquet HashWall : envoi par un relais humain',
  })
  const payload: BundlePayload = { v: 1, event, token, servers }
  return new File([encodeBundle(job.videoBlob, payload)], `hashwall-${job.tag}-${sha256.slice(0, 8)}.${ext}`, { type: mime })
}

// ---------------------------------------------------------------------------
// Vérification (côté porteur)

export interface BundleCheck {
  clip: Clip
  video: Blob
  payload: BundlePayload
  expiresAt: number
}

const tag = (e: NostrEvent, name: string) => e.tags.find((t) => t[0] === name)?.[1]

/** Vérifie tout ce qui peut l'être hors ligne. Lève une erreur lisible sinon. */
export async function checkBundle(file: Blob, now = nowSeconds()): Promise<BundleCheck> {
  const decoded = await decodeBundle(file)
  if (!decoded) throw new Error('Ce fichier n’est pas un paquet HashWall (ou il a été recompressé par une messagerie).')
  const { video, payload } = decoded
  const { event, token } = payload
  if (payload.v !== 1 || !event || !token || !Array.isArray(payload.servers)) throw new Error('Paquet incomplet.')
  if (event.kind !== KIND_SHORT_VIDEO || !verifyEvent(event)) throw new Error('Signature de la publication invalide.')
  const clip = parseVideoEvent(event)
  if (!clip?.video.sha256) throw new Error('Publication illisible.')
  const sha = await sha256Hex(video)
  if (sha !== clip.video.sha256) throw new Error('La vidéo a été modifiée : son empreinte ne correspond plus à la publication signée.')
  if (tag(event, 'd') !== clipIdentifier(sha)) throw new Error('Identifiant de publication incohérent.')
  if (token.kind !== 24242 || !verifyEvent(token) || token.pubkey !== event.pubkey) throw new Error('Autorisation d’envoi invalide.')
  if (tag(token, 't') !== 'upload' || !token.tags.some((t) => t[0] === 'x' && t[1] === sha)) throw new Error('Autorisation d’envoi sans rapport avec cette vidéo.')
  const expiresAt = Number(tag(token, 'expiration') ?? 0)
  if (!(expiresAt > now)) throw new Error('Autorisation d’envoi expirée : demandez à l’auteur un nouveau paquet.')
  const allowed = new Set(token.tags.filter((t) => t[0] === 'server').map((t) => t[1]))
  payload.servers = payload.servers.filter((s) => isAllowedMediaUrl(s) && (allowed.size === 0 || allowed.has(new URL(s).hostname)))
  if (payload.servers.length === 0) throw new Error('Aucun serveur autorisé dans le paquet.')
  return { clip, video, payload, expiresAt }
}

// ---------------------------------------------------------------------------
// Publication (côté porteur, avec réseau)

export interface RelayResult {
  copies: string[]
  relays: number
  failed: { server: string; reason: string }[]
}

export async function relayBundle(check: BundleCheck, onStep: (message: string) => void = () => {}): Promise<RelayResult> {
  const { clip, video, payload } = check
  const sha256 = clip.video.sha256!
  const mime = clip.video.mime ?? 'video/mp4'
  const failed: RelayResult['failed'] = []
  const copies: BlobDescriptor[] = []
  const servers = payload.servers

  // 1. Un envoi direct (seule consommation de forfait du porteur), puis copies de serveur à serveur.
  let primary: BlobDescriptor | null = null
  let primaryServer = ''
  for (const server of servers) {
    try {
      onStep(`Envoi vers ${hostOf(server)}…`)
      const pre = await preflightUpload(server, { sha256, size: video.size, type: mime }, payload.token).catch(() => ({ ok: true }) as const)
      if (!pre.ok) {
        failed.push({ server: hostOf(server), reason: `refusé (${pre.status})` })
        continue
      }
      primary = await uploadBlob(server, video, { sha256, type: mime, token: payload.token })
      primaryServer = server
      copies.push(primary)
      break
    } catch (err) {
      failed.push({ server: hostOf(server), reason: err instanceof BlossomError ? `${err.kind}${err.status ? ` ${err.status}` : ''}` : String(err) })
    }
  }
  if (!primary) throw new Error(`Aucun serveur n’a accepté la vidéo : ${failed.map((f) => `${f.server} (${f.reason})`).join(', ')}`)

  onStep('Copies de secours…')
  const others = servers.filter((s) => s !== primaryServer).slice(0, 3)
  const mirrored = await Promise.allSettled(
    others.map((s) => mirrorBlob(s, primary!.url, { sha256, type: mime, size: video.size, token: payload.token, timeoutMs: 60_000 })),
  )
  mirrored.forEach((r, i) => {
    if (r.status === 'fulfilled') copies.push(r.value)
    else failed.push({ server: hostOf(others[i]), reason: r.reason instanceof Error ? r.reason.message : String(r.reason) })
  })

  // 2. La publication signée par l'auteur, telle quelle. Le porteur s'authentifie (NIP-42) avec une clé jetable.
  onStep('Publication sur les relais…')
  const courier = localSigner(generateSecretKey())
  const result = await publishEvent(getSettings().relays, payload.event, courier).all
  if (result.ok.length === 0) throw new Error('Aucun relais n’a accepté la publication (réseau bloqué ?). Le paquet reste réutilisable.')

  // 3. Adresses réelles annoncées (NIP-94) : utile si un serveur a renvoyé une autre URL que prévu.
  const urls = copies.map((c) => c.url).filter((u) => u.includes(sha256))
  if (urls.length > 0) {
    const announce = await courier.sign({
      kind: KIND_FILE_METADATA,
      created_at: nowSeconds(),
      content: '',
      tags: [['url', urls[0]], ...urls.slice(1).map((u) => ['fallback', u]), ['x', sha256], ['ox', sha256], ['m', mime], ['alt', 'Copie publiée par un relais humain']],
    })
    await publishEvent(getSettings().relays, announce, courier).first.catch(() => {})
  }
  return { copies: copies.map((c) => c.url), relays: result.ok.length, failed }
}
