/**
 * YuNet (OpenCV Zoo, `face_detection_yunet_2023mar.onnx`, licence MIT) : détecteur de visages
 * minuscule (75 k paramètres, 232 Ko) entraîné sur WIDER FACE (foules, petits visages).
 *
 * Entrée FIXE 1×3×640×640, BGR, valeurs 0–255 (pas de normalisation). Sorties par pas (8, 16, 32) :
 * `cls_s`, `obj_s` (scores), `bbox_s` (cx, cy en cellules, log w, log h), `kps_s` (non utilisés).
 * Décodage identique à `cv::FaceDetectorYN` d'OpenCV.
 *
 * Ce module ne dépend d'aucune API navigateur : il est testé directement (yunet.test.ts).
 */
import type { Box } from './faces'

export const YUNET_SIZE = 640
const STRIDES = [8, 16, 32] as const

/** Région source de l'image recopiée (mise à l'échelle, sans déformation) dans le carré de 640 px. */
export interface Placement {
  sx: number
  sy: number
  sw: number
  sh: number
  /** Échelle source → 640. */
  scale: number
}

/** L'image entière, réduite pour tenir dans 640 × 640 (gros et moyens visages). */
export function wholePlacement(W: number, H: number): Placement {
  return { sx: 0, sy: 0, sw: W, sh: H, scale: YUNET_SIZE / Math.max(W, H) }
}

/**
 * Carrés de côté min(W, H) couvrant la grande dimension avec recouvrement (petits visages : en
 * 720 × 1280, 2 carrés de 720 px réduits à 640, visages détectés dès ~11 px). `offset` décale les
 * carrés (contrôle : un visage coupé par une frontière l'est ailleurs).
 */
export function squarePlacements(W: number, H: number, offset = 0): Placement[] {
  const side = Math.min(W, H)
  const long = Math.max(W, H)
  const n = Math.max(1, Math.ceil(long / side))
  const out: Placement[] = []
  for (let i = 0; i < n; i++) {
    const start = n === 1 ? 0 : Math.round(((long - side) * i) / (n - 1))
    const pos = Math.min(Math.max(0, start + offset), long - side)
    out.push(W >= H ? { sx: pos, sy: 0, sw: side, sh: side, scale: YUNET_SIZE / side } : { sx: 0, sy: pos, sw: side, sh: side, scale: YUNET_SIZE / side })
  }
  if (offset !== 0) {
    // Carré central supplémentaire : couvre la zone de recouvrement sous un autre cadrage.
    const mid = Math.round((long - side) / 2)
    out.push(W >= H ? { sx: mid, sy: 0, sw: side, sh: side, scale: YUNET_SIZE / side } : { sx: 0, sy: mid, sw: side, sh: side, scale: YUNET_SIZE / side })
  }
  return out
}

/** RGBA (640 × 640) → tenseur planaire BGR float32. */
export function toBgrPlanar(rgba: Uint8ClampedArray | Uint8Array, n = YUNET_SIZE): Float32Array {
  const plane = n * n
  const out = new Float32Array(3 * plane)
  for (let i = 0; i < plane; i++) {
    out[i] = rgba[i * 4 + 2]
    out[plane + i] = rgba[i * 4 + 1]
    out[2 * plane + i] = rgba[i * 4]
  }
  return out
}

type Outputs = Record<string, { data: ArrayLike<number> }>

/** Visages au-dessus de `minScore`, en coordonnées du carré 640 px. */
export function decode(outputs: Outputs, minScore: number, n = YUNET_SIZE): Box[] {
  const faces: Box[] = []
  for (const s of STRIDES) {
    const cls = outputs[`cls_${s}`]?.data
    const obj = outputs[`obj_${s}`]?.data
    const bbox = outputs[`bbox_${s}`]?.data
    if (!cls || !obj || !bbox) throw new Error(`sortie YuNet manquante (pas ${s})`)
    const cols = n / s
    const rows = n / s
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c
        const score = Math.sqrt(Math.min(1, Math.max(0, cls[i])) * Math.min(1, Math.max(0, obj[i])))
        if (score < minScore) continue
        const cx = (c + bbox[i * 4]) * s
        const cy = (r + bbox[i * 4 + 1]) * s
        const w = Math.exp(bbox[i * 4 + 2]) * s
        const h = Math.exp(bbox[i * 4 + 3]) * s
        faces.push({ x: cx - w / 2, y: cy - h / 2, w, h, score })
      }
    }
  }
  return faces
}

function iou(a: Box, b: Box): number {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x))
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y))
  const inter = ix * iy
  return inter / (a.w * a.h + b.w * b.h - inter || 1)
}

/** Suppression des non-maxima : un visage = une boîte (la mieux notée). */
export function nms(boxes: Box[], threshold = 0.3): Box[] {
  const sorted = [...boxes].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  const kept: Box[] = []
  for (const b of sorted) if (kept.every((k) => iou(k, b) <= threshold)) kept.push(b)
  return kept
}

/** Coordonnées du carré 640 px → coordonnées de l'image d'origine. */
export function mapBack(b: Box, p: Placement): Box {
  return { x: p.sx + b.x / p.scale, y: p.sy + b.y / p.scale, w: b.w / p.scale, h: b.h / p.scale, score: b.score }
}
