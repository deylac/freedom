/**
 * Nettoyage défensif d'un conteneur MP4/MOV produit par MediaRecorder.
 *
 * MediaRecorder n'écrit ni GPS ni marque/modèle (contrairement à l'appli Appareil photo),
 * mais le conteneur porte des dates de création (mvhd/tkhd/mdhd) et éventuellement des
 * boîtes de métadonnées utilisateur (udta : encodeur, ©xyz = position GPS QuickTime ; meta).
 *
 * Tout se fait EN PLACE, sans changer aucune taille de boîte (donc sans risque de casser
 * les offsets stco/co64) :
 *   - dates mises à 0 ;
 *   - boîtes `udta` et `meta` renommées `free` (ignorées par tous les lecteurs).
 * Doit être appliqué AVANT le calcul du SHA-256.
 */

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'mvex', 'moof', 'traf', 'dinf'])
const DATED = new Set(['mvhd', 'tkhd', 'mdhd'])
const NEUTRALIZE = new Set(['udta', 'meta'])

export interface ScrubReport {
  isMp4: boolean
  datesCleared: number
  boxesNeutralized: string[]
}

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3])

function writeFourcc(b: Uint8Array, at: number, type: string) {
  for (let i = 0; i < 4; i++) b[at + i] = type.charCodeAt(i)
}

export function isMp4(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && fourcc(bytes, 4) === 'ftyp'
}

export function scrubMp4InPlace(bytes: Uint8Array): ScrubReport {
  const report: ScrubReport = { isMp4: isMp4(bytes), datesCleared: 0, boxesNeutralized: [] }
  if (!report.isMp4) return report
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  const walk = (start: number, end: number, depth: number) => {
    let offset = start
    while (offset + 8 <= end) {
      let size = view.getUint32(offset)
      const type = fourcc(bytes, offset + 4)
      let header = 8
      if (size === 1) {
        if (offset + 16 > end) return
        const big = view.getBigUint64(offset + 8)
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return
        size = Number(big)
        header = 16
      } else if (size === 0) {
        size = end - offset
      }
      if (size < header || offset + size > end) return // structure corrompue : on s'arrête sans rien casser
      const boxEnd = offset + size

      if (DATED.has(type) && offset + header + 4 <= boxEnd) {
        const version = bytes[offset + header]
        const fieldLen = version === 1 ? 8 : 4
        const datesStart = offset + header + 4
        if (datesStart + fieldLen * 2 <= boxEnd) {
          bytes.fill(0, datesStart, datesStart + fieldLen * 2)
          report.datesCleared++
        }
      } else if (NEUTRALIZE.has(type)) {
        writeFourcc(bytes, offset + 4, 'free')
        report.boxesNeutralized.push(type)
      } else if (CONTAINERS.has(type) && depth < 8) {
        walk(offset + header, boxEnd, depth + 1)
      }
      offset = boxEnd
    }
  }

  walk(0, bytes.length, 0)
  return report
}

export async function scrubVideoBlob(blob: Blob): Promise<{ blob: Blob; report: ScrubReport }> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  const report = scrubMp4InPlace(bytes)
  return { blob: report.isMp4 ? new Blob([bytes], { type: blob.type }) : blob, report }
}
