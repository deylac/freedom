/**
 * Pilote, côté page, du worker de détection de visages (FR-08).
 *
 * ÉCHEC FERMÉ : tant que le détecteur n'a pas analysé toute l'image au moins une fois, s'il est en
 * cours de chargement, en erreur, ou si l'image analysée a été capturée il y a plus de
 * FACE_TRUST_MS, `trusted` est faux et l'enregistreur pixelise l'image ENTIÈRE. Masques et confiance
 * expirent ensemble (voir face-history.ts, audit F01).
 */
import type { Box } from './faces'
import { FaceHistory } from './face-history'
import type { FaceWorkerIn, FaceWorkerOut } from './face-worker'

/** Empreinte de public/models/blaze_face_full_range.tflite (voir public/models/SHA256SUMS). */
export const FACE_MODEL_SHA256 = '3698b18f063835bc609069ef052228fbe86d9c9a6dc8dcb7c7c2d69aed2b181b'
export const FACE_MODEL_PATH = './models/blaze_face_full_range.tflite'
export const MEDIAPIPE_WASM_PATH = './mediapipe'

export type TrackerState = 'loading' | 'ready' | 'error'

export class FaceTracker {
  state: TrackerState = 'loading'
  error?: string
  loadMs?: number
  lastDetectionMs?: number
  private worker: Worker
  private busy = false
  private sentAt = 0
  private nextId = 1
  private history = new FaceHistory()
  private requests = new Map<number, { resolve: (boxes: Box[]) => void; reject: (err: Error) => void }>()
  private readyWaiters: { resolve: () => void; reject: (err: Error) => void }[] = []
  /** Pas d'analyse en direct pendant le second passage (le worker lui est réservé). */
  livePaused = false
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
      this.readyWaiters.forEach((w) => w.resolve())
      this.readyWaiters = []
    } else if (msg.type === 'error') {
      this.state = 'error'
      this.error = msg.message
      this.busy = false
      this.requests.forEach((r) => r.reject(new Error(msg.message)))
      this.requests.clear()
      this.readyWaiters.forEach((w) => w.reject(new Error(msg.message)))
      this.readyWaiters = []
    } else if (msg.type === 'faces') {
      const pending = this.requests.get(msg.id)
      if (pending) {
        this.requests.delete(msg.id)
        pending.resolve(msg.boxes)
        return
      }
      this.busy = false
      this.lastDetectionMs = msg.ms
      this.history.receive(msg.id, msg.boxes, msg.complete, performance.now())
    }
  }

  /** Le détecteur couvre l'image et ses résultats sont récents : on peut ne flouter que les visages. */
  get trusted(): boolean {
    return this.state === 'ready' && this.history.trusted(performance.now())
  }

  /** Visages détectés récemment (persistance pour ne jamais « clignoter » à découvert). */
  get faces(): Box[] {
    return this.history.faces(performance.now())
  }

  get count(): number {
    return this.history.count
  }

  /** Changement de caméra : les analyses de l'ancienne image ne valent plus rien. */
  reset() {
    this.history.reset(this.nextId)
    this.busy = false
    const msg: FaceWorkerIn = { type: 'reset' }
    this.worker.postMessage(msg)
  }

  /**
   * Envoie l'image brute courante (avant tout filtre) au worker si celui-ci est libre.
   * Copie dans un canvas dédié : l'image envoyée ne peut pas contenir la pixelisation appliquée ensuite.
   */
  feed(source: CanvasImageSource, width: number, height: number) {
    if (this.state !== 'ready' || this.livePaused) return
    // Réponse perdue (worker gelé) : on renvoie une image au bout de 5 s ; entre-temps `trusted` est faux.
    if (this.busy && performance.now() - this.sentAt < 5000) return
    this.busy = true
    this.sentAt = performance.now()
    if (this.scratch.width !== width || this.scratch.height !== height) {
      this.scratch.width = width
      this.scratch.height = height
    }
    this.scratch.getContext('2d')!.drawImage(source, 0, 0, width, height)
    const id = this.nextId++
    this.history.sent(id, this.sentAt)
    createImageBitmap(this.scratch)
      .then((frame) => {
        const msg: FaceWorkerIn = { type: 'detect', id, frame }
        this.worker.postMessage(msg, [frame])
      })
      .catch(() => {
        this.busy = false
      })
  }

  /** Attend le chargement du détecteur (rejet en cas d'erreur ou au-delà de `timeoutMs`). */
  ready(timeoutMs = 60_000): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    if (this.state === 'error') return Promise.reject(new Error(this.error ?? 'détecteur indisponible'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('chargement du détecteur trop long')), timeoutMs)
      this.readyWaiters.push({
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
    })
  }

  /** Analyse d'une image du second passage (l'image est transférée au worker). */
  detect(frame: ImageBitmap, mode: 'analyze' | 'verify'): Promise<Box[]> {
    if (this.state !== 'ready') return Promise.reject(new Error('détecteur non prêt'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.requests.set(id, { resolve, reject })
      const msg: FaceWorkerIn = { type: 'detect', id, frame, mode }
      this.worker.postMessage(msg, [frame])
    })
  }

  close() {
    this.worker.terminate()
  }
}
