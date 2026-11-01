/**
 * Orchestration de la publication (parcours B du PRD).
 *
 *  1. Empreintes SHA-256 locales (vidéo + vignette), après purge du conteneur.
 *  2. Jeton BUD-11 unique (t=upload, x=vidéo+vignette, server=liste des serveurs visés).
 *  3. HEAD /upload puis PUT /upload sur le premier serveur qui accepte (repli sur les suivants).
 *  4. Publication immédiate de l'événement kind 34236 (v1) dès le premier accusé de relais.
 *  5. Réplication PUT /mirror vers 2 autres serveurs (repli : envoi direct si /mirror absent).
 *  6. Republication (v2, même tag d) avec les URLs `fallback` : l'événement adressable est
 *     remplacé, pas dupliqué, et les compteurs/signalements restent attachés à l'adresse.
 *  7. Publication/mise à jour de la liste de serveurs kind 10063 de l'identité (BUD-03).
 *
 * Chaque étape est enregistrée dans la file IndexedDB : une coupure reprend là où elle s'est arrêtée.
 */
import { hexToBytes } from '@noble/hashes/utils.js'
import { MAX_UPLOAD_BYTES, MIRROR_TARGET } from '../config'
import {
  BlossomError,
  createAuthToken,
  deleteBlob,
  mirrorBlob,
  preflightUpload,
  reportBlob,
  uploadBlob,
  type BlobDescriptor,
} from './blossom/client'
import { hostOf, normalizeServer } from './blossom/urls'
import { sha256Hex } from './media/hash'
import type { Recording } from './media/recorder'
import {
  buildDeletionEvent,
  buildReportEvent,
  buildServerListEvent,
  buildVideoEvent,
  clipIdentifier,
  KIND_SHORT_VIDEO,
  addressOf,
  nowSeconds,
  type Clip,
  type ReportReason,
} from './nostr/events'
import { publishEvent } from './nostr/pool'
import {
  bytesToHex,
  extensionSigner,
  getOrCreateIdentity,
  getPublishSigner,
  hasExtension,
  localSigner,
  type Signer,
} from './nostr/signer'
import { deleteJob, listJobs, putJob, type OutboxJob } from './storage/outbox'
import { markServerListPublished, removeMyClip, saveMyClip, serverListPublished, type MyClip } from './storage/personal'
import { getSettings } from './storage/settings'

export type Stage = 'queued' | 'checking' | 'uploading' | 'publishing' | 'mirroring' | 'done' | 'error'

export interface Progress {
  stage: Stage
  message: string
  sent?: number
  total?: number
}

const servers = (): string[] =>
  [...new Set(getSettings().blossomServers.map(normalizeServer).filter((s): s is string => !!s))]

// ---------------------------------------------------------------------------
// Création du travail à partir d'un enregistrement

export async function createJob(
  recording: Recording,
  opts: { tag: string; caption: string; contentWarning?: string; useExtension: boolean },
): Promise<OutboxJob> {
  const videoSha = await sha256Hex(recording.blob)
  const posterSha = recording.poster ? await sha256Hex(recording.poster) : undefined
  const useExtension = opts.useExtension && hasExtension()
  const sk = useExtension ? null : getOrCreateIdentity()
  const signer = sk ? localSigner(sk) : await extensionSigner()
  const job: OutboxJob = {
    id: videoSha,
    createdAt: Date.now(),
    tag: opts.tag,
    caption: opts.caption.trim(),
    contentWarning: opts.contentWarning,
    video: {
      sha256: videoSha,
      mime: recording.mime,
      ext: recording.ext,
      size: recording.size,
      duration: recording.durationSec,
      width: recording.width,
      height: recording.height,
      bitrate: recording.bitrate,
    },
    poster:
      recording.poster && posterSha
        ? { sha256: posterSha, mime: 'image/jpeg', ext: 'jpg', size: recording.poster.size }
        : undefined,
    videoBlob: recording.blob,
    posterBlob: recording.poster ?? undefined,
    // La clé est figée dans le travail : si l'identité tourne entre-temps, la vidéo reste
    // signée (et supprimable) avec la clé d'origine.
    signer: sk
      ? { type: 'local', sk: bytesToHex(sk), pubkey: signer.pubkey }
      : { type: 'extension', pubkey: signer.pubkey },
    state: 'pending',
    servers: [],
    mirrors: [],
    posterMirrors: [],
    attempts: 0,
    timings: { recordedAt: Date.now() },
  }
  await putJob(job)
  return job
}

