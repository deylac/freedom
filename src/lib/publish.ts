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
import { markHealthy, orderByHealth, penalize, penaltyOf } from './blossom/health'
import { stampDigest } from './ots/client'
import { serializeOts, toBase64 } from './ots/ots'
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
import { deleteJob, listJobs, putJob, type Diagnostic, type OutboxJob } from './storage/outbox'
import { markServerListPublished, removeMyClip, saveLastDiagnostics, saveMyClip, serverListPublished, type MyClip } from './storage/personal'
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
// Diagnostic lisible des échecs serveur

const STATUS_HINTS: Record<number, string> = {
  401: 'autorisation refusée (clé inconnue ou liste blanche)',
  402: 'paiement requis',
  403: 'interdit par la politique du serveur',
  404: 'fonction absente',
  405: 'fonction absente',
  409: 'empreinte différente',
  411: 'taille requise',
  413: 'fichier trop volumineux',
  415: 'type de fichier refusé',
  429: 'trop de requêtes',
  502: 'le serveur n’a pas pu récupérer la source',
  503: 'service indisponible',
}

export function describeError(err: unknown): string {
  if (err instanceof BlossomError) {
    const reason = err.reason ? ` — ${err.reason}` : ''
    switch (err.kind) {
      case 'rejected':
        return `HTTP ${err.status}${STATUS_HINTS[err.status] ? ` : ${STATUS_HINTS[err.status]}` : ''}${reason}`
      case 'timeout':
        return `pas de réponse (délai dépassé)${reason}`
      case 'network':
        return 'réponse illisible (en-têtes CORS absents) ou connexion impossible'
      case 'mismatch':
        return `le serveur a modifié le fichier${reason}`
      case 'aborted':
        return 'annulé'
    }
  }
  return err instanceof Error ? err.message : String(err)
}

function diag(job: OutboxJob, server: string, step: Diagnostic['step'], ok: boolean, detail: string) {
  ;(job.diagnostics ??= []).push({ server: hostOf(server), step, ok, detail })
}

// ---------------------------------------------------------------------------
// Horodatage OpenTimestamps de l'empreinte du fichier (voir src/lib/ots/client.ts)

async function stampVideo(job: OutboxJob): Promise<string | undefined> {
  const { file, calendars } = await stampDigest(hexToBytes(job.video.sha256), { calendars: getSettings().otsCalendars, timeoutMs: 8000 })
  for (const c of calendars) diag(job, c.url, 'horodatage', c.ok, c.ok ? 'empreinte soumise (ancrage Bitcoin sous 24 h)' : (c.error ?? 'échec'))
  return file ? toBase64(serializeOts(file)) : undefined
}

const within = <T>(p: Promise<T>, ms: number) =>
  Promise.race([p, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms))])

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
  for (const server of targets) {
    if (signal.aborted) throw new BlossomError(server, 'aborted')
    onProgress({ stage: 'checking', message: `Vérification de ${hostOf(server)}…` })
    let preflightUnknown = false
    try {
      const pre = await preflightUpload(server, { sha256: job.video.sha256, size: job.video.size, type: job.video.mime }, token, { signal })
      if (!pre.ok) {
        diag(job, server, 'envoi', false, `pré-vérification ${describeError(new BlossomError(server, 'rejected', pre.status, pre.reason))}`)
        continue
      }
    } catch (err) {
      if (err instanceof BlossomError && err.kind === 'aborted') throw err
      if (err instanceof BlossomError && err.kind === 'timeout') {
        penalize(server, `pré-vérification : ${describeError(err)}`)
        diag(job, server, 'envoi', false, `pré-vérification : ${describeError(err)}`)
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
      markHealthy(server)
      const notes = [preflightUnknown && 'pré-vérification impossible', descriptor.minimalHeaders && 'sans X-SHA-256 : CORS incomplet']
        .filter(Boolean)
        .join(', ')
      diag(job, server, 'envoi', true, `accepté — serveur primaire${notes ? ` (${notes})` : ''}`)
      return { server, descriptor }
    } catch (err) {
      if (err instanceof BlossomError && err.kind === 'aborted') throw err
      // Serveur muet ou injoignable : mis de côté 30 min pour ne pas retarder les prochains clips.
      if (err instanceof BlossomError && (err.kind === 'timeout' || err.kind === 'network')) penalize(server, describeError(err))
      diag(job, server, 'envoi', false, `${describeError(err)}${preflightUnknown ? ' (pré-vérification impossible)' : ''}`)
    }
  }
  const lines = (job.diagnostics ?? []).filter((d) => d.step === 'envoi').map((d) => `${d.server} : ${d.detail}`)
  throw new Error(`Aucun serveur Blossom n'a accepté la vidéo.\n${lines.join('\n')}`)
}

