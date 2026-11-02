/**
 * Module 3 — Capture vidéo/audio via <canvas> et MediaRecorder.
 *
 * Caméra → <video> (caché sous le canvas) → <canvas> 720×1280 → canvas.captureStream(30)
 *        + piste micro                                     → MediaRecorder → Blob
 *
 * Seuls des pixels et des échantillons audio franchissent la frontière : aucune métadonnée
 * matérielle (EXIF, GPS, modèle, numéro de série) ne peut atteindre le fichier final.
 * Le passage par le canvas permet aussi le floutage des visages (FR-08) et le changement
 * de caméra pendant l'enregistrement.
 */
import { CAPTURE_FPS, CAPTURE_HEIGHT, CAPTURE_WIDTH, MAX_CLIP_MS, QUALITY_PROFILES, type QualityProfile } from '../../config'
import { baseMime, extFromMime } from '../blossom/urls'
import type { FacePassReport, PassStage } from './face-pass'
import { FaceTracker } from './face-tracker'
import { scrubVideoBlob, type ScrubReport } from './mp4-scrub'
import { createRobotVoice } from './voice'

export type FilterMode = 'none' | 'pixelate'
export type Facing = 'environment' | 'user'

export interface Recording {
  blob: Blob
  mime: string
  ext: string
  durationSec: number
  width: number
  height: number
  bitrate: number
  size: number
  poster: Blob | null
  scrub: ScrubReport
  stoppedBy: 'user' | 'limit' | 'interrupted'
  /** Voix transformée par le vocodeur (non réversible). */
  voice: VoiceMode
  /** Rapport du floutage des visages appliqué APRÈS COUP par l'utilisateur (expérimental). */
  faces?: FacePassReport
}

export type VoiceMode = 'natural' | 'robot'

export class CaptureError extends Error {
  constructor(
    message: string,
    readonly code: 'denied' | 'no-device' | 'busy' | 'unknown',
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}

function describeGumError(err: unknown): CaptureError {
  const name = err instanceof DOMException ? err.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CaptureError(
        "Accès à la caméra/au micro refusé. Autorisez-le dans les réglages du navigateur puis réessayez.",
        'denied',
      )
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CaptureError('Aucune caméra disponible sur cet appareil.', 'no-device')
    case 'NotReadableError':
    case 'AbortError':
      return new CaptureError('La caméra est utilisée par une autre application.', 'busy')
    default:
      return new CaptureError(`Impossible d'ouvrir la caméra (${name || String(err)}).`, 'unknown')
  }
}

const videoConstraints = (facing: Facing): MediaTrackConstraints => ({
  facingMode: { ideal: facing },
  width: { ideal: 1280 },
  height: { ideal: 720 },
  frameRate: { ideal: CAPTURE_FPS, max: CAPTURE_FPS },
})

const AUDIO: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }

export class CaptureSession {
  facing: Facing = 'environment'
  filter: FilterMode = 'none'
  voice: VoiceMode = 'natural'
  private voiceProc: { track: MediaStreamTrack; close(): void } | null = null
  maxMs = MAX_CLIP_MS

