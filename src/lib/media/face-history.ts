/**
 * Mémoire temporelle des détections de visages, sans dépendance au navigateur (testable).
 *
 * Audit F01 : les masques expiraient après 1,2 s mais la confiance durait 2,5 s, et toutes deux
 * étaient comptées depuis la RÉCEPTION du résultat. Si le détecteur cessait de répondre juste après
 * une détection, l'image pouvait passer sans aucun masque pendant ~1,3 s.
 *
 * Règles :
 *  - tout est daté par l'heure de CAPTURE de l'image analysée (un résultat en retard vaut moins) ;
 *  - masques et confiance expirent ENSEMBLE (même fenêtre) : tant que `trusted` est vrai, les
 *    rectangles du dernier résultat complet sont forcément encore appliqués ;
 *  - après un changement de source (caméra), tout résultat portant sur une image antérieure est ignoré
 *    et la confiance repart de zéro.
 */
import type { Box } from './faces'

/** Âge maximal (depuis la capture) d'un résultat pour faire confiance au détecteur et garder ses masques. */
export const FACE_TRUST_MS = 1500

export class FaceHistory {
  private sentAt = new Map<number, number>()
  private results: { at: number; boxes: Box[] }[] = []
  private lastCompleteAt = Number.NEGATIVE_INFINITY
  private minId = 0

  /** Image `id` capturée à `at` et confiée au détecteur. */
  sent(id: number, at: number): void {
    this.sentAt.set(id, at)
    // Réponses perdues : on n'accumule pas indéfiniment.
    if (this.sentAt.size > 32) this.sentAt.delete(this.sentAt.keys().next().value!)
  }

  /** Résultat du détecteur pour l'image `id`. */
  receive(id: number, boxes: Box[], complete: boolean, now: number): void {
    const at = this.sentAt.get(id)
    this.sentAt.delete(id)
    if (at === undefined || id < this.minId) return
    this.results = [...this.results.filter((r) => now - r.at < FACE_TRUST_MS), { at, boxes }]
    if (complete) this.lastCompleteAt = Math.max(this.lastCompleteAt, at)
  }

  /** Les dernières analyses couvrent toute l'image et sont assez récentes pour ne flouter que les visages. */
  trusted(now: number): boolean {
    return now - this.lastCompleteAt < FACE_TRUST_MS
  }

  /** Rectangles encore valables (même fenêtre que la confiance). */
  faces(now: number): Box[] {
    return this.results.filter((r) => now - r.at < FACE_TRUST_MS).flatMap((r) => r.boxes)
  }

  get count(): number {
    return this.results.at(-1)?.boxes.length ?? 0
  }

  /** Changement de source : seules les images d'identifiant ≥ `nextId` compteront. */
  reset(nextId: number): void {
    this.results = []
    this.sentAt.clear()
    this.lastCompleteAt = Number.NEGATIVE_INFINITY
    this.minId = nextId
  }
}
