/**
 * Horodatage OpenTimestamps de l'empreinte SHA-256 de la vidéo.
 *
 * Choix (docs/ANGLES-MORTS.md) : on horodate le FICHIER (empreinte `x`), pas l'événement Nostr :
 * nos événements adressables sont remplacés (v1 → v2), la preuve d'un id disparu ne prouverait
 * rien ; et une preuve sur le fichier se vérifie hors ligne avec l'outil standard
 * (`ots verify video.mp4.ots`). NIP-03 (kind 1040) est d'ailleurs marqué « unrecommended ».
 *
 * Vie privée :
 *  - les calendriers ne reçoivent que sha256(empreinte ‖ nonce aléatoire) ;
 *  - une preuve reçue peut contenir n'importe quelle URL de calendrier : pour la compléter on ne
 *    contacte QUE des calendriers de la liste blanche (sinon : traceur d'adresses IP des spectateurs) ;
 *  - la vérification Bitcoin interroge deux explorateurs indépendants avec la seule hauteur de bloc.
 */
import {
  addOp,
  attestationsOf,
  bytesToHex,
  equalBytes,
  mergeTimestamp,
  newTimestamp,
  OtsError,
  parseTimestamp,
  type DetachedTimestamp,
} from './ots'

export const DEFAULT_CALENDARS = [
  'https://alice.btc.calendar.opentimestamps.org',
  'https://bob.btc.calendar.opentimestamps.org',
  'https://finney.calendar.eternitywall.com',
]
export const DEFAULT_EXPLORERS = ['https://blockstream.info/api', 'https://mempool.space/api']

const ACCEPT = 'application/vnd.opentimestamps.v1'

async function request(url: string, init: RequestInit, timeoutMs: number, fetchImpl: typeof fetch): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal, credentials: 'omit', referrerPolicy: 'no-referrer' })
  } finally {
    clearTimeout(timer)
  }
}

export interface StampOptions {
  calendars?: string[]
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

export interface StampResult {
  /** null si aucun calendrier n'a répondu. */
  file: DetachedTimestamp | null
  calendars: { url: string; ok: boolean; error?: string }[]
}

/**
 * Soumet l'empreinte aux calendriers (en parallèle). Requête « simple » au sens CORS
 * (Content-Type application/x-www-form-urlencoded) : pas de pré-vol.
 */
export async function stampDigest(digest: Uint8Array, opts: StampOptions = {}): Promise<StampResult> {
  const calendars = opts.calendars ?? DEFAULT_CALENDARS
  const fetchImpl = opts.fetchImpl ?? fetch
  const root = newTimestamp(digest)
  const nonce = crypto.getRandomValues(new Uint8Array(16))
  const commitment = addOp(addOp(root, { kind: 'append', arg: nonce }), { kind: 'sha256' })
  const results = await Promise.allSettled(
    calendars.map(async (cal) => {
      const res = await request(
        `${cal}/digest`,
        { method: 'POST', headers: { Accept: ACCEPT, 'Content-Type': 'application/x-www-form-urlencoded' }, body: commitment.msg as BodyInit },
        opts.timeoutMs ?? 8000,
        fetchImpl,
      )
      if (!res.ok) throw new OtsError(`${cal} : HTTP ${res.status}`)
      return parseTimestamp(new Uint8Array(await res.arrayBuffer()), commitment.msg)
    }),
  )
  const report: StampResult['calendars'] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      mergeTimestamp(commitment, r.value)
      report.push({ url: calendars[i], ok: true })
    } else {
      const err = r.reason
      report.push({ url: calendars[i], ok: false, error: err instanceof DOMException && err.name === 'AbortError' ? 'pas de réponse' : err instanceof Error ? err.message : String(err) })
    }
  })
  return { file: report.some((r) => r.ok) ? { hashOp: 'sha256', timestamp: root } : null, calendars: report }
}

/**
 * Complète les attestations « en attente » auprès des calendriers de la liste blanche.
 * Renvoie true si l'arbre a gagné au moins une attestation.
 */
