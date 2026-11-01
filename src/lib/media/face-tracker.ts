/**
 * Pilote, côté page, du worker de détection de visages (FR-08).
 *
 * ÉCHEC FERMÉ : tant que le détecteur n'a pas analysé toute l'image au moins une fois, s'il est en
 * cours de chargement, en erreur, ou si ses résultats datent de plus de 2,5 s, `trusted` est faux et
 * l'enregistreur pixelise l'image ENTIÈRE.
 */
import type { Box } from './faces'
import type { FaceWorkerIn, FaceWorkerOut } from './face-worker'

/** Empreinte de public/models/blaze_face_full_range.tflite (voir public/models/SHA256SUMS). */
export const FACE_MODEL_SHA256 = '3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b'
export const FACE_MODEL_PATH = './models/blaze_face_full_range.tflite'
export const MEDIAPIPE_WASM_PATH = './mediapipe'

const STALE_MS = 2500
const PERSIST_MS = 1200

export type TrackerState = 'loading' | 'ready' | 'error'

export class FaceTracker {
  state: TrackerState = 'loading'
  error?: string
  loadMs?: number
  lastDetectionMs?: number
  private worker: Worker
  private busy = false
  private sentAt = 0
  private complete = false
  private nextId = 1
  private lastResultAt = 0
  private history: { at: number; boxes: Box[] }[] = []
  private scratch: HTMLCanvasElement

  constructor(base = document.baseURI) {
    this.scratch = document.createElement('canvas')
    this.worker = new Worker(new URL('./face-worker.ts', import.meta.url))
    this.worker.onmessage = (e: MessageEvent<FaceWorkerOut>) => this.onMessage(e.data)
    this.worker.onerror = (e) => {
      this.state = 'error'
      this.error = e.message || 'erreur du worker'
    }
    const init: FaceWorkerIn = {
      type: 'init',
      wasmBase: new URL(MEDIAPIPE_WASM_PATH, base).href,
      modelUrl: new URL(FACE_MODEL_PATH, base).href,
      modelSha256: FACE_MODEL_SHA256,
    }
    this.worker.postMessage(init)
  }

  private onMessage(msg: FaceWorkerOut) {
    if (msg.type === 'ready') {
      this.state = 'ready'
      this.loadMs = msg.ms
    } else if (msg.type === 'error') {
      this.state = 'error'
      this.error = msg.message
      this.busy = false
    } else if (msg.type === 'faces') {
      const now = performance.now()
      this.busy = false
      this.complete = msg.complete
      this.lastResultAt = now
      this.lastDetectionMs = msg.ms
      this.history = [...this.history.filter((h) => now - h.at < PERSIST_MS), { at: now, boxes: msg.boxes }]
    }
  }

  /** Le détecteur couvre l'image et ses résultats sont récents : on peut ne flouter que les visages. */
  get trusted(): boolean {
    return this.state === 'ready' && this.complete && performance.now() - this.lastResultAt < STALE_MS
  }

  /** Visages détectés récemment (persistance pour ne jamais « clignoter » à découvert). */
  get faces(): Box[] {
    const now = performance.now()
    return this.history.filter((h) => now - h.at < PERSIST_MS).flatMap((h) => h.boxes)
  }

  get count(): number {
    return this.history.at(-1)?.boxes.length ?? 0
  }

  /**
   * Envoie l'image brute courante (avant tout filtre) au worker si celui-ci est libre.
   * Copie dans un canvas dédié : l'image envoyée ne peut pas contenir la pixelisation appliquée ensuite.
   */
  feed(source: CanvasImageSource, width: number, height: number) {
    if (this.state !== 'ready') return
    // Réponse perdue (worker gelé) : on renvoie une image au bout de 5 s ; entre-temps `trusted` est faux.
    if (this.busy && performance.now() - this.sentAt < 5000) return
    this.busy = true
    this.sentAt = performance.now()
    if (this.scratch.width !== width || this.scratch.height !== height) {
      this.scratch.width = width
      this.scratch.height = height
    }
    this.scratch.getContext('2d')!.drawImage(source, 0, 0, width, height)
    createImageBitmap(this.scratch)
      .then((frame) => {
        const msg: FaceWorkerIn = { type: 'detect', id: this.nextId++, frame }
        this.worker.postMessage(msg, [frame])
      })
      .catch(() => {
        this.busy = false
      })
  }

  close() {
    this.worker.terminate()
  }
}