async function signerForJob(job: OutboxJob): Promise<Signer> {
  if (job.signer.type === 'local') return localSigner(hexToBytes(job.signer.sk))
  const ext = await extensionSigner()
  if (ext.pubkey !== job.signer.pubkey) throw new Error("L'extension Nostr utilise une autre clé que celle de la vidéo")
  return ext
}

// ---------------------------------------------------------------------------
// Étapes

async function uploadPrimary(
  job: OutboxJob,
  targets: string[],
  token: Awaited<ReturnType<typeof createAuthToken>>,
  onProgress: (p: Progress) => void,
  signal: AbortSignal,
): Promise<{ server: string; descriptor: BlobDescriptor }> {
  const blob = job.videoBlob
  if (!blob) throw new Error('Fichier vidéo introuvable dans la file locale')
  const errors: string[] = []
  for (const server of targets) {
    if (signal.aborted) throw new BlossomError(server, 'aborted')
    onProgress({ stage: 'checking', message: `Vérification de ${hostOf(server)}…` })
    let preflightUnknown = false
    try {
      const pre = await preflightUpload(server, { sha256: job.video.sha256, size: job.video.size, type: job.video.mime }, token, { signal })
      if (!pre.ok) {
        errors.push(`${hostOf(server)} : refus HTTP ${pre.status}${pre.reason ? ` (${pre.reason})` : ''}`)
        continue
      }
    } catch (err) {
      if (err instanceof BlossomError && (err.kind === 'aborted')) throw err
      if (err instanceof BlossomError && err.kind === 'timeout') {
        errors.push(`${hostOf(server)} : injoignable`)
        continue
      }
      // Erreur réseau rapide (souvent CORS sur HEAD) : on tente quand même l'envoi.
      preflightUnknown = true
    }
    try {
      onProgress({ stage: 'uploading', message: `Envoi vers ${hostOf(server)}`, sent: 0, total: job.video.size })
      const descriptor = await uploadBlob(server, blob, {
        sha256: job.video.sha256,
        type: job.video.mime,
        token,
        signal,
        onProgress: (sent, total) =>
          onProgress({ stage: 'uploading', message: `Envoi vers ${hostOf(server)}`, sent, total }),
      })
      return { server, descriptor }
    } catch (err) {
      if (err instanceof BlossomError && err.kind === 'aborted') throw err
      errors.push(`${hostOf(server)} : ${err instanceof Error ? err.message : String(err)}${preflightUnknown ? ' (pré-vérification impossible)' : ''}`)
    }
  }
  throw new Error(`Aucun serveur Blossom n'a accepté la vidéo.\n${errors.join('\n')}`)
}

async function uploadPoster(job: OutboxJob, targets: string[], token: Awaited<ReturnType<typeof createAuthToken>>, signal: AbortSignal) {
  if (!job.poster || !job.posterBlob) return undefined
  for (const server of targets) {
    try {
      const d = await uploadBlob(server, job.posterBlob, { sha256: job.poster.sha256, type: job.poster.mime, token, signal, stallTimeoutMs: 15_000 })
      return d.url
    } catch (err) {
      if (err instanceof BlossomError && err.kind === 'aborted') throw err
    }
  }
  return undefined
}

const MIRROR_UNSUPPORTED = new Set([404, 405, 501, 502])

