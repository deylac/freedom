/**
 * Format OpenTimestamps (.ots) — lecture, écriture, opérations, fusion.
 *
 * Réimplémentation minimale et sans dépendance réseau du format de python-opentimestamps
 * (référence), y compris l'ordre canonique de sérialisation : relire puis réécrire une preuve
 * redonne les mêmes octets (vérifié sur les fichiers d'exemple officiels, cf. ots.test.ts).
 *
 * Fichier détaché = MAGIC + varuint(1) + opération de hachage du fichier + empreinte + arbre.
 * Arbre (Timestamp) = message + attestations + opérations menant à des sous-arbres.
 */
import { ripemd160, sha1 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'

export const HEADER_MAGIC = hexToBytes('004f70656e54696d657374616d7073000050726f6f6600bf89e2e884e89294')
export const PENDING_TAG = hexToBytes('83dfe30d2ef90c8e')
export const BITCOIN_TAG = hexToBytes('0588960d73d71901')

const MAX_MSG_LENGTH = 4096
const MAX_PAYLOAD_SIZE = 8192
const MAX_URI_LENGTH = 1000
const RECURSION_LIMIT = 256
const URI_CHARS = /^[A-Za-z0-9\-._/:]+$/

export type HashOpKind = 'sha1' | 'ripemd160' | 'sha256' | 'keccak256'
export type Op = { kind: HashOpKind | 'reverse' | 'hexlify' } | { kind: 'append' | 'prepend'; arg: Uint8Array }

export type Attestation =
  | { kind: 'pending'; uri: string }
  | { kind: 'bitcoin'; height: number }
  | { kind: 'unknown'; tag: Uint8Array; payload: Uint8Array }

export interface Timestamp {
  msg: Uint8Array
  attestations: Attestation[]
  ops: { op: Op; stamp: Timestamp }[]
}

export interface DetachedTimestamp {
  hashOp: HashOpKind
  timestamp: Timestamp
}

export class OtsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OtsError'
  }
}

const OP_TAG: Record<Op['kind'], number> = {
  sha1: 0x02,
  ripemd160: 0x03,
  sha256: 0x08,
  keccak256: 0x67,
  append: 0xf0,
  prepend: 0xf1,
  reverse: 0xf2,
  hexlify: 0xf3,
}
const TAG_OP = new Map(Object.entries(OP_TAG).map(([k, v]) => [v, k as Op['kind']]))
export const DIGEST_LENGTH: Record<HashOpKind, number> = { sha1: 20, ripemd160: 20, sha256: 32, keccak256: 32 }

// ---------------------------------------------------------------------------
// Octets

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

export const equalBytes = (a: Uint8Array, b: Uint8Array) => compareBytes(a, b) === 0

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

class Reader {
  private pos = 0
  constructor(private readonly bytes: Uint8Array) {}
  byte(): number {
    if (this.pos >= this.bytes.length) throw new OtsError('fin de fichier inattendue')
    return this.bytes[this.pos++]
  }
  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new OtsError('fin de fichier inattendue')
    const out = this.bytes.slice(this.pos, this.pos + n)
    this.pos += n
    return out
  }
  varuint(): number {
    let value = 0
    let shift = 0
    for (;;) {
      const b = this.byte()
      value += (b & 0x7f) * 2 ** shift
      if (!(b & 0x80)) break
      shift += 7
      if (shift > 49) throw new OtsError('entier trop grand')
    }
    return value
  }
  varbytes(max: number, min = 0): Uint8Array {
    const n = this.varuint()
    if (n > max || n < min) throw new OtsError(`longueur ${n} hors limites`)
    return this.take(n)
  }
  eof(): boolean {
    return this.pos >= this.bytes.length
  }
}

class Writer {
  private parts: number[] = []
  byte(b: number) {
    this.parts.push(b)
  }
  bytes(b: Uint8Array) {
    for (const x of b) this.parts.push(x)
  }
  varuint(value: number) {
    if (value === 0) return this.byte(0)
    while (value !== 0) {
      let b = value & 0x7f
      if (value > 0x7f) b |= 0x80
      this.byte(b)
      if (value <= 0x7f) break
      value = Math.floor(value / 128)
    }
  }
  varbytes(b: Uint8Array) {
    this.varuint(b.length)
    this.bytes(b)
  }
  done(): Uint8Array {
    return Uint8Array.from(this.parts)
  }
}

// ---------------------------------------------------------------------------
// Opérations

