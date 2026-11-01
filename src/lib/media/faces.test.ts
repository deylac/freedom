import { describe, expect, it } from 'vitest'
import { blockFor, iou, marginFor, mergeBoxes, padBox, tileGrid } from './faces'

describe('tileGrid', () => {
  it('couvre toute l’image 720×1280 avec des tuiles de 360 px qui se recouvrent', () => {
    const tiles = tileGrid(720, 1280, 360, 0.25)
    // chaque pixel est dans au moins une tuile
    for (const [x, y] of [[0, 0], [719, 1279], [360, 640], [700, 10], [5, 1270]]) {
      expect(tiles.some((t) => x >= t.x && x < t.x + t.size && y >= t.y && y < t.y + t.size)).toBe(true)
    }
    expect(tiles.every((t) => t.x + t.size <= 720 && t.y + t.size <= 1280)).toBe(true)
    expect(tiles.length).toBe(15) // 3 colonnes × 5 lignes (mesuré : 15 passes)
  })

  it('un visage de 60 px à cheval sur deux tuiles est entier dans l’une d’elles', () => {
    const tiles = tileGrid(720, 1280, 360, 0.25)
    for (let fx = 0; fx < 660; fx += 13) {
      expect(tiles.some((t) => fx >= t.x && fx + 60 <= t.x + t.size && 500 >= t.y && 560 <= t.y + t.size)).toBe(true)
    }
  })

  it('ne dépasse jamais l’image, même si la tuile est plus grande', () => {
    expect(tileGrid(300, 200, 360)).toEqual([{ x: 0, y: 0, size: 200 }, { x: 100, y: 0, size: 200 }])
  })
})

describe('mergeBoxes', () => {
  it('fusionne deux détections du même visage en leur union', () => {
    const merged = mergeBoxes([
      { x: 100, y: 100, w: 50, h: 50, score: 0.9 },
      { x: 110, y: 105, w: 50, h: 50, score: 0.6 },
    ])
    expect(merged).toEqual([{ x: 100, y: 100, w: 60, h: 55, score: 0.9 }])
  })
  it('garde les visages distincts', () => {
    expect(mergeBoxes([{ x: 0, y: 0, w: 20, h: 20 }, { x: 100, y: 100, w: 20, h: 20 }])).toHaveLength(2)
  })
  it('iou', () => {
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(1)
    expect(iou({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 0, w: 10, h: 10 })).toBe(0)
  })
})

describe('padBox / marges', () => {
  it('agrandit et borne à l’image', () => {
    expect(padBox({ x: 10, y: 10, w: 100, h: 100 }, 0.4, 720, 1280)).toEqual({ x: 0, y: 0, w: 150, h: 150, score: undefined })
    expect(padBox({ x: 650, y: 1200, w: 60, h: 60 }, 0.5, 720, 1280)).toEqual({ x: 620, y: 1170, w: 100, h: 110, score: undefined })
  })
  it('marge plus large pour les petits visages lointains', () => {
    expect(marginFor({ x: 0, y: 0, w: 20, h: 20 })).toBeGreaterThan(marginFor({ x: 0, y: 0, w: 200, h: 200 }))
  })
  it('blocs de pixelisation proportionnels, jamais trop fins', () => {
    expect(blockFor({ x: 0, y: 0, w: 12, h: 12 })).toBe(6)
    expect(blockFor({ x: 0, y: 0, w: 120, h: 120 })).toBe(20)
  })
})
