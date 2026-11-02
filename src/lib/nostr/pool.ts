/**
 * Module 1 — Pool de relais WebSocket.
 *
 * nostr-tools reconnecte un relais qui tombe APRÈS une première connexion réussie, mais
 * abandonne définitivement un relais injoignable au premier essai. Sur mobile (4G saturée,
 * changement d'antenne, onglet en arrière-plan) c'est le cas normal : LiveSubscription
 * supervise donc chaque relais individuellement et le ré-abonne avec un backoff.
 */
import type { Filter } from 'nostr-tools/filter'
import { SimplePool, type SubCloser } from 'nostr-tools/pool'
import type { NostrEvent } from 'nostr-tools/pure'
import { normalizeRelay } from '../blossom/urls'
import { readerSigner, type Signer } from './signer'

export const pool = new SimplePool({ enablePing: true, enableReconnect: true })
pool.trackRelays = true

export function normalizeRelays(relays: string[]): string[] {
  return [...new Set(relays.map(normalizeRelay).filter((r): r is string => !!r))]
}

export function connectionStatus(relays: string[]): { connected: number; total: number; perRelay: Record<string, boolean> } {
  const status = pool.listConnectionStatus()
  const perRelay: Record<string, boolean> = {}
  for (const r of relays) {
    const url = r.endsWith('/') ? r : `${r}/`
    perRelay[r] = status.get(url) ?? status.get(r) ?? false
  }
  return { connected: Object.values(perRelay).filter(Boolean).length, total: relays.length, perRelay }
}

// ---------------------------------------------------------------------------
// Lecture répartie (montée en charge)

/**
 * Nombre de relais LUS par visiteur. On publie sur tous les relais configurés (16 par défaut), mais
 * chaque visiteur n'en lit qu'un sous-ensemble tiré au hasard : avec 10 000 visiteurs, chaque relais
 * reçoit ~10 000 × 6 / 16 ≈ 3 750 connexions au lieu de 10 000 (et chaque vidéo reste lisible tant
 * qu'au moins un relais lu l'a reçue — elle est publiée partout).
 */
export const READ_RELAYS = 6

/** Mélange déterministe (graine) : même sous-ensemble pendant toute la visite. */
export function sampleRelays(relays: string[], n: number, seed: number): string[] {
  const list = normalizeRelays(relays)
  if (list.length <= n) return list
  let x = seed >>> 0 || 1
  const rand = () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 4294967296
  }
  const shuffled = [...list]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  return shuffled.slice(0, n)
}

let sessionSeed: number | null = null
/** Graine propre à l'onglet (sessionStorage) : répartit les visiteurs sans rien envoyer à personne. */
export function visitSeed(): number {
  if (sessionSeed !== null) return sessionSeed
  try {
    const stored = Number(sessionStorage.getItem('hw:seed'))
    if (stored > 0) return (sessionSeed = stored)
    sessionSeed = 1 + Math.floor(Math.random() * 0xfffffffe)
    sessionStorage.setItem('hw:seed', String(sessionSeed))
  } catch {
    sessionSeed = 1 + Math.floor(Math.random() * 0xfffffffe)
  }
  return sessionSeed
}

/** Relais à LIRE pour cette visite (les publications vont toujours à tous). */
export const readRelays = (relays: string[], n = READ_RELAYS): string[] => sampleRelays(relays, n, visitSeed())

/** Relais sur lesquels un événement a été vu (indicateur de résilience). */
export function seenOn(eventId: string): string[] {
  return [...(pool.seenOn.get(eventId) ?? [])].map((r) => r.url)
}

// ---------------------------------------------------------------------------
// Publication

export interface PublishResult {
  ok: string[]
  failed: { relay: string; reason: string }[]
}

/**
 * Publie sur tous les relais. `first` se résout au premier accusé OK (temps-réel pour le mur),
 * `all` quand tous les relais ont répondu. Rejette si aucun relais n'accepte.
 */