  private camera: MediaStream | null = null
  private audioTrack: MediaStreamTrack | null = null
  private ctx: CanvasRenderingContext2D
  private raf = 0
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private startedAt = 0
  private stopReason: Recording['stoppedBy'] = 'user'
  private timers: ReturnType<typeof setTimeout>[] = []
  private posterPromise: Promise<Blob | null> | null = null
  private scratch = document.createElement('canvas')
  private closed = false
  /** Lignes du filigrane (vide : aucun). La première est en gras. */
  watermark: string[] = []
  done: Promise<Recording> | null = null

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly mime: string,
    private readonly quality: QualityProfile,
  ) {
    canvas.width = CAPTURE_WIDTH
    canvas.height = CAPTURE_HEIGHT
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true })
    if (!ctx) throw new CaptureError('Canvas 2D indisponible', 'unknown')
    this.ctx = ctx
    this.ctx.fillStyle = '#0A0F1D'
    this.ctx.fillRect(0, 0, CAPTURE_WIDTH, CAPTURE_HEIGHT)
  }

  get recording(): boolean {
    return this.recorder?.state === 'recording'
  }

  elapsedMs(): number {
    return this.recording ? Math.min(performance.now() - this.startedAt, this.maxMs) : 0
  }

  get hasAudio(): boolean {
    return !!this.audioTrack
  }

  async open(): Promise<void> {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(this.facing), audio: AUDIO })
    } catch (err) {
      // Pas de micro : on filme quand même, sans son.
      if (err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
        try {
          stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(this.facing) })
        } catch (err2) {
          throw describeGumError(err2)
        }
      } else throw describeGumError(err)
    }
    if (this.closed) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    this.camera = stream
    this.audioTrack = stream.getAudioTracks()[0] ?? null
    this.watchTracks(stream)
    await this.attach(stream)
    document.addEventListener('visibilitychange', this.onVisibility)
    this.raf = requestAnimationFrame(this.draw)
  }

  /** Bascule avant/arrière, y compris pendant l'enregistrement (seule la source du canvas change). */
  async switchCamera(): Promise<void> {
    const next: Facing = this.facing === 'environment' ? 'user' : 'environment'
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(next) })
    } catch (err) {
      throw describeGumError(err)
    }
    this.camera?.getVideoTracks().forEach((t) => t.stop())
    const tracks = [...stream.getVideoTracks(), ...(this.audioTrack ? [this.audioTrack] : [])]
    this.camera = new MediaStream(tracks)
    this.watchTracks(stream)
    this.facing = next
    await this.attach(new MediaStream(stream.getVideoTracks()))
  }

  private watchTracks(stream: MediaStream) {
    for (const track of stream.getTracks()) {
      track.addEventListener('ended', () => {
        if (this.recording && track.kind === 'video' && this.camera?.getVideoTracks().some((t) => t === track)) {
          this.stopReason = 'interrupted'
          this.recorder?.stop()
        }
      })
    }
  }

  private async attach(stream: MediaStream) {
    const v = this.video
    v.muted = true
    v.playsInline = true
    v.setAttribute('playsinline', '')
    v.srcObject = new MediaStream(stream.getVideoTracks())
    try {
      await v.play()
    } catch {
      /* iOS peut exiger un geste : la lecture reprendra au prochain tap */
    }
  }

  private onVisibility = () => {
    // Écran verrouillé / appli changée : rAF s'arrête, la vidéo gèlerait. On clôt proprement.
    if (document.hidden && this.recording) {
      this.stopReason = 'interrupted'
      this.recorder?.stop()
    }
  }

  // ----- rendu --------------------------------------------------------------

  private draw = () => {
    const v = this.video
    if (v.readyState >= 2 && v.videoWidth > 0) {
      const W = CAPTURE_WIDTH
      const H = CAPTURE_HEIGHT
      const scale = Math.max(W / v.videoWidth, H / v.videoHeight)
      const sw = W / scale
      const sh = H / scale
      const sx = (v.videoWidth - sw) / 2
      const sy = (v.videoHeight - sh) / 2
      this.ctx.drawImage(v, sx, sy, sw, sh, 0, 0, W, H)
      if (this.filter === 'pixelate') this.pixelate(0, 0, W, H, 28)
      this.drawWatermark(W, H)
    }
    if (!this.closed) this.raf = requestAnimationFrame(this.draw)
  }

  /**
   * Filigrane incrusté dans l'image (donc dans le fichier, où qu'il soit repartagé) : indique que la
   * vidéo vient du projet. Dessiné APRÈS la pixelisation pour rester lisible.
   */
  private drawWatermark(W: number, H: number) {
    if (this.watermark.length === 0) return
    const ctx = this.ctx
    const [title, ...rest] = this.watermark
    ctx.save()
    ctx.textBaseline = 'alphabetic'
    ctx.font = '700 30px system-ui, -apple-system, Roboto, sans-serif'
    const small = '500 20px system-ui, -apple-system, Roboto, sans-serif'
    const x = 28
    let y = H - 44 - rest.length * 26
    ctx.shadowColor = 'rgba(0,0,0,0.85)'
    ctx.shadowBlur = 6
    ctx.fillStyle = 'rgba(255,255,255,0.92)'
    ctx.fillText(title, x, y)
    ctx.font = small
    ctx.fillStyle = 'rgba(255,255,255,0.8)'
    for (const line of rest) {
      y += 26
      ctx.fillText(line, x, y)
    }
    ctx.restore()
    void W
  }

  private pixelate(x: number, y: number, w: number, h: number, block: number) {
    if (w < 2 || h < 2) return
    const tw = Math.max(1, Math.ceil(w / block))
    const th = Math.max(1, Math.ceil(h / block))
    this.scratch.width = tw
    this.scratch.height = th
    const sctx = this.scratch.getContext('2d')
    if (!sctx) return
    sctx.drawImage(this.canvas, x, y, w, h, 0, 0, tw, th)
    this.ctx.imageSmoothingEnabled = false
    this.ctx.drawImage(this.scratch, 0, 0, tw, th, x, y, w, h)
    this.ctx.imageSmoothingEnabled = true
  }

  // ----- enregistrement -----------------------------------------------------

  start(): Promise<Recording> {
    if (this.recorder) throw new Error('Enregistrement déjà lancé')
    const profile = QUALITY_PROFILES[this.quality]
    const canvasStream = this.canvas.captureStream(CAPTURE_FPS)
    const tracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()]
    const voice = this.voice
    if (this.audioTrack) {
      if (voice === 'robot') {
        // Appelé depuis le clic (geste exigé par iOS pour Web Audio). Échec fermé : sans vocodeur,
        // on refuse d'enregistrer plutôt que de garder la vraie voix.
        try {
          this.voiceProc = createRobotVoice(this.audioTrack)
        } catch (err) {
          canvasStream.getVideoTracks().forEach((t) => t.stop())
          throw new CaptureError(`Voix anonymisée indisponible sur ce navigateur (${err instanceof Error ? err.message : err}) : enregistrement annulé.`, 'unknown')
        }
        tracks.push(this.voiceProc.track)
      } else tracks.push(this.audioTrack)
    }
    const recorder = new MediaRecorder(new MediaStream(tracks), {
      mimeType: this.mime,
      videoBitsPerSecond: profile.videoBitsPerSecond,
      audioBitsPerSecond: profile.audioBitsPerSecond,
    })
    this.recorder = recorder
    this.chunks = []
    this.stopReason = 'user'

    this.done = new Promise<Recording>((resolve, reject) => {
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) this.chunks.push(e.data)
      }
      recorder.onerror = (e) => reject((e as unknown as { error?: Error }).error ?? new Error('Erreur MediaRecorder'))
      recorder.onstart = () => {
        this.startedAt = performance.now()
        // Arrêt strict à 60,0 s (FR-03).
        this.timers.push(
          setTimeout(() => {
            if (recorder.state === 'recording') {
              this.stopReason = 'limit'
              recorder.stop()
            }
          }, this.maxMs),
        )
        this.timers.push(
          setTimeout(() => {
            this.posterPromise ??= this.snapshotPoster()
          }, 800),
        )
      }
      recorder.onstop = async () => {
        this.timers.forEach(clearTimeout)
        this.timers = []
        canvasStream.getVideoTracks().forEach((t) => t.stop())
        this.voiceProc?.close()
        this.voiceProc = null
        const elapsed = Math.min(performance.now() - this.startedAt, this.maxMs)
        try {
          const type = baseMime(recorder.mimeType || this.mime)
          const raw = new Blob(this.chunks, { type })
          this.chunks = []
          const poster = await (this.posterPromise ?? this.snapshotPoster())
          const { blob, report } = await scrubVideoBlob(raw)
          const durationSec = Math.max(0.1, elapsed / 1000)
          resolve({
            blob,
            mime: type,
            ext: extFromMime(type),
            durationSec,
            width: CAPTURE_WIDTH,
            height: CAPTURE_HEIGHT,
            bitrate: Math.round((blob.size * 8) / durationSec),
            size: blob.size,
            poster,
            scrub: report,
            stoppedBy: this.stopReason,
            voice,
          })
        } catch (err) {
          reject(err)
        } finally {
          this.recorder = null
          this.posterPromise = null
        }
      }
    })
    // Fragments d'une seconde : rien n'est perdu si l'enregistrement est interrompu.
    recorder.start(1000)
    return this.done
  }

  stop(): Promise<Recording> | null {
    if (this.recorder?.state === 'recording') {
      this.stopReason = 'user'
      this.recorder.stop()
    }
    return this.done
  }

  private snapshotPoster(): Promise<Blob | null> {
    return new Promise((resolve) => {
      try {
        this.canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8)
      } catch {
        resolve(null)
      }
    })
  }

  close(): void {
    this.closed = true
    this.voiceProc?.close()
    this.voiceProc = null
    cancelAnimationFrame(this.raf)
    this.timers.forEach(clearTimeout)
    document.removeEventListener('visibilitychange', this.onVisibility)
    if (this.recorder?.state === 'recording') this.recorder.stop()
    this.camera?.getTracks().forEach((t) => t.stop())
    this.audioTrack?.stop()
    this.video.srcObject = null
  }
}

