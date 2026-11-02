import { describe, expect, it } from 'vitest'
import { decode, mapBack, nms, squarePlacements, toBgrPlanar, wholePlacement, YUNET_SIZE } from './yunet'

/** Sorties YuNet vides, avec un visage placé dans la cellule (r, c) du pas `s`. */
function outputs(face?: { s: number; r: number; c: number; dx: number; dy: number; w: number; h: number; cls: number; obj: number }) {
  const out: Record<string, { data: Float32Array }> = {}
  for (const s of [8, 16, 32]) {
    const n = (YUNET_SIZE / s) ** 2
    out[`cls_${s}`] = { data: new Float32Array(n) }
    out[`obj_${s}`] = { data: new Float32Array(n) }
    out[`bbox_${s}`] = { data: new Float32Array(n * 4) }
  }
  if (face) {
    const i = face.r * (YUNET_SIZE / face.s) + face.c
    out[`cls_${face.s}`].data[i] = face.cls
    out[`obj_${face.s}`].data[i] = face.obj
    out[`bbox_${face.s}`].data.set([face.dx, face.dy, Math.log(face.w / face.s), Math.log(face.h / face.s)], i * 4)
  }
  return out
}

describe('YuNet : décodage (comme cv::FaceDetectorYN)', () => {
  it('position, taille et score (moyenne géométrique cls × obj)', () => {
    const [f] = decode(outputs({ s: 16, r: 10, c: 5, dx: 0.5, dy: 0.25, w: 40, h: 48, cls: 0.81, obj: 1 }), 0.5)
    expect(f.x).toBeCloseTo((5 + 0.5) * 16 - 20)
    expect(f.y).toBeCloseTo((10 + 0.25) * 16 - 24)
    expect(f.w).toBeCloseTo(40)
    expect(f.h).toBeCloseTo(48)
    expect(f.score).toBeCloseTo(0.9)
  })

  it('sous le seuil : rien', () => {
    expect(decode(outputs({ s: 8, r: 1, c: 1, dx: 0, dy: 0, w: 10, h: 10, cls: 0.3, obj: 0.3 }), 0.5)).toEqual([])
  })

  it('sortie manquante : erreur explicite', () => {
    expect(() => decode({}, 0.5)).toThrow(/sortie YuNet manquante/)
  })
})

describe('YuNet : préparation', () => {
  it('RGBA → BGR planaire', () => {
    const rgba = new Uint8Array(YUNET_SIZE * YUNET_SIZE * 4)
    rgba.set([10, 20, 30, 255], 0)
    const t = toBgrPlanar(rgba)
    const plane = YUNET_SIZE * YUNET_SIZE
    expect([t[0], t[plane], t[2 * plane]]).toEqual([30, 20, 10])
  })

  it('720 × 1280 : image entière à l’échelle 0,5 ; deux carrés de 720 px qui couvrent toute la hauteur', () => {
    expect(wholePlacement(720, 1280).scale).toBeCloseTo(0.5)
    const sq = squarePlacements(720, 1280)
    expect(sq.map((p) => p.sy)).toEqual([0, 560])
    expect(sq.every((p) => p.sw === 720 && p.sh === 720)).toBe(true)
    // Contrôle : cadrage décalé + carré central.
    expect(squarePlacements(720, 1280, 180).map((p) => p.sy)).toEqual([180, 560, 280])
  })

  it('retour aux coordonnées d’origine', () => {
    const p = squarePlacements(720, 1280)[1]
    const b = mapBack({ x: 64, y: 64, w: 32, h: 32 }, p)
    expect(b.x).toBeCloseTo(72)
    expect(b.y).toBeCloseTo(560 + 72)
    expect(b.w).toBeCloseTo(36)
  })

  it('NMS : un seul visage par groupe de boîtes qui se recouvrent', () => {
    const kept = nms([
      { x: 0, y: 0, w: 50, h: 50, score: 0.8 },
      { x: 2, y: 1, w: 50, h: 50, score: 0.95 },
      { x: 200, y: 200, w: 30, h: 30, score: 0.7 },
    ])
    expect(kept.map((k) => k.score)).toEqual([0.95, 0.7])
  })
})
