/**
 * Second passage de floutage des visages, sur la vidéo DÉJÀ tournée (WebCodecs via mediabunny).
 *
 *  1. Analyse : 10 images par seconde passées au détecteur (sans contrainte de temps réel).
 *  2. Plan : pistes par visage, interpolation entre détections, maintien avant/après (face-plan.ts).
 *  3. Rendu : chaque image est ré-encodée avec une ellipse pixelisée serrée sur chaque visage.
 *  4. Contrôle : la vidéo PRODUITE est ré-analysée avec une autre grille de tuiles. Visage net
 *     trouvé → ajouté au plan et nouveau rendu ; s'il en reste, les passages concernés sont
 *     entièrement pixelisés (échec fermé).
 *
 * La vidéo brute ne quitte jamais la mémoire : elle n'est ni enregistrée, ni envoyée.
 */
import { ALL_FORMATS, BlobSource, BufferTarget, Conversion, getFirstEncodableVideoCodec, Input, Mp4OutputFormat, Output, VideoSampleSink, type VideoCodec } from 'mediabunny'
import type { Box } from './faces'
import { covered, MaskPlan, type FrameDetections } from './face-plan'

export type DetectFn = (frame: ImageBitmap, mode: 'analyze' | 'verify') => Promise<Box[]>

export interface FacePassReport {
  /** Images analysées avant le rendu. */
  analyzed: number
  /** Visages distincts suivis. */
  faces: number
  /** Images contrôlées après le rendu. */
  verified: number
  /** Visages nets trouvés par le contrôle puis corrigés. */
  corrected: number
  /** Instants (s) entièrement pixelisés par sécurité, faute d'avoir pu corriger. */
  fullyPixelated: number[]
  ms: number
  /** Durée de chaque étape (ms) : analyse, rendu, contrôle, correction. */
  steps: Record<string, number>
}

export interface FacePassResult {
  blob: Blob
  poster: Blob | null
  report: FacePassReport
}

export type PassStage = 'analyse' | 'floutage' | 'contrôle' | 'correction'

const ANALYZE_EVERY_S = 0.1
const VERIFY_EVERY_S = 0.5
/**
 * Score minimal d'un visage trouvé par le contrôle. Bas à dessein : un visage pixelisé peut encore
 * « ressembler » à un visage (scores jusqu'à 0,65 mesurés), mais il est alors sous un masque et
 * écarté par sa position ; un visage net raté, lui, peut ne scorer que 0,5 (mesuré en E2E).
 */
const VERIFY_MIN_SCORE = 0.3
/** Autour d'un visage que le contrôle n'a pas pu corriger : image entière pixelisée (s). */
const FALLBACK_WINDOW_S = 0.5

const renderLog: { t: number; boxes: number[][] }[] = []
let codecCache: Promise<VideoCodec | null> | null = null

/** Codec vidéo encodable par ce navigateur (null : second passage impossible → floutage en direct). */
export function postProcessCodec(width: number, height: number): Promise<VideoCodec | null> {
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') return Promise.resolve(null)
  codecCache ??= getFirstEncodableVideoCodec(['avc', 'vp9'], { width, height }).catch(() => null)
  return codecCache
}

