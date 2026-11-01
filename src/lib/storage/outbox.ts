/**
 * File d'envoi persistante (IndexedDB).
 *
 * Angle mort traité : en manifestation, la bande montante s'effondre. Sans persistance, une
 * coupure réseau ou une fermeture d'onglet pendant l'envoi fait perdre la vidéo. Chaque clip
 * enregistré est d'abord écrit ici, puis repris automatiquement au prochain lancement.
 * Les octets sont effacés dès que la publication est terminée (données sensibles en cas de
 * saisie du téléphone).
 */
import { isSharedOriginGateway } from './local'

export interface BlobInfo {
  sha256: string
  mime: string
  ext: string
  size: number
}

export interface OutboxJob {
  id: string
  createdAt: number
  tag: string
  caption: string
  contentWarning?: string
  video: BlobInfo & { duration: number; width: number; height: number; bitrate: number }
  poster?: BlobInfo
  videoBlob?: Blob
  posterBlob?: Blob
  signer: { type: 'local'; sk: string; pubkey: string } | { type: 'extension'; pubkey: string }
  state: 'pending' | 'uploaded' | 'published' | 'done' | 'failed'
  primary?: { server: string; url: string }
  posterUrl?: string
  /** Serveurs hébergeant la vidéo (primaire + miroirs), pour les fallback et la suppression. */
  servers: string[]
  mirrors: string[]
  posterMirrors: string[]
  publishedAt?: number
  eventId?: string
  eventCreatedAt?: number
  lastError?: string
  attempts: number
  timings: { recordedAt: number; uploadedAt?: number; publishedAt?: number; mirroredAt?: number }
}

const DB_NAME = 'hashwall'
const STORE = 'outbox'

const memory = new Map<string, OutboxJob>()
let dbPromise: Promise<IDBDatabase | null> | null = null

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined' || isSharedOriginGateway()) return resolve(null)
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return openDb().then(
    (db) =>
      new Promise<T | undefined>((resolve) => {
        if (!db) return resolve(undefined)
        try {
          const t = db.transaction(STORE, mode)
          const req = run(t.objectStore(STORE))
          req.onsuccess = () => resolve(req.result)
          req.onerror = () => resolve(undefined)
        } catch {
          resolve(undefined)
        }
      }),
  )
}

export async function putJob(job: OutboxJob): Promise<void> {
  memory.set(job.id, job)
  await tx('readwrite', (s) => s.put(job))
}

export async function getJob(id: string): Promise<OutboxJob | undefined> {
  return memory.get(id) ?? (await tx<OutboxJob>('readonly', (s) => s.get(id)))
}

export async function listJobs(): Promise<OutboxJob[]> {
  const stored = (await tx<OutboxJob[]>('readonly', (s) => s.getAll())) ?? []
  const byId = new Map(stored.map((j) => [j.id, j]))
  memory.forEach((j, id) => byId.set(id, j))
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
}

export async function deleteJob(id: string): Promise<void> {
  memory.delete(id)
  await tx('readwrite', (s) => s.delete(id))
}

export async function wipeOutbox(): Promise<void> {
  memory.clear()
  const db = await openDb()
  db?.close()
  dbPromise = null
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(DB_NAME)
      req.onsuccess = req.onerror = req.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}
