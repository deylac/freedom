import { describe, expect, it } from 'vitest'
import { FACE_TRUST_MS, FaceHistory } from './face-history'

const face = { x: 10, y: 10, w: 50, h: 50 }

/** Une image capturée à `captured`, analysée et reçue à `received`. */
function detection(h: FaceHistory, id: number, captured: number, received: number, boxes = [face], complete = true) {
  h.sent(id, captured)
  h.receive(id, boxes, complete, received)
}

describe('FaceHistory (audit F01)', () => {
  it('jamais de confiance sans masque : les deux expirent ensemble (scénario de l’audit)', () => {
    const h = new FaceHistory()
    detection(h, 1, 0, 100)
    // Le détecteur ne répond plus. À chaque instant : soit confiance ET masque, soit pixelisation totale.
    for (const t of [100, 1199, 1200, 1201, 1499, 1500, 1501, 2499, 2500, 2501]) {
      const trusted = h.trusted(t)
      if (trusted) expect(h.faces(t)).toHaveLength(1)
      expect(trusted).toBe(t < FACE_TRUST_MS)
    }
  })

  it('compte depuis la capture, pas depuis la réception (résultat en retard)', () => {
    const h = new FaceHistory()
    detection(h, 1, 0, 1400)
    expect(h.trusted(1450)).toBe(true)
    expect(h.trusted(1500)).toBe(false)
    expect(h.faces(1500)).toEqual([])
  })

  it('worker bloqué : plus de confiance une fois la dernière analyse trop ancienne', () => {
    const h = new FaceHistory()
    detection(h, 1, 0, 50)
    h.sent(2, 100) // jamais de réponse
    expect(h.trusted(1499)).toBe(true)
    expect(h.trusted(1500)).toBe(false)
  })

  it('un résultat incomplet (tuiles pas encore toutes vues) ne donne pas confiance mais ses masques comptent', () => {
    const h = new FaceHistory()
    detection(h, 1, 0, 50, [face], false)
    expect(h.trusted(60)).toBe(false)
    expect(h.faces(60)).toHaveLength(1)
  })

  it('un nouveau visage est masqué dès le résultat suivant, l’ancien reste masqué pendant la fenêtre', () => {
    const h = new FaceHistory()
    detection(h, 1, 0, 50)
    const other = { x: 300, y: 300, w: 40, h: 40 }
    detection(h, 2, 200, 260, [other])
    expect(h.faces(300)).toEqual([face, other])
  })

  it('changement de caméra : résultats antérieurs ignorés, confiance perdue jusqu’à une analyse complète', () => {
    const h = new FaceHistory()
    detection(h, 1, 0, 50)
    h.sent(2, 100)
    h.reset(3)
    h.receive(2, [], true, 150) // image de l'ancienne caméra
    expect(h.trusted(160)).toBe(false)
    expect(h.faces(160)).toEqual([])
    detection(h, 3, 200, 250, [face], false)
    expect(h.trusted(260)).toBe(false)
    detection(h, 4, 300, 350)
    expect(h.trusted(360)).toBe(true)
  })

  it('ignore un résultat pour une image inconnue', () => {
    const h = new FaceHistory()
    h.receive(42, [face], true, 10)
    expect(h.trusted(10)).toBe(false)
  })
})