export function applyOp(op: Op, msg: Uint8Array): Uint8Array {
  if (msg.length > MAX_MSG_LENGTH) throw new OtsError('message trop long')
  let out: Uint8Array
  switch (op.kind) {
    case 'append':
      out = concat(msg, op.arg)
      break
    case 'prepend':
      out = concat(op.arg, msg)
      break
    case 'reverse':
      out = msg.slice().reverse()
      break
    case 'hexlify':
      out = new TextEncoder().encode(bytesToHex(msg))
      break
    case 'sha1':
      out = sha1(msg)
      break
    case 'ripemd160':
      out = ripemd160(msg)
      break
    case 'sha256':
      out = sha256(msg)
      break
    case 'keccak256':
      out = keccak_256(msg)
      break
  }
  if (out.length > MAX_MSG_LENGTH) throw new OtsError('résultat trop long')
  return out
}

function compareOps(a: Op, b: Op): number {
  const t = OP_TAG[a.kind] - OP_TAG[b.kind]
  if (t !== 0) return t
  if ('arg' in a && 'arg' in b) return compareBytes(a.arg, b.arg)
  return 0
}

function readOp(r: Reader, tag: number): Op {
  const kind = TAG_OP.get(tag)
  if (!kind) throw new OtsError(`opération inconnue 0x${tag.toString(16)}`)
  if (kind === 'append' || kind === 'prepend') return { kind, arg: r.varbytes(MAX_MSG_LENGTH, 1) }
  return { kind } as Op
}

function writeOp(w: Writer, op: Op) {
  w.byte(OP_TAG[op.kind])
  if ('arg' in op) w.varbytes(op.arg)
}

// ---------------------------------------------------------------------------
// Attestations

function attestationTag(a: Attestation): Uint8Array {
  return a.kind === 'pending' ? PENDING_TAG : a.kind === 'bitcoin' ? BITCOIN_TAG : a.tag
}

function attestationPayload(a: Attestation): Uint8Array {
  const w = new Writer()
  if (a.kind === 'pending') w.varbytes(new TextEncoder().encode(a.uri))
  else if (a.kind === 'bitcoin') w.varuint(a.height)
  else return a.payload
  return w.done()
}

function compareAttestations(a: Attestation, b: Attestation): number {
  const t = compareBytes(attestationTag(a), attestationTag(b))
  if (t !== 0) return t
  if (a.kind === 'pending' && b.kind === 'pending') return a.uri < b.uri ? -1 : a.uri > b.uri ? 1 : 0
  if (a.kind === 'bitcoin' && b.kind === 'bitcoin') return a.height - b.height
  return compareBytes(attestationPayload(a), attestationPayload(b))
}

const sameAttestation = (a: Attestation, b: Attestation) => compareAttestations(a, b) === 0

function readAttestation(r: Reader): Attestation {
  const tag = r.take(8)
  const payload = r.varbytes(MAX_PAYLOAD_SIZE)
  const p = new Reader(payload)
  let a: Attestation
  if (equalBytes(tag, PENDING_TAG)) {
    const uri = new TextDecoder().decode(p.varbytes(MAX_URI_LENGTH))
    if (!URI_CHARS.test(uri)) throw new OtsError('URI de calendrier invalide')
    a = { kind: 'pending', uri }
  } else if (equalBytes(tag, BITCOIN_TAG)) {
    a = { kind: 'bitcoin', height: p.varuint() }
  } else {
    return { kind: 'unknown', tag, payload }
  }
  if (!p.eof()) throw new OtsError('attestation mal formée')
  return a
}

function writeAttestation(w: Writer, a: Attestation) {
  w.bytes(attestationTag(a))
  w.varbytes(attestationPayload(a))
}

// ---------------------------------------------------------------------------
// Arbre

export const newTimestamp = (msg: Uint8Array): Timestamp => ({ msg, attestations: [], ops: [] })

/** Ajoute (ou réutilise) une opération et renvoie le sous-arbre correspondant. */
export function addOp(ts: Timestamp, op: Op): Timestamp {
  const existing = ts.ops.find((o) => compareOps(o.op, op) === 0)
  if (existing) return existing.stamp
  const stamp = newTimestamp(applyOp(op, ts.msg))
  ts.ops.push({ op, stamp })
  return stamp
}

export function addAttestation(ts: Timestamp, a: Attestation) {
  if (!ts.attestations.some((x) => sameAttestation(x, a))) ts.attestations.push(a)
}