/** Réplique un blob : /mirror d'abord (pas de bande montante consommée), envoi direct en repli. */
async function replicate(
  server: string,
  sourceUrl: string,
  info: { sha256: string; mime: string; size: number },
  blob: Blob | undefined,
  token: Awaited<ReturnType<typeof createAuthToken>>,
  signal: AbortSignal,
): Promise<string> {
  try {
    const d = await mirrorBlob(server, sourceUrl, { sha256: info.sha256, type: info.mime, size: info.size, token, signal })
    return d.url
  } catch (err) {
    if (!(err instanceof BlossomError) || err.kind === 'aborted' || err.kind === 'mismatch') throw err
    const fallbackOk = err.kind === 'network' || err.kind === 'timeout' || MIRROR_UNSUPPORTED.has(err.status)
    if (!blob || !fallbackOk) throw err
    const pre = await preflightUpload(server, { sha256: info.sha256, size: info.size, type: info.mime }, token, { signal }).catch(() => ({ ok: true }) as const)
    if (!pre.ok) throw err
    const d = await uploadBlob(server, blob, { sha256: info.sha256, type: info.mime, token, signal })
    return d.url
  }
}

function buildEvent(job: OutboxJob, createdAt: number) {
  const seconds = Math.round(job.video.duration)
  return buildVideoEvent({
    d: clipIdentifier(job.video.sha256),
    hashtag: job.tag,
    title: `#${job.tag} - Clip citoyen`,
    content: job.caption || `#${job.tag}`,
    alt: `Vidéo citoyenne de ${seconds} secondes filmée pour #${job.tag}`,
    publishedAt: job.publishedAt ?? createdAt,
    createdAt,
    contentWarning: job.contentWarning,
    video: {
      url: job.primary!.url,
      sha256: job.video.sha256,
      mime: job.video.mime,
      width: job.video.width,
      height: job.video.height,
      duration: job.video.duration,
      bitrate: job.video.bitrate,
      size: job.video.size,
      images: [job.posterUrl, ...job.posterMirrors].filter((u): u is string => !!u),
      fallbacks: job.mirrors,
    },
  })
}

function rememberClip(job: OutboxJob) {
  const settings = getSettings()
  const d = clipIdentifier(job.video.sha256)
  const record: MyClip = {
    key: addressOf(KIND_SHORT_VIDEO, job.signer.pubkey, d),
    kind: KIND_SHORT_VIDEO,
    d,
    eventId: job.eventId!,
    pubkey: job.signer.pubkey,
    sk: settings.keepDeletionKeys && job.signer.type === 'local' ? job.signer.sk : undefined,
    sha256: job.video.sha256,
    posterSha256: job.poster?.sha256,
    servers: job.servers,
    tag: job.tag,
    publishedAt: job.publishedAt!,
    posterUrl: job.posterUrl,
    url: job.primary!.url,
  }
  saveMyClip(record)
}

async function publishServerList(signer: Signer, hosting: string[]) {
  // Jamais pour une extension : remplacer la liste 10063 existante d'un utilisateur la détruirait.
  if (signer.type !== 'local' || hosting.length === 0) return
  const previous = serverListPublished(signer.pubkey) ?? []
  const merged = [...new Set([...hosting, ...previous])].slice(0, 8)
  if (merged.length === previous.length && merged.every((s, i) => s === previous[i])) return
  const event = await signer.sign(buildServerListEvent(merged))
  const { first } = publishEvent(getSettings().relays, event, signer)
  await first.then(() => markServerListPublished(signer.pubkey, merged)).catch(() => {})
}

