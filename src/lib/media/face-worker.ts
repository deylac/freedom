/**
 * Worker de détection de visages (MediaPipe Tasks, modèle BlazeFace « full range », CPU).
 *
 * - Worker CLASSIQUE (format IIFE) : le chargeur de MediaPipe utilise importScripts.
 * - Garde-fou réseau : ce contexte n'a le droit de joindre que l'origine de l'application.
 *   (MediaPipe embarque une télémétrie vers odml.pa.googleapis.com ; elle est aussi neutralisée
 *   au build par vite.config.ts. Un worker chargé depuis un fichier n'hérite pas de la CSP de la page.)
 * - Le modèle est vérifié par son SHA-256 avant usage.
 * - Ordonnancement : image entière à chaque cycle (gros visages, latence minimale) + un tiers des
 *   tuiles de 360 px par cycle (petits visages lointains rafraîchis tous les 3 cycles).
 */
import { FaceDetector, FilesetResolver } from '@mediapipe/tasks-vision'
import { mergeBoxes, tileGrid, type Box } from './faces'

export type FaceWorkerIn =
  | { type: 'init'; wasmBase: string; modelUrl: string; modelSha256: string }
  | { type: 'detect'; id: number; frame: ImageBitmap }
  /** Nouvelle source (changement de caméra) : la couverture par tuiles repart de zéro. */
  | { type: 'reset' }

export type FaceWorkerOut =
  | { type: 'ready'; ms: number }
  | { type: 'error'; message: string }
  /** `complete` : toutes les tuiles ont été analysées au moins une fois (sinon, pixeliser toute l'image). */
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

const TILE = 360
const GROUPS = 3

let detector: FaceDetector | null = null
let cycle = 0
const groupBoxes: Box[][] = Array.from({ length: GROUPS }, () => [])
let tileCanvas: OffscreenCanvas | null = null

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', data as BufferSource)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function init(msg: Extract<FaceWorkerIn, { type: 'init' }>) {
  const t0 = performance.now()
  const res = await scope.fetch(msg.modelUrl)
  if (!res.ok) throw new Error(`modèle introuvable (HTTP ${res.status})`)
  const model = new Uint8Array(await res.arrayBuffer())
  const actual = await sha256Hex(model)
  if (actual !== msg.modelSha256) throw new Error('empreinte du modèle inattendue (fichier altéré ?)')
  const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase)
  detector = await FaceDetector.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: model, delegate: 'CPU' },
    runningMode: 'IMAGE',
    // Seuil bas : pour l'anonymisation, un faux positif (zone floutée en trop) est sans gravité.
    minDetectionConfidence: 0.3,
    minSuppressionThreshold: 0.3,
  })
  scope.postMessage({ type: 'ready', ms: Math.round(performance.now() - t0) })
}

function detectIn(source: ImageBitmap | OffscreenCanvas, dx = 0, dy = 0): Box[] {
  return detector!.detect(source).detections.map((d) => {
    const b = d.boundingBox!
    return { x: b.originX + dx, y: b.originY + dy, w: b.width, h: b.height, score: d.categories[0]?.score }
  })
}

function detect(msg: Extract<FaceWorkerIn, { type: 'detect' }>) {
  const t0 = performance.now()
  const frame = msg.frame
  try {
    const whole = detectIn(frame)
    const tiles = tileGrid(frame.width, frame.height, TILE, 0.25)
    const group = cycle % GROUPS
    cycle++
    tileCanvas ??= new OffscreenCanvas(TILE, TILE)
    const ctx = tileCanvas.getContext('2d')!
    const found: Box[] = []
    tiles.forEach((t, i) => {
      if (i % GROUPS !== group) return
      if (tileCanvas!.width !== t.size) tileCanvas!.width = tileCanvas!.height = t.size
      ctx.drawImage(frame, t.x, t.y, t.size, t.size, 0, 0, t.size, t.size)
      found.push(...detectIn(tileCanvas!, t.x, t.y))
    })
    groupBoxes[group] = found
    const boxes = mergeBoxes([...whole, ...groupBoxes.flat()])
    scope.postMessage({ type: 'faces', id: msg.id, boxes, ms: Math.round(performance.now() - t0), complete: cycle >= GROUPS })
  } finally {
    frame.close()
  }
}

scope.onmessage = (event) => {
  const msg = event.data
  if (msg.type === 'init') {
    init(msg).catch((err: unknown) => scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
  } else if (msg.type === 'reset') {
    cycle = 0
    groupBoxes.fill([])
  } else if (msg.type === 'detect') {
    if (!detector) {
      msg.frame.close()
      return
    }
    try {
      detect(msg)
    } catch (err) {
      scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) })
    }
  }
}
