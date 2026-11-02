import { describe, expect, it } from 'vitest'
import { covered, MaskPlan } from './face-plan'

const face = (x: number, y = 100, s = 60) => ({ x, y, w: s, h: s })

/** Le visage réel (vérité terrain) est-il entièrement masqué à l'instant t ? */
function fullyMasked(plan: MaskPlan, t: number, truth: { x: number; y: number; w: number; h: number }) {
  return plan.at(t).some((m) => m.x <= truth.x && m.y <= truth.y && m.x + m.w >= truth.x + truth.w && m.y + m.h >= truth.y + truth.h)
}

describe('plan de masquage du second passage', () => {
  it('mouvement brusque : la position est interpolée entre deux détections, pas extrapolée en retard', () => {
    // Visage qui traverse l'image à 1 200 px/s, détecté toutes les 0,1 s seulement.
    const pos = (t: number) => face(100 + 1200 * t)
    const plan = new MaskPlan([0, 0.1, 0.2, 0.3].map((t) => ({ t, boxes: [pos(t)] })))
    for (let t = 0; t <= 0.3; t += 1 / 30) expect(fullyMasked(plan, t, pos(t))).toBe(true)
    expect(plan.trackCount).toBe(1)
  })

  it('détection manquée (profil, flou de bougé) : le trou est comblé par interpolation', () => {
    const pos = (t: number) => face(100 + 300 * t)
    const plan = new MaskPlan([
      { t: 0, boxes: [pos(0)] },
      { t: 0.1, boxes: [] },
      { t: 0.2, boxes: [] },
      { t: 0.3, boxes: [] },
      { t: 0.4, boxes: [pos(0.4)] },
    ])
    for (const t of [0.1, 0.2, 0.25, 0.3]) expect(fullyMasked(plan, t, pos(t))).toBe(true)
  })

  it('le masque précède la première détection et suit la dernière (entrée / sortie du champ)', () => {
    const plan = new MaskPlan([{ t: 1, boxes: [face(200)] }])
    expect(plan.at(0.8)).toHaveLength(1)
    expect(plan.at(1.2)).toHaveLength(1)
    expect(plan.at(0.3)).toEqual([])
    expect(plan.at(1.7)).toEqual([])
  })

  it('plusieurs visages : une piste chacun, aucun ne vole le masque de l’autre', () => {
    const a = (t: number) => face(50 + 100 * t, 100)
    const b = (t: number) => face(400 - 100 * t, 400)
    const plan = new MaskPlan([0, 0.1, 0.2].map((t) => ({ t, boxes: [a(t), b(t)] })))
    expect(plan.trackCount).toBe(2)
    for (const t of [0.05, 0.15]) {
      expect(fullyMasked(plan, t, a(t))).toBe(true)
      expect(fullyMasked(plan, t, b(t))).toBe(true)
    }
  })

  it('masque serré : sans mouvement, il ne dépasse le visage que d’une marge d’environ 10 à 15 % par côté', () => {
    const plan = new MaskPlan([0, 0.1, 0.2].map((t) => ({ t, boxes: [face(200)] })))
    const [m] = plan.at(0.1)
    expect(m.w).toBeLessThan(60 * 1.35)
    expect(m.w).toBeGreaterThanOrEqual(60 * 1.15)
    // Le front est inclus (le détecteur s'arrête aux sourcils).
    expect(m.y).toBeLessThan(100 - 60 * 0.25)
  })

  it('covered : centre d’une détection dans un masque', () => {
    expect(covered(face(10), [{ x: 0, y: 90, w: 100, h: 100 }])).toBe(true)
    expect(covered(face(300), [{ x: 0, y: 90, w: 100, h: 100 }])).toBe(false)
  })
})

describe('plan de masquage : cas réels relevés en E2E', () => {
  it('un visage mobile n’absorbe pas un petit visage fixe voisin', () => {
    // Visage fixe de 36 px ; visage mobile de 73 px qui apparaît juste en dessous.
    const fixed = { x: 163, y: 862, w: 36, h: 36 }
    const mobile = { x: 57, y: 1075, w: 73, h: 73 }
    const plan = new MaskPlan([
      { t: 0, boxes: [fixed] },
      { t: 0.11, boxes: [fixed] },
      { t: 0.21, boxes: [mobile, fixed] },
      { t: 0.32, boxes: [mobile, fixed] },
    ])
    expect(fullyMasked(plan, 0.25, mobile)).toBe(true)
    expect(fullyMasked(plan, 0.25, fixed)).toBe(true)
  })

  it('une détection isolée peu sûre (porte, motif) n’est pas masquée ; sûre, elle l’est avec ses voisines', () => {
    expect(new MaskPlan([{ t: 1, boxes: [{ ...face(300), score: 0.55 }] }]).at(1)).toEqual([])
    const f = { ...face(300), score: 0.9 }
    const plan = new MaskPlan([{ t: 1, boxes: [f] }])
    for (const t of [0.9, 1, 1.1]) expect(fullyMasked(plan, t, f)).toBe(true)
  })
})