// ---------------------------------------------------------------------------
// Floutage des visages APRÈS COUP (expérimental, à la demande de l'utilisateur)

/** Ce navigateur sait-il ré-encoder une vidéo (WebCodecs) ? */
export async function canBlurFacesAfter(): Promise<boolean> {
  const { postProcessCodec } = await import('./face-pass')
  return !!(await postProcessCodec(CAPTURE_WIDTH, CAPTURE_HEIGHT))
}

/**
 * Floute les visages d'une vidéo déjà tournée (second passage complet : analyse, rendu, contrôle).
 * Décision de l'éditeur (2 nov.) : jamais automatique, lent et imparfait ; l'original est conservé
 * par l'appelant pour pouvoir revenir en arrière.
 */
export async function blurFacesAfter(rec: Recording, onProgress?: (stage: PassStage, fraction: number) => void): Promise<Recording> {
  const { blurFacesInVideo, postProcessCodec } = await import('./face-pass')
  const codec = await postProcessCodec(CAPTURE_WIDTH, CAPTURE_HEIGHT)
  if (!codec) throw new Error('ce navigateur ne sait pas ré-encoder une vidéo')
  const main = new FaceTracker()
  const helpers: FaceTracker[] = []
  try {
    onProgress?.('analyse', 0)
    await main.ready()
    // Détecteurs supplémentaires selon les cœurs disponibles (facultatifs).
    const extra = Math.max(0, Math.min(2, (navigator.hardwareConcurrency || 2) - 3))
    for (let i = 0; i < extra; i++) helpers.push(new FaceTracker())
    const ready = await Promise.all(helpers.map((h) => h.ready(20_000).then(() => h, () => null)))
    const pool = [main, ...ready.filter((h): h is FaceTracker => !!h)]
    let turn = 0
    const pass = await blurFacesInVideo(rec.blob, (frame, mode) => pool[turn++ % pool.length].detect(frame, mode), {
      codec,
      bitrate: Math.max(500_000, Math.round(rec.bitrate * 0.9)),
      onProgress,
    })
    const { blob, report } = await scrubVideoBlob(pass.blob)
    return {
      ...rec,
      blob,
      mime: 'video/mp4',
      ext: 'mp4',
      size: blob.size,
      bitrate: Math.round((blob.size * 8) / rec.durationSec),
      poster: pass.poster ?? rec.poster,
      scrub: report,
      faces: pass.report,
    }
  } finally {
    main.close()
    helpers.forEach((h) => h.close())
  }
}
