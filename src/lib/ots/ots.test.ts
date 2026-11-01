import { readFileSync } from 'node:fs'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { describe, expect, it } from 'vitest'
import {
  addAttestation,
  addOp,
  attestationsOf,
  bytesToHex,
  fromBase64,
  newTimestamp,
  OtsError,
  parseOts,
  serializeOts,
  toBase64,
  type DetachedTimestamp,
} from './ots'

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${name}`, import.meta.url)))

const FILES = [
  'hello-world.txt',
  'merkle2.txt',
  'incomplete.txt',
  'two-calendars.txt',
  'unknown-notary.txt',
  'known-and-unknown-notary.txt',
  'bad-stamp.txt',
]

describe('parseOts sur les preuves officielles', () => {
  for (const name of FILES) {
    it(`${name} : l’empreinte prouvée est le SHA-256 du fichier, aller-retour à l’octet près`, () => {
      const bytes = fixture(`${name}.ots`)
      const ots = parseOts(bytes)
      expect(ots.hashOp).toBe('sha256')
      expect(bytesToHex(ots.timestamp.msg)).toBe(bytesToHex(sha256(fixture(name))))
      expect(bytesToHex(serializeOts(ots))).toBe(bytesToHex(bytes))
    })
  }

  it('fichier haché en RIPEMD-160 (branches non triées à l’origine : réécriture canonique stable)', () => {
    const bytes = fixture('ripemd160-README.md.ots')
    const ots = parseOts(bytes)
    expect(ots.hashOp).toBe('ripemd160')
    expect(bytesToHex(ots.timestamp.msg)).toBe(bytesToHex(ripemd160(fixture('ripemd160-README.md'))))
    // Ce fichier vient du client JavaScript, qui n'ordonne pas les branches comme la référence
    // Python ; notre écriture suit l'ordre canonique : même taille, même contenu, et stable.
    const canonical = serializeOts(ots)
    expect(canonical).toHaveLength(bytes.length)
    expect(bytesToHex(serializeOts(parseOts(canonical)))).toBe(bytesToHex(canonical))
    const uris = (b: Uint8Array) => attestationsOf(parseOts(b).timestamp).map((a) => JSON.stringify(a.attestation) + bytesToHex(a.msg)).sort()
    expect(uris(canonical)).toEqual(uris(bytes))
  })

  it('hello-world : attestation Bitcoin au bloc 358391', () => {
    const atts = attestationsOf(parseOts(fixture('hello-world.txt.ots')).timestamp)
    const btc = atts.filter((a) => a.attestation.kind === 'bitcoin')
    expect(btc.map((a) => a.attestation)).toEqual([{ kind: 'bitcoin', height: 358391 }])
    expect(btc[0].msg).toHaveLength(32)
  })

  it('incomplete : seulement une attestation en attente (calendrier alice)', () => {
    const atts = attestationsOf(parseOts(fixture('incomplete.txt.ots')).timestamp).map((a) => a.attestation)
    expect(atts).toEqual([{ kind: 'pending', uri: 'https://alice.btc.calendar.opentimestamps.org' }])
  })

  it('two-calendars : deux calendriers en attente', () => {
    const uris = attestationsOf(parseOts(fixture('two-calendars.txt.ots')).timestamp)
      .map((a) => a.attestation)
      .filter((a) => a.kind === 'pending')
      .map((a) => (a.kind === 'pending' ? a.uri : ''))
    expect(uris.sort()).toEqual(['https://alice.btc.calendar.opentimestamps.org', 'https://bob.btc.calendar.opentimestamps.org'])
  })

  it('notaire inconnu conservé tel quel (aller-retour)', () => {
    const atts = attestationsOf(parseOts(fixture('unknown-notary.txt.ots')).timestamp)
    expect(atts.some((a) => a.attestation.kind === 'unknown')).toBe(true)
  })
})

describe('robustesse', () => {
  it('refuse un fichier qui n’est pas une preuve', () => {
    expect(() => parseOts(new TextEncoder().encode('bonjour'))).toThrow(OtsError)
  })
  it('refuse une preuve tronquée', () => {
    const bytes = fixture('hello-world.txt.ots')
    expect(() => parseOts(bytes.slice(0, bytes.length - 3))).toThrow(OtsError)
  })
  it('refuse des octets en trop', () => {
    const bytes = fixture('hello-world.txt.ots')
    expect(() => parseOts(new Uint8Array([...bytes, 0]))).toThrow(OtsError)
  })
  it('refuse une URI de calendrier avec des caractères interdits', () => {
    const ts = newTimestamp(new Uint8Array(32))
    addAttestation(ts, { kind: 'pending', uri: 'https://evil.example/?track=1' })
    const bytes = serializeOts({ hashOp: 'sha256', timestamp: ts })
    expect(() => parseOts(bytes)).toThrow(/URI/)
  })
})

describe('construction', () => {
  it('nonce + sha256 + attestation, sérialisation stable et base64', () => {
    const digest = sha256(new TextEncoder().encode('vidéo'))
    const root = newTimestamp(digest)
    const commit = addOp(addOp(root, { kind: 'append', arg: new Uint8Array(16).fill(7) }), { kind: 'sha256' })
    addAttestation(commit, { kind: 'pending', uri: 'https://alice.btc.calendar.opentimestamps.org' })
    const file: DetachedTimestamp = { hashOp: 'sha256', timestamp: root }
    const bytes = serializeOts(file)
    const back = parseOts(fromBase64(toBase64(bytes)))
    expect(bytesToHex(serializeOts(back))).toBe(bytesToHex(bytes))
    expect(attestationsOf(back.timestamp)[0].msg).toEqual(commit.msg)
  })
})
