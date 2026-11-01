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

/** Résultat d'une étape sur un serveur : rend visibles les refus même quand l'envoi a réussi ailleurs. */
export interface Diagnostic {
  server: string
  step: 'envoi' | 'miroir' | 'horodatage'
  ok: boolean
  detail: string
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
  diagnostics?: Diagnostic[]
  /** Preuve OpenTimestamps (base64) de l'empreinte de la vidéo. */
  ots?: string
  timings: { recordedAt: number; uploadedAt?: number; publishedAt?: number; mirroredAt?: number }
}

const DB_NAME = 'hashwall'
const STORE = 'outbox'

const memory = new Map<string, OutboxJob>()
/** Tâches dont la dernière écriture est confirmée sur disque (transaction terminée). */
const durable = new Set<string>()
let dbPromise: Promise<IDBDatabase | null> | null = null
/** Effacement demandé (ici ou dans un autre onglet) : plus aucune écriture ne doit recréer la base. */
let wiped = false
const wipeListeners = new Set<() => void>()

// Coordination entre onglets : un effacement dans un onglet arrête les écritures des autres.
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('hashwall-outbox') : null
if (channel) {
  channel.onmessage = (e: MessageEvent) => {
    if (e.data !== 'wipe') return
    wiped = true
    memory.clear()
    durable.clear()
    void closeDb()
    wipeListeners.forEach((l) => l())
  }
}

/** Appelé quand un AUTRE onglet efface les données (l'appelant doit arrêter ses envois et recharger). */
export function onRemoteWipe(listener: () => void): () => void {
  wipeListeners.add(listener)
  return () => wipeListeners.delete(listener)
}

async function closeDb() {
  const p = dbPromise
  dbPromise = null
  const db = await p?.catch(() => null)
  db?.close()
}

function openDb(): Promise<IDBDatabase | null> {
  if (wiped) return Promise.resolve(null)
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined' || isSharedOriginGateway()) return resolve(null)
    try {
      const req = indexedDB.open(DB_NAME, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
      req.onsuccess = () => {
        const db = req.result
        // Un autre onglet supprime ou met à niveau la base : on libère la connexion (audit F03).
        db.onversionchange = () => {
          db.close()
          dbPromise = null
        }
        resolve(db)
      }
      req.onerror = () => resolve(null)
      req.onblocked = () => resolve(null)
    } catch {
      resolve(null)
    }
  })
  return dbPromise
}

/**
 * Transaction complète : on attend `oncomplete` (une requête réussie peut encore être annulée,
 * quota compris) et on REJETTE sur erreur ou annulation (audit F06). `null` : pas de base.
 */
function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<{ value: T } | null> {
  return openDb().then(
    (db) =>
      new Promise<{ value: T } | null>((resolve, reject) => {
        if (!db) return resolve(null)
        let t: IDBTransaction
        let req: IDBRequest<T>
        try {
          t = db.transaction(STORE, mode)
          req = run(t.objectStore(STORE))
        } catch (err) {
          return reject(err)
        }
        t.oncomplete = () => resolve({ value: req.result })
        t.onerror = () => reject(t.error ?? req.error ?? new Error('erreur IndexedDB'))
        t.onabort = () => reject(t.error ?? new Error('transaction IndexedDB annulée'))
      }),
  )
}

export type Persistence = 'durable' | 'memory'

/**
 * Enregistre la tâche. Résultat explicite : `memory` signifie que la vidéo DISPARAÎTRA au
 * rechargement (quota, navigation privée, passerelle partagée, effacement en cours).
 */
export async function putJob(job: OutboxJob): Promise<Persistence> {
  memory.set(job.id, job)
  try {
    const done = await tx('readwrite', (s) => s.put(job))
    if (done) {
      durable.add(job.id)
      return 'durable'
    }
  } catch (err) {
    console.warn('[HashWall] écriture de la file d’envoi impossible :', err)
  }
  durable.delete(job.id)
  return 'memory'
}

export const isDurable = (id: string): boolean => durable.has(id)

export async function getJob(id: string): Promise<OutboxJob | undefined> {
  if (memory.has(id)) return memory.get(id)
  const r = await tx<OutboxJob>('readonly', (s) => s.get(id)).catch(() => null)
  if (r?.value) durable.add(id)
  return r?.value
}

export async function listJobs(): Promise<OutboxJob[]> {
  const stored = (await tx<OutboxJob[]>('readonly', (s) => s.getAll()).catch(() => null))?.value ?? []
  stored.forEach((j) => durable.add(j.id))
  const byId = new Map(stored.map((j) => [j.id, j]))
  memory.forEach((j, id) => byId.set(id, j))
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt)
}

export async function deleteJob(id: string): Promise<void> {
  memory.delete(id)
  durable.delete(id)
  await tx('readwrite', (s) => s.delete(id)).catch(() => null)
}

/**
 * Efface la base. Ne se résout QUE sur succès réel (audit F03) : rejet si la suppression échoue
 * ou reste bloquée (un onglet qui garde la base ouverte) au-delà de `timeoutMs`.
 */
export async function wipeOutbox(timeoutMs = 5000): Promise<void> {
  wiped = true
  memory.clear()
  durable.clear()
  channel?.postMessage('wipe')
  await closeDb()
  if (typeof indexedDB === 'undefined' || isSharedOriginGateway()) return
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    let req: IDBOpenDBRequest
    try {
      req = indexedDB.deleteDatabase(DB_NAME)
    } catch (err) {
      return reject(err)
    }
    req.onsuccess = () => {
      clearTimeout(timer)
      resolve()
    }
    req.onerror = () => {
      clearTimeout(timer)
      reject(req.error ?? new Error('suppression de la base impossible'))
    }
    req.onblocked = () => {
      timer ??= setTimeout(() => reject(new Error('suppression bloquée par un autre onglet de HashWall : fermez-le puis réessayez')), timeoutMs)
    }
  })
}