/**
 * Vignette : facultative. Sur la voie urgente on lui accorde un délai court (un serveur lent ne
 * doit pas retarder l'apparition de la vidéo) ; sinon elle est rattrapée par la voie de réplication.
 */
async function uploadPoster(
  job: OutboxJob,
  targets: string[],
  token: Awaited<ReturnType<typeof createAuthToken>>,
  signal: AbortSignal,
  responseTimeoutMs: number,
) {
  if (!job.poster || !job.posterBlob) return undefined
  for (const server of targets) {
    try {
      const d = await uploadBlob(server, job.posterBlob, {
        sha256: job.poster.sha256,
        type: job.poster.mime,
        token,
        signal,
        stallTimeoutMs: 15_000,
        responseTimeoutMs,
      })
      return d.url
    } catch (err) {
      if (err instanceof BlossomError && err.kind === 'aborted') throw err
    }
  }
  return undefined
}

const MIRROR_UNSUPPORTED = new Set([404, 405, 501, 502])

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
      ots: job.ots,
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
    ots: job.ots,
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

interface JobContext {
  signer: Signer
  token: Awaited<ReturnType<typeof createAuthToken>>
  targets: string[]
}

async function prepare(job: OutboxJob): Promise<JobContext> {
  const targets = servers()
  if (targets.length === 0) throw new Error('Aucun serveur Blossom configuré')
  if (job.video.size > MAX_UPLOAD_BYTES * 5) throw new Error('Fichier trop volumineux')
  const signer = await signerForJob(job)
  const blobs = [job.video.sha256, ...(job.poster ? [job.poster.sha256] : [])]
  const token = await createAuthToken(signer, 'upload', { sha256: blobs, servers: targets })
  return { signer, token, targets }
}

/**
 * Voie 1 — urgente : envoi principal + publication v1. Une vidéo est visible sur le mur dès la
 * fin de cette étape ; elle n'attend jamais la réplication d'une autre vidéo.
 */
