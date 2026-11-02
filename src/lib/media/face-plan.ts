/**
 * Plan de masquage d'une vidéo DÉJÀ tournée (second passage, sans contrainte de temps réel).
 *
 * En direct, un masque ne peut s'appuyer que sur le passé : il est toujours en retard sur le
 * mouvement (constat réel du 1ᵉʳ nov.). Ici, chaque image est masquée à partir des détections
 * d'AVANT et d'APRÈS elle :
 *  - les détections successives d'un même visage forment une piste ;
 *  - entre deux détections, la position est INTERPOLÉE (mouvement brusque, visage de profil un instant) ;
 *  - avant la première et après la dernière détection, le masque est maintenu un court moment en
 *    grandissant (visage qui entre ou sort du champ, flou de bougé).
 * Les masques restent donc serrés sur les visages au lieu d'être agrandis « au cas où ».
 */
import type { Box } from './faces'

export interface FrameDetections {
  /** Instant de l'image analysée, en secondes. */
  t: number
  boxes: Box[]
}

export interface MaskPlanOptions {
  /** Marge autour du visage (fraction de sa taille, de chaque côté). */
  pad?: number
  /** Écart maximal entre deux détections d'une même piste pour interpoler (s). */
  maxGapS?: number
  /** Maintien d'un masque avant la première / après la dernière détection d'une piste (s). */
  holdS?: number
  /** Agrandissement par seconde pendant le maintien (fraction de la taille, de chaque côté). */
  growthPerS?: number
}

/** Une détection masque aussi les images situées à moins de ce délai (s), quelle que soit sa piste. */
const NEIGHBOR_S = 0.15

const DEFAULTS: Required<MaskPlanOptions> = { pad: 0.2, maxGapS: 1.2, holdS: 0.5, growthPerS: 1.2 }

interface Obs {
  t: number
  box: Box
}

const center = (b: Box) => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 })
const size = (b: Box) => Math.max(b.w, b.h)

function grow(b: Box, k: number): Box {
  return { ...b, x: b.x - b.w * k, y: b.y - b.h * k, w: b.w * (1 + 2 * k), h: b.h * (1 + 2 * k) }
}

function lerp(a: Box, b: Box, f: number): Box {
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, w: a.w + (b.w - a.w) * f, h: a.h + (b.h - a.h) * f, score: a.score }
}

export class MaskPlan {
  private tracks: Obs[][] = []
  private frames: FrameDetections[] = []
  private readonly o: Required<MaskPlanOptions>

  constructor(frames: FrameDetections[], options: MaskPlanOptions = {}) {
    this.o = { ...DEFAULTS, ...options }
    for (const f of [...frames].sort((a, b) => a.t - b.t)) this.addFrame(f)
  }

  /** Nombre de visages distincts suivis (pistes). */
  get trackCount(): number {
    return this.tracks.length
  }

  /** Ajoute des détections (ex. visages trouvés par la vérification), dans l'ordre chronologique ou non. */
  addFrame(frame: FrameDetections): void {
    this.frames.push(frame)
    this.frames.sort((a, b) => a.t - b.t)
    // Toutes les associations possibles (détection, piste), de la plus proche à la plus lointaine :
    // un visage ne « vole » jamais la piste d'un autre plus proche (constat E2E : la piste d'un visage
    // mobile avait absorbé un petit visage fixe voisin, et le masque était interpolé entre les deux).
    const pairs: { box: number; track: number; d: number }[] = []
    frame.boxes.forEach((box, bi) => {
      this.tracks.forEach((track, ti) => {
        const near = track.reduce((p, o) => (Math.abs(o.t - frame.t) < Math.abs(p.t - frame.t) ? o : p))
        const dt = Math.abs(near.t - frame.t)
        if (dt > this.o.maxGapS || dt === 0) return
        // Même visage : taille comparable (le visage ne double pas de taille en un instant)…
        const ratio = size(box) / size(near.box)
        if (ratio > 1.6 || ratio < 1 / 1.6) return
        // … et déplacement plausible : 2 tailles + 10 tailles par seconde d'écart (mouvement brusque).
        const c1 = center(near.box)
        const c2 = center(box)
        const d = Math.hypot(c1.x - c2.x, c1.y - c2.y)
        if (d < Math.max(size(near.box), size(box)) * (2 + 10 * dt)) pairs.push({ box: bi, track: ti, d })
      })
    })
    pairs.sort((a, b) => a.d - b.d)
    const usedBoxes = new Set<number>()
    const usedTracks = new Set<number>()
    for (const p of pairs) {
      if (usedBoxes.has(p.box) || usedTracks.has(p.track)) continue
      usedBoxes.add(p.box)
      usedTracks.add(p.track)
      const track = this.tracks[p.track]
      track.push({ t: frame.t, box: frame.boxes[p.box] })
      track.sort((a, b) => a.t - b.t)
    }
    frame.boxes.forEach((box, bi) => {
      if (!usedBoxes.has(bi)) this.tracks.push([{ t: frame.t, box }])
    })
  }

  /** Rectangles à masquer à l'instant `t` (marge comprise). */
  at(t: number): Box[] {
    const out: Box[] = []
    const { pad, maxGapS, holdS, growthPerS } = this.o
    for (const track of this.tracks) {
      let prev: Obs | undefined
      let next: Obs | undefined
      for (const o of track) {
        if (o.t <= t) prev = o
        else {
          next = o
          break
        }
      }
      let box: Box | undefined
      if (prev && next && next.t - prev.t <= maxGapS) {
        const gap = next.t - prev.t
        // Interpolation ; marge supplémentaire si l'écart est long (trajectoire moins sûre).
        box = grow(lerp(prev.box, next.box, (t - prev.t) / gap), Math.min(0.4, gap * 0.5))
      } else {
        const near = !prev ? next : !next ? prev : t - prev.t <= next.t - t ? prev : next
        if (!near) continue
        const dt = Math.abs(t - near.t)
        if (dt > holdS) continue
        box = grow(near.box, dt * growthPerS)
      }
      out.push(grow(box, pad))
    }
    // Filet de sécurité, indépendant des pistes : chaque détection masque aussi les images voisines.
    for (const f of this.frames) {
      const dt = Math.abs(f.t - t)
      if (dt <= NEIGHBOR_S) for (const b of f.boxes) out.push(grow(b, pad + dt * growthPerS))
    }
    return out
  }
}

/** Le centre de `b` est-il couvert par l'un des masques ? */
export function covered(b: Box, masks: Box[]): boolean {
  const c = center(b)
  return masks.some((m) => c.x >= m.x && c.x <= m.x + m.w && c.y >= m.y && c.y <= m.y + m.h)
}