export function mergeTimestamp(into: Timestamp, other: Timestamp) {
  if (!equalBytes(into.msg, other.msg)) throw new OtsError('fusion de messages différents')
  for (const a of other.attestations) addAttestation(into, a)
  for (const { op, stamp } of other.ops) mergeTimestamp(addOp(into, op), stamp)
}

export function readTimestamp(r: Reader, msg: Uint8Array, depth = RECURSION_LIMIT): Timestamp {
  if (depth === 0) throw new OtsError('preuve trop profonde')
  const ts = newTimestamp(msg)
  const handle = (tag: number) => {
    if (tag === 0x00) addAttestation(ts, readAttestation(r))
    else {
      const op = readOp(r, tag)
      const child = readTimestamp(r, applyOp(op, msg), depth - 1)
      mergeTimestamp(addOp(ts, op), child)
    }
  }
  let tag = r.byte()
  while (tag === 0xff) {
    handle(r.byte())
    tag = r.byte()
  }
  handle(tag)
  return ts
}

export function writeTimestamp(w: Writer, ts: Timestamp) {
  const atts = [...ts.attestations].sort(compareAttestations)
  const ops = [...ts.ops].sort((a, b) => compareOps(a.op, b.op))
  if (atts.length === 0 && ops.length === 0) throw new OtsError('arbre vide')
  for (const a of atts.slice(0, -1)) {
    w.byte(0xff)
    w.byte(0x00)
    writeAttestation(w, a)
  }
  if (ops.length === 0) {
    w.byte(0x00)
    writeAttestation(w, atts[atts.length - 1])
    return
  }
  if (atts.length > 0) {
    w.byte(0xff)
    w.byte(0x00)
    writeAttestation(w, atts[atts.length - 1])
  }
  for (const { op, stamp } of ops.slice(0, -1)) {
    w.byte(0xff)
    writeOp(w, op)
    writeTimestamp(w, stamp)
  }
  const last = ops[ops.length - 1]
  writeOp(w, last.op)
  writeTimestamp(w, last.stamp)
}

/** Réponse d'un calendrier : arbre sérialisé à partir du message soumis. */
export function parseTimestamp(bytes: Uint8Array, msg: Uint8Array): Timestamp {
  const r = new Reader(bytes)
  const ts = readTimestamp(r, msg)
  if (!r.eof()) throw new OtsError('octets en trop')
  return ts
}

export function serializeTimestamp(ts: Timestamp): Uint8Array {
  const w = new Writer()
  writeTimestamp(w, ts)
  return w.done()
}

// ---------------------------------------------------------------------------
// Fichier détaché (.ots)

export function parseOts(bytes: Uint8Array): DetachedTimestamp {
  const r = new Reader(bytes)
  if (!equalBytes(r.take(HEADER_MAGIC.length), HEADER_MAGIC)) throw new OtsError('ce n’est pas une preuve OpenTimestamps')
  const major = r.varuint()
  if (major !== 1) throw new OtsError(`version ${major} non prise en charge`)
  const op = readOp(r, r.byte())
  if (!(op.kind in DIGEST_LENGTH)) throw new OtsError('opération de hachage du fichier invalide')
  const hashOp = op.kind as HashOpKind
  const digest = r.take(DIGEST_LENGTH[hashOp])
  const timestamp = readTimestamp(r, digest)
  if (!r.eof()) throw new OtsError('octets en trop')
  return { hashOp, timestamp }
}

export function serializeOts(file: DetachedTimestamp): Uint8Array {
  const w = new Writer()
  w.bytes(HEADER_MAGIC)
  w.varuint(1)
  w.byte(OP_TAG[file.hashOp])
  w.bytes(file.timestamp.msg)
  writeTimestamp(w, file.timestamp)
  return w.done()
}

/** Toutes les attestations de l'arbre, avec le message qu'elles attestent. */
export function attestationsOf(ts: Timestamp): { msg: Uint8Array; attestation: Attestation; node: Timestamp }[] {
  const out: { msg: Uint8Array; attestation: Attestation; node: Timestamp }[] = []
  const walk = (t: Timestamp) => {
    for (const a of t.attestations) out.push({ msg: t.msg, attestation: a, node: t })
    for (const { stamp } of t.ops) walk(stamp)
  }
  walk(ts)
  return out
}

// ---------------------------------------------------------------------------
// Base64 (pour le tag imeta)

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64)
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  return out
}

export { bytesToHex, hexToBytes }