export async function runPublishPhase(job: OutboxJob, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<void> {
  job.attempts++
  if (!job.primary) job.diagnostics = []
  const { signer, token, targets } = await prepare(job)
  // L'empreinte est connue avant l'envoi : l'horodatage se fait en parallèle, sans retarder le mur.
  const otsPromise = job.ots ? Promise.resolve(job.ots) : stampVideo(job).catch(() => undefined)

  if (!job.primary) {
    // Serveurs sains d'abord ; ceux qui ont récemment expiré ne sont essayés qu'en dernier recours.
    const { healthy, penalized } = orderByHealth(targets)
    const { server, descriptor } = await uploadPrimary(job, [...healthy, ...penalized], token, onProgress, signal)
    job.primary = { server, url: descriptor.url }
    job.servers = [server]
    job.posterUrl = await uploadPoster(job, [server], token, signal, 8_000)
    job.state = 'uploaded'
    job.timings.uploadedAt = Date.now()
    await putJob(job)
  }

  if (!job.eventId) {
    onProgress({ stage: 'publishing', message: 'Publication sur les relais Nostr…' })
    job.ots ??= await within(otsPromise, 3000)
    const createdAt = nowSeconds()
    job.publishedAt ??= createdAt
    const event = await signer.sign(buildEvent(job, createdAt))
    await publishEvent(getSettings().relays, event, signer).first
    job.eventId = event.id
    job.eventCreatedAt = event.created_at
    job.state = 'published'
    job.timings.publishedAt = Date.now()
    await putJob(job)
    rememberClip(job)
  }
}

const MAX_FALLBACKS = 4

/**
 * Voie 2 — en arrière-plan : réplication.
 *  1. PUT /mirror vers tous les serveurs restants EN PARALLÈLE (copie serveur à serveur :
 *     aucune bande montante consommée, et l'attente est celle du plus lent, pas la somme).
 *  2. Si moins de MIRROR_TARGET copies : envoi direct du fichier local, un serveur à la fois
 *     (bande montante), seulement là où /mirror est absent ou a échoué côté réseau.
 *  3. Publication v2 (même tag d) avec les `fallback`, puis liste kind 10063.
 */
export async function runMirrorPhase(job: OutboxJob, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<void> {
  const { signer, token, targets } = await prepare(job)
  job.diagnostics = (job.diagnostics ?? []).filter((d) => d.step !== 'miroir')
  // Horodatage manqué sur la voie urgente (calendriers lents) : nouvel essai, inclus dans la v2.
  const hadOts = !!job.ots
  const otsPromise = job.ots ? Promise.resolve(job.ots) : stampVideo(job).catch(() => undefined)
  const primary = job.primary!
  const remaining = targets.filter((s) => !job.servers.includes(s))
  const { healthy, penalized } = orderByHealth(remaining)
  for (const server of penalized) diag(job, server, 'miroir', false, `ignoré pendant 30 min : ${penaltyOf(server)}`)

  onProgress({ stage: 'mirroring', message: `Réplication vers ${healthy.length} serveur${healthy.length > 1 ? 's' : ''}…` })
  const attempts = await Promise.all(
    healthy.map(async (server) => {
      try {
        const d = await mirrorBlob(server, primary.url, { sha256: job.video.sha256, type: job.video.mime, size: job.video.size, token, signal })
        markHealthy(server)
        return { server, url: d.url, note: d.minimalHeaders ? ' (sans X-SHA-256 : CORS incomplet)' : '' }
      } catch (err) {
        if (err instanceof BlossomError && err.kind === 'aborted') throw err
        return { server, err }
      }
    }),
  )

  const fallbackCandidates: { server: string; err: unknown }[] = []
  for (const a of attempts) {
    if ('url' in a && a.url) {
      if (job.mirrors.length < MAX_FALLBACKS) {
        job.mirrors.push(a.url)
        job.servers.push(a.server)
      }
      diag(job, a.server, 'miroir', true, `répliqué via /mirror${a.note}`)
    } else if ('err' in a) {
      const err = a.err
      const retryable =
        err instanceof BlossomError && (err.kind === 'network' || err.kind === 'timeout' || MIRROR_UNSUPPORTED.has(err.status))
      if (retryable && job.videoBlob) fallbackCandidates.push({ server: a.server, err })
      else diag(job, a.server, 'miroir', false, `/mirror : ${describeError(err)}`)
    }
  }
  await putJob(job)

  for (const { server, err } of fallbackCandidates) {
    if (job.mirrors.length >= MIRROR_TARGET) {
      diag(job, server, 'miroir', false, `/mirror : ${describeError(err)} (envoi direct inutile : assez de copies)`)
      continue
    }
    onProgress({ stage: 'mirroring', message: `Envoi direct vers ${hostOf(server)}…` })
    try {
      const pre = await preflightUpload(server, { sha256: job.video.sha256, size: job.video.size, type: job.video.mime }, token, { signal }).catch(() => ({ ok: true }) as const)
      if (!pre.ok) throw new BlossomError(server, 'rejected', pre.status, pre.reason)
      const d = await uploadBlob(server, job.videoBlob!, { sha256: job.video.sha256, type: job.video.mime, token, signal })
      job.mirrors.push(d.url)
      job.servers.push(server)
      markHealthy(server)
      diag(job, server, 'miroir', true, `répliqué par envoi direct (/mirror : ${describeError(err)})`)
      await putJob(job)
    } catch (err2) {
      if (err2 instanceof BlossomError && err2.kind === 'aborted') throw err2
      if (err2 instanceof BlossomError && (err2.kind === 'timeout' || err2.kind === 'network')) penalize(server, describeError(err2))
      diag(job, server, 'miroir', false, `/mirror : ${describeError(err)} ; envoi direct : ${describeError(err2)}`)
    }
  }

  // Vignette non envoyée sur la voie urgente (serveur lent) : rattrapage ici, sans délai serré.
  if (!job.posterUrl && job.poster && job.posterBlob) {
    job.posterUrl = await uploadPoster(job, job.servers, token, signal, 120_000)
  }
  // Vignette : copie best-effort sur les serveurs qui détiennent la vidéo.
  if (job.posterUrl && job.poster) {
    const posterInfo = job.poster
    const posterUrl = job.posterUrl
    const copies = await Promise.all(
      job.servers
        .filter((s) => !posterUrl.startsWith(s) && !job.posterMirrors.some((u) => u.startsWith(s)))
        .map((server) =>
          mirrorBlob(server, posterUrl, { sha256: posterInfo.sha256, type: posterInfo.mime, size: posterInfo.size, token, signal, timeoutMs: 60_000 })
            .then((d) => d.url)
            .catch(() => undefined),
        ),
    )
    for (const url of copies) if (url) job.posterMirrors.push(url)
  }
  job.timings.mirroredAt = Date.now()
  job.ots ??= await within(otsPromise, 10_000)

  if (job.mirrors.length > 0 || (!hadOts && job.ots)) {
    onProgress({ stage: 'publishing', message: 'Ajout des miroirs à la publication…' })
    const createdAt = Math.max(nowSeconds(), (job.eventCreatedAt ?? 0) + 1)
    const event = await signer.sign(buildEvent(job, createdAt))
    try {
      await publishEvent(getSettings().relays, event, signer).first
      job.eventId = event.id
      job.eventCreatedAt = event.created_at
      rememberClip(job)
    } catch {
      /* la v1 reste valide ; les miroirs restent trouvables par le hash */
    }
  }

  await publishServerList(signer, job.servers)
  saveLastDiagnostics({ at: Date.now(), tag: job.tag, items: job.diagnostics ?? [] })

  job.state = 'done'
  // Les octets ne sont plus nécessaires : on les efface (saisie du téléphone).
  job.videoBlob = undefined
  job.posterBlob = undefined
  await deleteJob(job.id)
  onProgress({ stage: 'done', message: 'Publiée' })
}

/** Les deux voies à la suite (utilisé par les tests). */
export async function runJob(job: OutboxJob, onProgress: (p: Progress) => void, signal: AbortSignal): Promise<OutboxJob> {
  await runPublishPhase(job, onProgress, signal)
  await runMirrorPhase(job, onProgress, signal)
  return job
}

// ---------------------------------------------------------------------------
// File de publication : deux voies indépendantes, reprise automatique

export interface JobView {
  id: string
  tag: string
  state: OutboxJob['state']
  progress: Progress
  error?: string
  createdAt: number
  timings: OutboxJob['timings']
  mirrors: number
  diagnostics: Diagnostic[]
}

type Listener = () => void
type Lane = 'publish' | 'mirror'

class Publisher {
  private jobs = new Map<string, OutboxJob>()
  private progress = new Map<string, Progress>()
  private errors = new Map<string, string>()
  private queues: Record<Lane, string[]> = { publish: [], mirror: [] }
  private active: Record<Lane, { id: string; controller: AbortController } | null> = { publish: null, mirror: null }
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
      progress:
        this.progress.get(j.id) ??
        (j.state === 'published' ? { stage: 'mirroring', message: 'Réplication en attente' } : { stage: 'queued', message: 'En attente d’envoi' }),
      error: this.errors.get(j.id),
      createdAt: j.createdAt,
      timings: j.timings,
      mirrors: j.mirrors.length,
      diagnostics: [...(j.diagnostics ?? [])],
    }))
    this.snapshot = [...live, ...this.recent.filter((r) => !this.jobs.has(r.id))]
    this.listeners.forEach((l) => l())
  }

  private laneFor(job: OutboxJob): Lane {
    return job.eventId ? 'mirror' : 'publish'
  }

  enqueue(job: OutboxJob) {
    this.jobs.set(job.id, job)
    this.errors.delete(job.id)
    this.progress.delete(job.id)
    const lane = this.laneFor(job)
    if (!this.queues[lane].includes(job.id) && this.active[lane]?.id !== job.id) this.queues[lane].push(job.id)
    this.emit()
    void this.pump(lane)
  }

  async resumeAll() {
    for (const job of await listJobs()) if (job.state !== 'done' && !this.jobs.has(job.id)) this.enqueue(job)
  }

  retry(id: string) {
    const job = this.jobs.get(id)
    if (job) this.enqueue(job)
  }

  async cancel(id: string) {
    for (const lane of ['publish', 'mirror'] as Lane[]) {
      if (this.active[lane]?.id === id) this.active[lane]!.controller.abort()
      this.queues[lane] = this.queues[lane].filter((q) => q !== id)
    }
    this.jobs.delete(id)
    this.progress.delete(id)
    await deleteJob(id)
    this.emit()
  }

  dismiss(id: string) {
    this.recent = this.recent.filter((r) => r.id !== id)
    this.emit()
  }

  private async pump(lane: Lane): Promise<void> {
    if (this.active[lane]) return
    const id = this.queues[lane].shift()
    if (!id) return
    const job = this.jobs.get(id)
    if (!job) return this.pump(lane)
    const controller = new AbortController()
    this.active[lane] = { id, controller }
    const onProgress = (p: Progress) => {
      this.progress.set(id, p)
      this.emit()
    }
    try {
      if (lane === 'publish') {
        await runPublishPhase(job, onProgress, controller.signal)
        // Visible sur le mur : la réplication continue sur l'autre voie.
        this.progress.delete(id)
        this.enqueue(job)
      } else {
        await runMirrorPhase(job, onProgress, controller.signal)
        const finished: JobView = {
          id,
          tag: job.tag,
          state: 'done',
          progress: { stage: 'done', message: 'Publiée' },
          createdAt: job.createdAt,
          timings: job.timings,
          mirrors: job.mirrors.length,
          diagnostics: [...(job.diagnostics ?? [])],
        }
        this.recent = [finished, ...this.recent].slice(0, 5)
        this.jobs.delete(id)
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        job.state = job.eventId ? 'published' : 'failed'
        job.lastError = err instanceof Error ? err.message : String(err)
        this.errors.set(id, job.lastError)
        this.progress.set(id, { stage: 'error', message: job.lastError })
        await putJob(job)
      }
    } finally {
      this.active[lane] = null
      this.emit()
      void this.pump(lane)
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