function makeCanvas(w: number, h: number): OffscreenCanvas | HTMLCanvasElement {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

type Ctx2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

/** Ellipse pixelisée, ajustée au rectangle (le visage) : rien d'autre n'est touché. */
export function pixelateEllipse(ctx: Ctx2D, scratch: Ctx2D, box: Box, W: number, H: number) {
  const x = Math.max(0, Math.floor(box.x))
  const y = Math.max(0, Math.floor(box.y))
  const w = Math.min(W, Math.ceil(box.x + box.w)) - x
  const h = Math.min(H, Math.ceil(box.y + box.h)) - y
  if (w < 2 || h < 2) return
  const block = Math.max(4, Math.round(Math.max(box.w, box.h) / 8))
  const tw = Math.max(1, Math.ceil(w / block))
  const th = Math.max(1, Math.ceil(h / block))
  scratch.canvas.width = tw
  scratch.canvas.height = th
  scratch.imageSmoothingEnabled = true
  scratch.drawImage(ctx.canvas, x, y, w, h, 0, 0, tw, th)
  ctx.save()
  ctx.beginPath()
  // Ellipse légèrement plus large que le rectangle inscrit : les coins du visage restent couverts.
  ctx.ellipse(box.x + box.w / 2, box.y + box.h / 2, (box.w / 2) * 1.12, (box.h / 2) * 1.12, 0, 0, Math.PI * 2)
  ctx.clip()
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(scratch.canvas, 0, 0, tw, th, x, y, w, h)
  ctx.restore()
}

function pixelateAll(ctx: Ctx2D, scratch: Ctx2D, W: number, H: number) {
  const block = 28
  const tw = Math.ceil(W / block)
  const th = Math.ceil(H / block)
  scratch.canvas.width = tw
  scratch.canvas.height = th
  scratch.drawImage(ctx.canvas, 0, 0, W, H, 0, 0, tw, th)
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(scratch.canvas, 0, 0, tw, th, 0, 0, W, H)
  ctx.imageSmoothingEnabled = true
}

const openInput = (blob: Blob) => new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })

/** Images analysées en parallèle (autant que de détecteurs disponibles). */
const IN_FLIGHT = 3

/** Parcourt la vidéo et passe au détecteur une image toutes les `every` secondes. */
async function scan(
  blob: Blob,
  every: number,
  mode: 'analyze' | 'verify',
  detect: DetectFn,
  onProgress: (f: number) => void,
): Promise<FrameDetections[]> {
  const input = openInput(blob)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('piste vidéo introuvable')
    const duration = (await input.computeDuration()) || 1
    const W = track.displayWidth
    const H = track.displayHeight
    const canvas = makeCanvas(W, H)
    const ctx = canvas.getContext('2d') as Ctx2D
    const out: FrameDetections[] = []
    const pending = new Set<Promise<void>>()
    let last = -Infinity
    for await (const sample of new VideoSampleSink(track).samples()) {
      try {
        if (sample.timestamp - last < every - 1e-3) continue
        last = sample.timestamp
        const t = sample.timestamp
        sample.draw(ctx, 0, 0, W, H)
        const bitmap = await createImageBitmap(canvas)
        const job: Promise<void> = detect(bitmap, mode).then((boxes) => {
          out.push({ t, boxes })
          onProgress(Math.min(1, t / duration))
        })
        pending.add(job)
        void job.finally(() => pending.delete(job)).catch(() => {})
        if (pending.size >= IN_FLIGHT) await Promise.race(pending)
      } finally {
        sample.close()
      }
    }
    await Promise.all(pending)
    return out.sort((a, b) => a.t - b.t)
  } finally {
    input.dispose?.()
  }
}

/** Ré-encode la vidéo en appliquant le plan (et, au besoin, la pixelisation complète autour de `fullTimes`). */
async function render(
  raw: Blob,
  codec: VideoCodec,
  bitrate: number,
  plan: MaskPlan,
  fullTimes: number[],
  onProgress: (f: number) => void,
): Promise<{ blob: Blob; poster: Blob | null }> {
  const input = openInput(raw)
  try {
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('piste vidéo introuvable')
    const W = track.displayWidth
    const H = track.displayHeight
    const canvas = makeCanvas(W, H)
    const ctx = canvas.getContext('2d') as Ctx2D
    const scratch = makeCanvas(1, 1).getContext('2d') as Ctx2D
    let posterPromise: Promise<Blob | null> | null = null
    const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() })
    const conversion = await Conversion.init({
      input,
      output,
      video: {
        codec,
        bitrate,
        forceTranscode: true,
        processedWidth: W,
        processedHeight: H,
        process: (sample) => {
          sample.draw(ctx, 0, 0, W, H)
          const t = sample.timestamp
          if (fullTimes.some((f) => Math.abs(f - t) <= FALLBACK_WINDOW_S)) pixelateAll(ctx, scratch, W, H)
          else for (const box of plan.at(t)) pixelateEllipse(ctx, scratch, box, W, H)
          if (import.meta.env.MODE === 'e2e') renderLog.push({ t, boxes: plan.at(t).map((b) => [Math.round(b.x), Math.round(b.y), Math.round(b.w)]) })
          if (!posterPromise && t >= 0.8) posterPromise = snapshot(canvas)
          return canvas
        },
      },
      // Son : copié tel quel (déjà anonymisé si « Voix robot ») ; ré-encodé seulement si nécessaire.
      audio: {},
    })
    if (!conversion.isValid) throw new Error(`conversion impossible (${conversion.discardedTracks.map((d) => d.reason).join(', ')})`)
    if (conversion.utilizedTracks.every((t) => !t.isVideoTrack())) throw new Error('piste vidéo écartée par le convertisseur')
    conversion.onProgress = (p) => onProgress(p)
    await conversion.execute()
    const buffer = (output.target as BufferTarget).buffer
    if (!buffer) throw new Error('rendu vide')
    const poster = posterPromise ? await posterPromise : await snapshot(canvas)
    return { blob: new Blob([buffer], { type: 'video/mp4' }), poster }
  } finally {
    input.dispose?.()
  }
}