export function publishEvent(
  relays: string[],
  event: NostrEvent,
  signer: Signer,
  timeoutMs = 10_000,
): { first: Promise<string>; all: Promise<PublishResult> } {
  const urls = normalizeRelays(relays)
  const result: PublishResult = { ok: [], failed: [] }
  let resolveFirst!: (relay: string) => void
  let rejectFirst!: (err: Error) => void
  const first = new Promise<string>((res, rej) => {
    resolveFirst = res
    rejectFirst = rej
  })
  const promises = pool.publish(urls, event, { onauth: (t) => signer.sign(t), maxWait: timeoutMs })
  const tracked = promises.map((p, i) =>
    Promise.race([
      p,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error('délai dépassé')), timeoutMs + 2000)),
    ]).then(
      () => {
        result.ok.push(urls[i])
        resolveFirst(urls[i])
      },
      (err: unknown) => {
        result.failed.push({ relay: urls[i], reason: err instanceof Error ? err.message : String(err) })
      },
    ),
  )
  const all = Promise.all(tracked).then(() => {
    if (result.ok.length === 0) {
      const err = new Error(`Aucun relais n'a accepté l'événement (${result.failed.map((f) => f.reason).join(' ; ')})`)
      rejectFirst(err)
      throw err
    }
    return result
  })
  all.catch(() => {})
  first.catch(() => {})
  return { first, all }
}

// ---------------------------------------------------------------------------
// Abonnement supervisé

export interface LiveSubscriptionOptions {
  relays: string[]
  filters: Filter[]
  onevent: (event: NostrEvent) => void
  /** Appelé une fois quand tous les relais ont fini l'historique (ou abandonné). */
  oneose?: () => void
  eoseTimeoutMs?: number
  label?: string
}

const BACKOFF_MS = [1_000, 3_000, 8_000, 20_000, 45_000, 90_000]

export class LiveSubscription {
  private readonly relays: string[]
  private closers = new Map<string, SubCloser>()
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private attempts = new Map<string, number>()
  private settled = new Set<string>()
  private eoseFired = false
  private stopped = false
  private eoseTimer?: ReturnType<typeof setTimeout>

  constructor(private readonly opts: LiveSubscriptionOptions) {
    this.relays = normalizeRelays(opts.relays)
  }

  start(): this {
    for (const url of this.relays) this.open(url)
    this.eoseTimer = setTimeout(() => this.fireEose(), (this.opts.eoseTimeoutMs ?? 6000) + 1000)
    if (this.relays.length === 0) this.fireEose()
    return this
  }

  /** Relance immédiatement les relais en attente (retour réseau, onglet de nouveau visible). */
  kick(): void {
    for (const [url, timer] of this.retryTimers) {
      clearTimeout(timer)
      this.retryTimers.delete(url)
      this.open(url)
    }
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.eoseTimer)
    this.retryTimers.forEach((t) => clearTimeout(t))
    this.retryTimers.clear()
    this.closers.forEach((c) => c.close('fermé par le client'))
    this.closers.clear()
  }

  private fireEose() {
    if (this.eoseFired) return
    this.eoseFired = true
    this.opts.oneose?.()
  }

  private markSettled(url: string) {
    this.settled.add(url)
    if (this.settled.size >= this.relays.length) this.fireEose()
  }

  private open(url: string) {
    if (this.stopped) return
    const reader = readerSigner()
    const closer = pool.subscribeMap(
      this.opts.filters.map((filter) => ({ url, filter })),
      {
        label: this.opts.label,
        maxWait: this.opts.eoseTimeoutMs ?? 6000,
        onevent: (event) => {
          this.attempts.set(url, 0)
          this.opts.onevent(event)
        },
        oneose: () => {
          this.attempts.set(url, 0)
          this.markSettled(url)
        },
        onclose: () => {
          this.closers.delete(url)
          this.markSettled(url)
          this.scheduleRetry(url)
        },
        onauth: (template) => reader.sign(template),
      },
    )
    this.closers.set(url, closer)
  }

  private scheduleRetry(url: string) {
    if (this.stopped || this.retryTimers.has(url)) return
    const attempt = this.attempts.get(url) ?? 0
    this.attempts.set(url, attempt + 1)
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]
    this.retryTimers.set(
      url,
      setTimeout(() => {
        this.retryTimers.delete(url)
        this.open(url)
      }, delay),
    )
  }
}

/** Requête ponctuelle (historique) avec délai maximal. */
export function queryOnce(relays: string[], filter: Filter, maxWait = 5000): Promise<NostrEvent[]> {
  return pool.querySync(normalizeRelays(relays), filter, { maxWait })
}
