import { describe, expect, it } from 'vitest'
import { MIME_CANDIDATES, isInAppBrowser, negotiateMime } from './mime'
import { scrubMp4InPlace } from './mp4-scrub'

function box(type: string, ...payload: Uint8Array[]): Uint8Array {
  const len = 8 + payload.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(len)
  new DataView(out.buffer).setUint32(0, len)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  let o = 8
  for (const p of payload) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Boîte « full box » avec version + flags puis creation/modification time non nuls. */
function datedBox(type: string, version: 0 | 1): Uint8Array {
  const field = version === 1 ? 8 : 4
  const body = new Uint8Array(4 + field * 2 + 12).fill(0xab)
  body[0] = version
  body[1] = body[2] = body[3] = 0
  return box(type, body)
}

const text = (s: string) => new TextEncoder().encode(s)

function sampleMp4(): Uint8Array {
  const ftyp = box('ftyp', text('isom'), new Uint8Array(4), text('isomavc1'))
  const moov = box(
    'moov',
    datedBox('mvhd', 0),
    box('trak', datedBox('tkhd', 1), box('mdia', datedBox('mdhd', 0))),
    box('udta', box('©xyz', text('+48.8566+002.3522/'))),
  )
  const mdat = box('mdat', new Uint8Array(32).fill(7))
  const out = new Uint8Array(ftyp.length + moov.length + mdat.length)
  out.set(ftyp, 0)
  out.set(moov, ftyp.length)
  out.set(mdat, ftyp.length + moov.length)
  return out
}

const find = (b: Uint8Array, type: string) => {
  const t = text(type)
  for (let i = 0; i < b.length - 4; i++) if (t.every((c, j) => b[i + j] === c)) return i
  return -1
}

describe('scrubMp4InPlace (anonymat matériel)', () => {
  it('efface les dates mvhd/tkhd/mdhd et neutralise udta sans changer la taille', () => {
    const bytes = sampleMp4()
    const before = bytes.length
    const report = scrubMp4InPlace(bytes)
    expect(report.isMp4).toBe(true)
    expect(report.datesCleared).toBe(3)
    expect(report.boxesNeutralized).toEqual(['udta'])
    expect(bytes.length).toBe(before)
    for (const [type, field] of [['mvhd', 4], ['tkhd', 8], ['mdhd', 4]] as const) {
      const at = find(bytes, type) + 4 + 4 // type + version/flags
      expect([...bytes.slice(at, at + field * 2)].every((b) => b === 0)).toBe(true)
      // le reste de la boîte est intact
      expect(bytes[at + field * 2]).toBe(0xab)
    }
    expect(find(bytes, 'udta')).toBe(-1)
    expect(find(bytes, 'free')).toBeGreaterThan(0)
    // mdat intact
    const mdat = find(bytes, 'mdat') + 4
    expect([...bytes.slice(mdat, mdat + 32)].every((b) => b === 7)).toBe(true)
  })

  it('ignore les fichiers non MP4 (WebM)', () => {
    const webm = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(scrubMp4InPlace(webm).isMp4).toBe(false)
  })

  it('ne plante pas sur une structure tronquée', () => {
    const bytes = sampleMp4().slice(0, 60)
    expect(() => scrubMp4InPlace(bytes)).not.toThrow()
  })
})

describe('negotiateMime (FR-03)', () => {
  it('Safari / Chrome ≥ 126 : MP4 H.264 + AAC en premier', () => {
    expect(negotiateMime(() => true)).toBe(MIME_CANDIDATES[0])
    expect(negotiateMime((m) => m === 'video/mp4')).toBe('video/mp4')
  })
  it('Firefox : repli VP8/Opus', () => {
    const firefox = (m: string) => m.startsWith('video/webm') && !m.includes('avc1')
    expect(negotiateMime(firefox)).toBe('video/webm;codecs="vp8,opus"')
  })
  it('résiste aux exceptions de isTypeSupported', () => {
    expect(negotiateMime((m) => { if (m.includes('mp4')) throw new Error('x'); return true })).toBe('video/webm;codecs="vp8,opus"')
  })
  it('aucun format', () => {
    expect(negotiateMime(() => false)).toBeUndefined()
  })
})

describe('isInAppBrowser', () => {
  it('détecte Instagram / Facebook', () => {
    expect(isInAppBrowser('Mozilla/5.0 (iPhone) Instagram 300.0')).toBe(true)
    expect(isInAppBrowser('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1')).toBe(false)
  })
})
