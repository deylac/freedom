import { describe, expect, it } from 'vitest'
import { BENCH_VARIANTS, formatReport, mbPerMinute, pickMime, probeFamily, savingVs, type BenchEnv, type BenchResult } from './codec-bench'

const variant = (id: string) => BENCH_VARIANTS.find((v) => v.id === id)!

describe('banc d’essai des formats', () => {
  it('la référence reprend le réglage actuel de l’application (H.264 Baseline, 2 Mbit/s)', () => {
    const ref = variant('h264-actuel')
    expect(ref.videoBps).toBe(2_000_000)
    expect(ref.mimes[0]).toContain('avc1.42E01F')
  })

  it('choisit le premier format accepté et ignore les chaînes qui lèvent une exception', () => {
    const hevc = variant('hevc')
    const accepted = (m: string) => {
      if (m.includes('hvc1.1.6')) throw new Error('chaîne inconnue')
      return m.includes('hev1')
    }
    expect(pickMime(hevc, accepted)).toContain('hev1.1.6.L93.B0')
    expect(pickMime(hevc, () => false)).toBeNull()
  })

  it('calcule le poids par minute et l’écart avec la référence', () => {
    const ref = { bytes: 5_250_000, durationSec: 20 } // 15,75 Mo/min
    const light = { bytes: 2_625_000, durationSec: 20 }
    expect(mbPerMinute(ref)).toBeCloseTo(15.75)
    expect(savingVs(ref, light)).toBe(-50)
    expect(savingVs(undefined, light)).toBeNull()
    expect(savingVs(ref, { bytes: 0, durationSec: 20 })).toBeNull()
  })

  it('sonde un navigateur qui enregistre et lit le HEVC avec un encodeur matériel', async () => {
    const env: BenchEnv = {
      isTypeSupported: (m) => m.includes('hvc1'),
      isConfigSupported: async (c) => ({ supported: c.hardwareAcceleration === 'prefer-hardware' }),
      canPlayType: () => 'probably',
      decodingInfo: async () => ({ supported: true, smooth: true, powerEfficient: true }),
    }
    const p = await probeFamily('hevc', env)
    expect(p).toMatchObject({ record: 'oui', encode: 'oui', encodeHardware: 'oui', decode: 'oui', powerEfficient: 'oui' })
    expect(p.recordMime).toContain('hvc1.1.6.L93.B0')
  })

  it('sans API disponible, répond « inconnu » plutôt que « non »', async () => {
    const p = await probeFamily('av1', {})
    expect(p).toMatchObject({ record: 'inconnu', encode: 'inconnu', decode: 'inconnu' })
  })

  it('le rapport texte donne tailles, écarts, formats et échecs', () => {
    const results: BenchResult[] = [
      { variant: variant('h264-actuel'), mime: 'video/mp4;codecs=avc1', bytes: 5_250_000, durationSec: 20 },
      { variant: variant('hevc'), mime: 'video/mp4;codecs=hvc1', bytes: 2_625_000, durationSec: 20 },
      { variant: variant('hevc-bas'), mime: 'video/mp4;codecs=hvc1', bytes: 0, durationSec: 20, error: 'NotSupportedError : encodeur occupé' },
      { variant: variant('av1'), mime: null, bytes: 0, durationSec: 20 },
    ]
    const text = formatReport([], results, { userAgent: 'Test/1.0', playable: { hevc: true } })
    expect(text).toContain('Test/1.0')
    expect(text).toMatch(/HEVC \(1,1 Mbit\/s\) : 7,9 Mo\/min, 1,05 Mbit\/s réels, -50 %, relu ici/)
    expect(text).toContain('ÉCHEC NotSupportedError')
    expect(text).toContain("AV1 (1 Mbit/s) : non pris en charge par l'enregistreur")
  })
})