export async function runJob(job: OutboxJob, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<OutboxJob> {
  const settings = getSettings()
  const targets = servers()
  if (targets.length === 0) throw new Error('Aucun serveur Blossom configuré')
  if (job.video.size > MAX_UPLOAD_BYTES * 5) throw new Error('Fichier trop volumineux')
  job.attempts++
  const signer = await signerForJob(job)
  const blobs = [job.video.sha256, ...(job.poster ? [job.poster.sha256] : [])]
  const token = await createAuthToken(signer, 'upload', { sha256: blobs, servers: targets })

  // 3. Envoi primaire
  if (!job.primary) {
    const { server, descriptor } = await uploadPrimary(job, targets, token, onProgress, signal)
    job.primary = { server, url: descriptor.url }
    job.servers = [server]
    job.posterUrl = await uploadPoster(job, [server, ...targets.filter((s) => s !== server)], token, signal)
    job.state = 'uploaded'
    job.timings.uploadedAt = Date.now()
    await putJob(job)
  }

  // 4. Publication v1 dès le premier accusé de relais
  if (!job.eventId) {
    onProgress({ stage: 'publishing', message: 'Publication sur les relais Nostr…' })
    const createdAt = nowSeconds()
    job.publishedAt ??= createdAt
    const event = await signer.sign(buildEvent(job, createdAt))
    const { first } = publishEvent(settings.relays, event, signer)
    await first
    job.eventId = event.id
    job.eventCreatedAt = event.created_at
    job.state = 'published'
    job.timings.publishedAt = Date.now()
    await putJob(job)
    rememberClip(job)
  }

  // 5. Miroirs
  onProgress({ stage: 'mirroring', message: 'Réplication sur des serveurs miroirs…' })
  const primary = job.primary!
  for (const server of targets) {
    if (job.mirrors.length >= MIRROR_TARGET) break
    if (job.servers.includes(server)) continue
    try {
      const url = await replicate(server, primary.url, job.video, job.videoBlob, token, signal)
      job.mirrors.push(url)
      job.servers.push(server)
      if (job.posterUrl && job.poster) {
        const posterUrl = await replicate(server, job.posterUrl, job.poster, job.posterBlob, token, signal).catch(() => undefined)
        if (posterUrl) job.posterMirrors.push(posterUrl)
      }
      await putJob(job)
    } catch (err) {
      if (err instanceof BlossomError && err.kind === 'aborted') throw err
    }
  }
  job.timings.mirroredAt = Date.now()

  // 6. v2 avec les fallback (même adresse : remplacement, pas doublon)
  if (job.mirrors.length > 0) {
    onProgress({ stage: 'publishing', message: 'Ajout des miroirs à la publication…' })
    const createdAt = Math.max(nowSeconds(), (job.eventCreatedAt ?? 0) + 1)
    const event = await signer.sign(buildEvent(job, createdAt))
    try {
      await publishEvent(settings.relays, event, signer).first
      job.eventId = event.id
      job.eventCreatedAt = event.created_at
      rememberClip(job)
    } catch {
      /* la v1 reste valide ; les miroirs restent trouvables par le hash */
    }
  }

  // 7. Liste de serveurs de l'identité
  await publishServerList(signer, job.servers)

  job.state = 'done'
  // Les octets ne sont plus nécessaires : on les efface (saisie du téléphone).
  job.videoBlob = undefined
  job.posterBlob = undefined
  await deleteJob(job.id)
  onProgress({ stage: 'done', message: 'Publiée' })
  return job
}

// ---------------------------------------------------------------------------
// File de publication (une seule tâche à la fois, reprise automatique)

export interface JobView {
  id: string
  tag: string
  state: OutboxJob['state']
  progress: Progress
  error?: string
  createdAt: number
  timings: OutboxJob['timings']
  mirrors: number
}

type Listener = () => void

class Publisher {
  private jobs = new Map<string, OutboxJob>()
  private progress = new Map<string, Progress>()
  private errors = new Map<string, string>()
  private queue: string[] = []
  private active: { id: string; controller: AbortController } | null = null
  private listeners = new Set<Listener>()
  private snapshot: JobView[] = []
  private recent: JobView[] = []

  subscribe = (l: Listener) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  getSnapshot = () => this.snapshot

  private emit() {
    const live: JobView[] = [...this.jobs.values()].map((j) => ({
      id: j.id,
      tag: j.tag,
      state: j.state,
      progress: this.progress.get(j.id) ?? { stage: 'queued', message: 'En attente' },
      error: this.errors.get(j.id),
      createdAt: j.createdAt,
      timings: j.timings,
      mirrors: j.mirrors.length,
    }))
    this.snapshot = [...live, ...this.recent.filter((r) => !this.jobs.has(r.id))]
    this.listeners.forEach((l) => l())
  }

  enqueue(job: OutboxJob) {
    this.jobs.set(job.id, job)
    this.errors.delete(job.id)
    if (!this.queue.includes(job.id) && this.active?.id !== job.id) this.queue.push(job.id)
    this.emit()
    void this.pump()
  }

  async resumeAll() {
    for (const job of await listJobs()) if (job.state !== 'done' && !this.jobs.has(job.id)) this.enqueue(job)
  }

  retry(id: string) {
    const job = this.jobs.get(id)
    if (job) this.enqueue(job)
  }

  async cancel(id: string) {
    if (this.active?.id === id) this.active.controller.abort()
    this.queue = this.queue.filter((q) => q !== id)
    this.jobs.delete(id)
    this.progress.delete(id)
    await deleteJob(id)
    this.emit()
  }

  dismiss(id: string) {
    this.recent = this.recent.filter((r) => r.id !== id)
    this.emit()
  }

  private async pump(): Promise<void> {
    if (this.active) return
    const id = this.queue.shift()
    if (!id) return
    const job = this.jobs.get(id)
    if (!job) return this.pump()
    const controller = new AbortController()
    this.active = { id, controller }
    try {
      await runJob(job, (p) => {
        this.progress.set(id, p)
        this.emit()
      }, controller.signal)
      const finished: JobView = {
        id,
        tag: job.tag,
        state: 'done',
        progress: { stage: 'done', message: 'Publiée' },
        createdAt: job.createdAt,
        timings: job.timings,
        mirrors: job.mirrors.length,
      }
      this.recent = [finished, ...this.recent].slice(0, 5)
      this.jobs.delete(id)
    } catch (err) {
      if (!controller.signal.aborted) {
        job.state = job.eventId ? 'published' : 'failed'
        job.lastError = err instanceof Error ? err.message : String(err)
        this.errors.set(id, job.lastError)
        this.progress.set(id, { stage: 'error', message: job.lastError })
        await putJob(job)
      }
    } finally {
      this.active = null
      this.emit()
      void this.pump()
    }
  }
}

export const publisher = new Publisher()

// ---------------------------------------------------------------------------
// Suppression (NIP-09 + BUD-12)

export async function deleteMyClip(clip: MyClip): Promise<{ relays: number; servers: number }> {
  if (!clip.sk) throw new Error('Clé de suppression non conservée sur cet appareil')
  const signer = localSigner(hexToBytes(clip.sk))
  const event = await signer.sign(buildDeletionEvent({ ids: [clip.eventId], addresses: [clip.key], kind: clip.kind }))
  const { all } = publishEvent(getSettings().relays, event, signer)
  const blobs = [clip.sha256, ...(clip.posterSha256 ? [clip.posterSha256] : [])]
  // BUD-11 : jeton de suppression restreint aux serveurs concernés (pas de rejeu ailleurs).
  const token = await createAuthToken(signer, 'delete', { sha256: blobs, servers: clip.servers, ttl: 300 })
  const deletions = await Promise.all(
    clip.servers.flatMap((s) => blobs.map((sha) => deleteBlob(s, sha, token))),
  )
  const relays = await all.then((r) => r.ok.length).catch(() => 0)
  removeMyClip(clip.key)
  return { relays, servers: deletions.filter(Boolean).length }
}

// ---------------------------------------------------------------------------
// Signalement (NIP-56 vers les relais + BUD-09 vers les serveurs Blossom)

export async function reportClip(clip: Clip, reason: ReportReason, comment: string, hostingServers: string[]) {
  const settings = getSettings()
  const signer = await getPublishSigner(settings.useExtension)
  const blobServers = [
    ...new Set(
      [clip.video.url, ...clip.video.fallbacks, ...hostingServers]
        .map((u) => normalizeServer(u))
        .filter((s): s is string => !!s),
    ),
  ]
  const event = await signer.sign(buildReportEvent(clip, reason, comment, blobServers))
  const { all } = publishEvent(settings.relays, event, signer)
  const blossom = clip.video.sha256 ? await Promise.all(blobServers.map((s) => reportBlob(s, event))) : []
  const relays = await all.then((r) => r.ok.length).catch(() => 0)
  return { event, relays, servers: blossom.filter(Boolean).length }
}
