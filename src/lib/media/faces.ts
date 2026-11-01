/**
 * Géométrie de la détection de visages (FR-08), en fonctions pures testables.
 *
 * Mesures (modèle BlazeFace « full range », image 720×1280, voir docs/ANGLES-MORTS.md) :
 *   image entière ≈ visages ≥ 61 px de large ; tuiles de 360 px ≈ visages ≥ 23 px.
 * D'où un balayage en deux passes : image entière (gros visages, faible latence) + tuiles.
 */

export interface Box {
  x: number
  y: number
  w: number
  h: number
  score?: number
}

export interface Tile {
  x: number
  y: number
  size: number
}

/** Tuiles carrées couvrant toute l'image, avec recouvrement (un visage à cheval reste entier dans une tuile). */
export function tileGrid(width: number, height: number, size: number, overlap = 0.25): Tile[] {
  const s = Math.min(size, width, height)
  const step = Math.max(1, Math.round(s * (1 - overlap)))
  const positions = (extent: number) => {
    const out: number[] = []
    for (let p = 0; ; p += step) {
      out.push(Math.min(p, extent - s))
      if (p + s >= extent) break
    }
    return [...new Set(out)]
  }
  const tiles: Tile[] = []
  for (const y of positions(height)) for (const x of positions(width)) tiles.push({ x, y, size: s })
  return tiles
}

export function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  const union = a.w * a.h + b.w * b.h - inter
  return union > 0 ? inter / union : 0
}

/**
 * Fusion des détections (tuiles qui se recouvrent, deux passes) : on garde l'union des boîtes qui
 * se chevauchent plutôt que la seule meilleure — pour l'anonymisation, masquer trop vaut mieux que pas assez.
 */
export function mergeBoxes(boxes: Box[], threshold = 0.3): Box[] {
  const sorted = [...boxes].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const out: Box[] = []
  for (const b of sorted) {
    const hit = out.find((o) => iou(o, b) > threshold)
    if (!hit) {
      out.push({ ...b })
      continue
    }
    const x = Math.min(hit.x, b.x)
    const y = Math.min(hit.y, b.y)
    hit.w = Math.max(hit.x + hit.w, b.x + b.w) - x
    hit.h = Math.max(hit.y + hit.h, b.y + b.h) - y
    hit.x = x
    hit.y = y
    hit.score = Math.max(hit.score ?? 0, b.score ?? 0)
  }
  return out
}

/** Agrandit une boîte (marge relative de chaque côté) et la borne à l'image. */
export function padBox(b: Box, pad: number, width: number, height: number): Box {
  const x = Math.max(0, b.x - b.w * pad)
  const y = Math.max(0, b.y - b.h * pad)
  const w = Math.min(width, b.x + b.w * (1 + pad)) - x
  const h = Math.min(height, b.y + b.h * (1 + pad)) - y
  return { x, y, w, h, score: b.score }
}

/**
 * Marge selon la taille : un petit visage lointain bouge proportionnellement plus entre deux
 * détections (environ 2 à 3 par seconde sur téléphone) ; on l'entoure plus largement.
 */
export function marginFor(b: Box): number {
  const side = Math.max(b.w, b.h)
  if (side < 30) return 1
  if (side < 80) return 0.6
  return 0.4
}

/** Taille des blocs de pixelisation : assez gros pour qu'aucun trait ne subsiste. */
export function blockFor(b: Box): number {
  return Math.max(6, Math.round(Math.max(b.w, b.h) / 6))
}
