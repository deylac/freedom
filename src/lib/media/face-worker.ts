/**
 * Worker de détection de visages : YuNet (OpenCV Zoo, licence MIT) exécuté par ONNX Runtime Web
 * (WebAssembly, CPU, un fil). Remplace BlazeFace/MediaPipe depuis le 2 nov. (test réel : fausses
 * alertes, petits visages de foule mal détectés ; YuNet est entraîné sur des foules, WIDER FACE).
 *
 * - Garde-fou réseau : ce contexte n'a le droit de joindre que l'origine de l'application
 *   (modèle et moteur WebAssembly sont servis par le site lui-même, jamais par un CDN).
 * - Le modèle est vérifié par son SHA-256 avant usage.
 * - Entrée fixe 640 × 640 : `live` analyse l'image entière réduite ; `analyze` y ajoute des carrés
 *   (petits visages) ; `verify` utilise des carrés décalés (autres cadrages).
 */
import * as ort from 'onnxruntime-web/wasm'
import type { Box } from './faces'
import { decode, mapBack, nms, squarePlacements, toBgrPlanar, wholePlacement, YUNET_SIZE, type Placement } from './yunet'

export type FaceWorkerIn =
  | { type: 'init'; wasmBase: string; modelUrl: string; modelSha256: string }
  /**
   * `live` (défaut) : image entière (aperçu en direct, latence minimale).
   * `analyze` : second passage, image entière + carrés (petits visages).
   * `verify` : contrôle du rendu final, image entière + carrés décalés.
   */
  | { type: 'detect'; id: number; frame: ImageBitmap; mode?: 'live' | 'analyze' | 'verify' }
  /** Nouvelle source (changement de caméra). */
  | { type: 'reset' }

export type FaceWorkerOut =
  | { type: 'ready'; ms: number }
  | { type: 'error'; message: string }
  /** `complete` : toute l'image a été analysée (sinon, pixeliser toute l'image). */
  | { type: 'faces'; id: number; boxes: Box[]; ms: number; complete: boolean }

interface WorkerScope {
  location: Location
  fetch: typeof fetch
  XMLHttpRequest: typeof XMLHttpRequest
  postMessage(message: FaceWorkerOut, transfer?: Transferable[]): void
  onmessage: ((event: MessageEvent<FaceWorkerIn>) => void) | null
}
const scope = self as unknown as WorkerScope

// ---------------------------------------------------------------------------
// Garde-fou réseau

const sameOrigin = (raw: string | URL) => new URL(String(raw), scope.location.href).origin === scope.location.origin
const realFetch = scope.fetch.bind(scope)
scope.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' || input instanceof URL ? input : input.url
  if (!sameOrigin(url)) return Promise.reject(new TypeError('Requête hors origine bloquée par HashWall'))
  return realFetch(input, init)
}
const realOpen = scope.XMLHttpRequest.prototype.open
scope.XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  if (!sameOrigin(url)) throw new TypeError('Requête hors origine bloquée par HashWall')
  return (realOpen as (...a: unknown[]) => void).call(this, method, url, ...rest)
} as typeof XMLHttpRequest.prototype.open

// ---------------------------------------------------------------------------

/** Score minimal transmis (le tri fin se fait côté page selon l'usage). */
const MIN_SCORE = 0.5

let session: ort.InferenceSession | null = null
let canvas: OffscreenCanvas | null = null
/** ONNX Runtime n'accepte qu'une exécution à la fois par session : file d'attente. */
let queue: Promise<unknown> = Promise.resolve()

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function init(msg: Extract<FaceWorkerIn, { type: 'init' }>) {
  const t0 = performance.now()
  if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas indisponible (iOS 16 ou antérieur)')
  const res = await scope.fetch(msg.modelUrl)
  if (!res.ok) throw new Error(`modèle introuvable (HTTP ${res.status})`)
  const model = new Uint8Array(await res.arrayBuffer())
  const actual = await sha256Hex(model)
  if (actual !== msg.modelSha256) throw new Error('empreinte du modèle inattendue (fichier altéré ?)')
  ort.env.wasm.wasmPaths = msg.wasmBase.endsWith('/') ? msg.wasmBase : `${msg.wasmBase}/`
  // Pas d'isolation d'origine sur GitHub Pages : un seul fil (on parallélise avec plusieurs workers).
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
  session = await ort.InferenceSession.create(model, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' })
  canvas = new OffscreenCanvas(YUNET_SIZE, YUNET_SIZE)
  scope.postMessage({ type: 'ready', ms: Math.round(performance.now() - t0) })
}

async function run(frame: ImageBitmap, p: Placement): Promise<Box[]> {
  const ctx = canvas!.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, YUNET_SIZE, YUNET_SIZE)
  ctx.drawImage(frame, p.sx, p.sy, p.sw, p.sh, 0, 0, p.sw * p.scale, p.sh * p.scale)
  const pixels = ctx.getImageData(0, 0, YUNET_SIZE, YUNET_SIZE).data
  const input = new ort.Tensor('float32', toBgrPlanar(pixels), [1, 3, YUNET_SIZE, YUNET_SIZE])
  const out = await session!.run({ [session!.inputNames[0]]: input })
  const boxes = nms(decode(out as unknown as Record<string, { data: Float32Array }>, MIN_SCORE))
  // Boîtes coupées par le bord d'un carré (hors image entière) : gardées, la NMS globale arbitre.
  return boxes.map((b) => mapBack(b, p))
}

async function detect(msg: Extract<FaceWorkerIn, { type: 'detect' }>) {
  const t0 = performance.now()
  const frame = msg.frame
  const mode = msg.mode ?? 'live'
  try {
    const W = frame.width
    const H = frame.height
    const placements = [
      wholePlacement(W, H),
      ...(mode === 'analyze' ? squarePlacements(W, H) : mode === 'verify' ? squarePlacements(W, H, Math.round(Math.min(W, H) / 4)) : []),
    ]
    const found: Box[] = []
    for (const p of placements) found.push(...(await run(frame, p)))
    scope.postMessage({ type: 'faces', id: msg.id, boxes: nms(found, 0.3), ms: Math.round(performance.now() - t0), complete: true })
  } finally {
    frame.close()
  }
}

scope.onmessage = (event) => {
  const msg = event.data
  if (msg.type === 'init') {
    init(msg).catch((err: unknown) => scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
  } else if (msg.type === 'reset') {
    // Aucun état entre images : rien à oublier.
  } else if (msg.type === 'detect') {
    if (!session) {
      msg.frame.close()
      return
    }
    queue = queue
      .then(() => detect(msg))
      .catch((err: unknown) => scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
  }
}