function snapshot(canvas: OffscreenCanvas | HTMLCanvasElement): Promise<Blob | null> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.8 }).catch(() => null)
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.8))
}

/** Visages nets que le contrôle trouve dans la vidéo produite. */
function residuals(checked: FrameDetections[], plan: MaskPlan): FrameDetections[] {
  return checked
    .map((f) => ({ t: f.t, boxes: f.boxes.filter((b) => (b.score ?? 1) >= VERIFY_MIN_SCORE && !covered(b, plan.at(f.t))) }))
    .filter((f) => f.boxes.length > 0)
}

export async function blurFacesInVideo(
  raw: Blob,
  detect: DetectFn,
  opts: { codec: VideoCodec; bitrate: number; onProgress?: (stage: PassStage, fraction: number) => void },
): Promise<FacePassResult> {
  const t0 = performance.now()
  const steps: Record<string, number> = {}
  let mark = t0
  const lap = (name: string) => {
    const now = performance.now()
    steps[name] = Math.round((steps[name] ?? 0) + now - mark)
    mark = now
  }
  const progress = opts.onProgress ?? (() => {})
  const analysis = await scan(raw, ANALYZE_EVERY_S, 'analyze', detect, (f) => progress('analyse', f))
  const plan = new MaskPlan(analysis)
  lap('analyse')

  let result = await render(raw, opts.codec, opts.bitrate, plan, [], (f) => progress('floutage', f))
  lap('rendu')
  let checked = await scan(result.blob, VERIFY_EVERY_S, 'verify', detect, (f) => progress('contrôle', f))
  lap('contrôle')
  let missed = residuals(checked, plan)
  let corrected = 0
  const fullTimes: number[] = []
  if (missed.length > 0) {
    // Correction : les visages trouvés rejoignent le plan (pistes, interpolation), puis nouveau rendu.
    corrected = missed.reduce((n, f) => n + f.boxes.length, 0)
    missed.forEach((f) => plan.addFrame(f))
    result = await render(raw, opts.codec, opts.bitrate, plan, [], (f) => progress('correction', f * 0.5))
    checked = await scan(result.blob, VERIFY_EVERY_S, 'verify', detect, (f) => progress('correction', 0.5 + f * 0.5))
    missed = residuals(checked, plan)
    if (missed.length > 0) {
      // Échec fermé : ce qui résiste à la correction est entièrement pixelisé.
      fullTimes.push(...missed.map((f) => f.t))
      result = await render(raw, opts.codec, opts.bitrate, plan, fullTimes, (f) => progress('correction', f))
    }
    lap('correction')
  }
  if (import.meta.env.MODE === 'e2e') (globalThis as Record<string, unknown>).__facePass = { analysis, checked, fullTimes, renderLog }
  return {
    ...result,
    report: {
      analyzed: analysis.length,
      faces: plan.trackCount,
      verified: checked.length,
      corrected,
      fullyPixelated: fullTimes,
      ms: Math.round(performance.now() - t0),
      steps,
    },
  }
}