export async function upgradeProof(file: DetachedTimestamp, opts: StampOptions = {}): Promise<boolean> {
  const allowed = new Set((opts.calendars ?? DEFAULT_CALENDARS).map((c) => c.replace(/\/+$/, '')))
  const fetchImpl = opts.fetchImpl ?? fetch
  const pending = attestationsOf(file.timestamp).filter(
    (a) => a.attestation.kind === 'pending' && allowed.has(a.attestation.uri.replace(/\/+$/, '')),
  )
  const before = attestationsOf(file.timestamp).length
  await Promise.allSettled(
    pending.map(async ({ node, attestation }) => {
      if (attestation.kind !== 'pending') return
      const res = await request(
        `${attestation.uri.replace(/\/+$/, '')}/timestamp/${bytesToHex(node.msg)}`,
        { headers: { Accept: ACCEPT } },
        opts.timeoutMs ?? 8000,
        fetchImpl,
      )
      if (!res.ok) return // 404 : pas encore ancré dans Bitcoin
      mergeTimestamp(node, parseTimestamp(new Uint8Array(await res.arrayBuffer()), node.msg))
    }),
  )
  return attestationsOf(file.timestamp).length > before
}

// ---------------------------------------------------------------------------
// Vérification

export type ProofStatus =
  | { state: 'invalid'; reason: string }
  | { state: 'pending'; calendars: string[] }
  | { state: 'verified'; height: number; time: number; sources: string[] }
  | { state: 'unverifiable'; height: number; reason: string }

interface BlockInfo {
  merkleRoot: string
  time: number
}

async function blockFrom(api: string, height: number, fetchImpl: typeof fetch): Promise<BlockInfo> {
  const hashRes = await request(`${api}/block-height/${height}`, {}, 8000, fetchImpl)
  if (!hashRes.ok) throw new Error(`HTTP ${hashRes.status}`)
  const hash = (await hashRes.text()).trim()
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error('hash de bloc invalide')
  const blockRes = await request(`${api}/block/${hash}`, { headers: { Accept: 'application/json' } }, 8000, fetchImpl)
  if (!blockRes.ok) throw new Error(`HTTP ${blockRes.status}`)
  const block = (await blockRes.json()) as { merkle_root?: string; timestamp?: number }
  if (!block.merkle_root || !block.timestamp) throw new Error('réponse incomplète')
  return { merkleRoot: block.merkle_root.toLowerCase(), time: block.timestamp }
}

export interface VerifyOptions extends StampOptions {
  explorers?: string[]
}

/**
 * Vérifie qu'une preuve porte sur `digest` (empreinte du fichier) et, si elle contient une
 * attestation Bitcoin, que le message attesté est bien la racine de Merkle du bloc — confirmée
 * par tous les explorateurs qui répondent (un explorateur menteur ne suffit pas à tromper).
 * Piège classique : la racine affichée par les explorateurs est en ordre d'octets inversé.
 */
export async function verifyProof(file: DetachedTimestamp, digest: Uint8Array, opts: VerifyOptions = {}): Promise<ProofStatus> {
  if (file.hashOp !== 'sha256' || !equalBytes(file.timestamp.msg, digest)) {
    return { state: 'invalid', reason: 'la preuve porte sur un autre fichier' }
  }
  const atts = attestationsOf(file.timestamp)
  const bitcoin = atts
    .filter((a) => a.attestation.kind === 'bitcoin')
    .sort((a, b) => (a.attestation.kind === 'bitcoin' && b.attestation.kind === 'bitcoin' ? a.attestation.height - b.attestation.height : 0))
  if (bitcoin.length === 0) {
    const calendars = atts.flatMap((a) => (a.attestation.kind === 'pending' ? [a.attestation.uri] : []))
    return calendars.length ? { state: 'pending', calendars } : { state: 'invalid', reason: 'aucune attestation exploitable' }
  }
  const fetchImpl = opts.fetchImpl ?? fetch
  const explorers = opts.explorers ?? DEFAULT_EXPLORERS
  const { msg, attestation } = bitcoin[0]
  if (attestation.kind !== 'bitcoin') throw new Error('inattendu')
  if (msg.length !== 32) return { state: 'invalid', reason: 'attestation Bitcoin mal formée' }
  const expected = bytesToHex(msg.slice().reverse())
  const answers = await Promise.allSettled(explorers.map((api) => blockFrom(api, attestation.height, fetchImpl)))
  const ok = answers
    .map((a, i) => (a.status === 'fulfilled' ? { api: explorers[i], block: a.value } : null))
    .filter((a): a is { api: string; block: BlockInfo } => a !== null)
  if (ok.length === 0) return { state: 'unverifiable', height: attestation.height, reason: 'explorateurs Bitcoin injoignables' }
  if (ok.some((a) => a.block.merkleRoot !== expected)) {
    return { state: 'invalid', reason: `la racine de Merkle du bloc ${attestation.height} ne correspond pas` }
  }
  return { state: 'verified', height: attestation.height, time: Math.min(...ok.map((a) => a.block.time)), sources: ok.map((a) => new URL(a.api).host) }
}
