/**
 * Banc d'essai des formats vidéo (Réglages → Diagnostic).
 *
 * But : mesurer SUR DE VRAIS TÉLÉPHONES si un codec plus efficace (HEVC, AV1) permet d'alléger les
 * vidéos sans perte visible, avant de construire la double version (H.264 universel + HEVC léger).
 *
 * 1. Sonde : ce que l'appareil sait ENREGISTRER (MediaRecorder), ENCODER (WebCodecs, matériel ou
 *    non) et LIRE (<video>.canPlayType, MediaCapabilities : fluide / économe en énergie).
 * 2. Essai : la même image (caméra + filigrane, comme en vrai) est enregistrée SIMULTANÉMENT dans
 *    chaque format. Les tailles sont donc comparables, et l'essai vérifie au passage que deux
 *    encodeurs peuvent tourner en parallèle (condition de la double version).
 *
 * Rien n'est envoyé : les fichiers restent dans la page et disparaissent à sa fermeture.
 */
import { CAPTURE_FPS, CAPTURE_HEIGHT, CAPTURE_WIDTH } from '../../config'
import { baseMime } from '../blossom/urls'

export type CodecFamily = 'h264' | 'hevc' | 'av1' | 'vp9'

export interface BenchVariant {
  id: string
  label: string
  family: CodecFamily
  /** Débits visés (MediaRecorder les traite comme une consigne, pas une garantie). */
  videoBps: number
  audioBps: number
  /** Formats MediaRecorder candidats, par ordre de préférence. */
  mimes: string[]
}

const HEVC_MIMES = [
  'video/mp4;codecs="hvc1.1.6.L93.B0,mp4a.40.2"',
  'video/mp4;codecs="hev1.1.6.L93.B0,mp4a.40.2"',
  'video/mp4;codecs=hvc1,mp4a.40.2',
  'video/mp4;codecs="hvc1.1.6.L93.B0,opus"',
  'video/mp4;codecs="hev1.1.6.L93.B0,opus"',
]

/** Référence = réglage actuel de l'application (profil « Standard »). */
export const BENCH_VARIANTS: BenchVariant[] = [
  {
    id: 'h264-actuel',
    label: 'H.264 actuel (2 Mbit/s)',
    family: 'h264',
    videoBps: 2_000_000,
    audioBps: 96_000,
    mimes: ['video/mp4;codecs="avc1.42E01F,mp4a.40.2"', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'],
  },
  {
    id: 'h264-opt',
    label: 'H.264 optimisé (High, 1,5 Mbit/s)',
    family: 'h264',
    videoBps: 1_500_000,
    audioBps: 64_000,
    mimes: [
      'video/mp4;codecs="avc1.64001F,mp4a.40.2"',
      'video/mp4;codecs="avc1.4D401F,mp4a.40.2"',
      // Navigateurs sans encodeur AAC (Chromium libre) : même vidéo, son en Opus.
      'video/mp4;codecs="avc1.64001F,opus"',
      'video/mp4;codecs="avc1.4D401F,opus"',
    ],
  },
  {
    id: 'hevc',
    label: 'HEVC (1,1 Mbit/s)',
    family: 'hevc',
    videoBps: 1_100_000,
    audioBps: 64_000,
    mimes: HEVC_MIMES,
  },
  {
    id: 'hevc-bas',
    label: 'HEVC serré (0,8 Mbit/s)',
    family: 'hevc',
    videoBps: 800_000,
    audioBps: 64_000,
    mimes: HEVC_MIMES,
  },
  {
    id: 'av1',
    label: 'AV1 (1 Mbit/s)',
    family: 'av1',
    videoBps: 1_000_000,
    audioBps: 64_000,
    mimes: ['video/mp4;codecs="av01.0.05M.08,mp4a.40.2"', 'video/mp4;codecs="av01.0.05M.08,opus"', 'video/webm;codecs="av01.0.05M.08,opus"', 'video/webm;codecs=av1,opus'],
  },
]

/** VP9 n'a pas de variante d'essai (pas de lecture native sur les anciens iPhone) : sondé seulement. */
const VP9_MIMES = ['video/webm;codecs="vp9,opus"', 'video/webm;codecs=vp9']

/** Chaînes de codec « vidéo seule » pour WebCodecs et la lecture (720×1280, 30 i/s). */
export const FAMILY_CODEC: Record<CodecFamily, { label: string; codec: string; playType: string }> = {
  h264: { label: 'H.264', codec: 'avc1.64001F', playType: 'video/mp4; codecs="avc1.64001F"' },
  hevc: { label: 'HEVC (H.265)', codec: 'hvc1.1.6.L93.B0', playType: 'video/mp4; codecs="hvc1.1.6.L93.B0"' },
  av1: { label: 'AV1', codec: 'av01.0.05M.08', playType: 'video/mp4; codecs="av01.0.05M.08"' },
  vp9: { label: 'VP9', codec: 'vp09.00.31.08', playType: 'video/webm; codecs="vp09.00.31.08"' },
}

/** Premier format accepté par l'enregistreur (les navigateurs peuvent lever sur une chaîne inconnue). */
export function pickMime(variant: Pick<BenchVariant, 'mimes'>, isTypeSupported: (mime: string) => boolean): string | null {
  for (const mime of variant.mimes) {
    try {
      if (isTypeSupported(mime)) return mime
    } catch {
      /* chaîne inconnue */
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// Sonde

export type Tri = 'oui' | 'non' | 'inconnu'

export interface FamilyProbe {
  family: CodecFamily
  /** MediaRecorder accepte au moins un format de cette famille. */
  record: Tri
  recordMime: string | null
  /** WebCodecs : encodeur disponible (et s'il est annoncé matériel). */
  encode: Tri
  encodeHardware: Tri
  /** Lecture : canPlayType (« probably »/« maybe »/« ») et MediaCapabilities. */
  canPlay: string
  decode: Tri
  smooth: Tri
  powerEfficient: Tri
}

export interface BenchEnv {
  isTypeSupported?: (mime: string) => boolean
  isConfigSupported?: (config: VideoEncoderConfig) => Promise<{ supported?: boolean }>
  canPlayType?: (type: string) => string
  decodingInfo?: (config: MediaDecodingConfiguration) => Promise<{ supported: boolean; smooth: boolean; powerEfficient: boolean }>
}

export function browserEnv(): BenchEnv {
  const env: BenchEnv = {}
  if (typeof MediaRecorder !== 'undefined') env.isTypeSupported = (m) => MediaRecorder.isTypeSupported(m)
  if (typeof VideoEncoder !== 'undefined') env.isConfigSupported = (c) => VideoEncoder.isConfigSupported(c)
  if (typeof document !== 'undefined') {
    const v = document.createElement('video')
    env.canPlayType = (t) => v.canPlayType(t)
  }
  if (typeof navigator !== 'undefined' && navigator.mediaCapabilities?.decodingInfo) {
    env.decodingInfo = (c) => navigator.mediaCapabilities.decodingInfo(c)
  }
  return env
}

const tri = (b: boolean | undefined): Tri => (b === undefined ? 'inconnu' : b ? 'oui' : 'non')

async function settle<T>(p: () => Promise<T>, ms = 4000): Promise<T | undefined> {
  try {
    return await Promise.race([p(), new Promise<undefined>((r) => setTimeout(() => r(undefined), ms))])
  } catch {
    return undefined
  }
}

export async function probeFamily(family: CodecFamily, env: BenchEnv): Promise<FamilyProbe> {
  const { codec, playType } = FAMILY_CODEC[family]
  const variants = BENCH_VARIANTS.filter((v) => v.family === family)
  const mimes = family === 'vp9' ? VP9_MIMES : variants.flatMap((v) => v.mimes)
  const recordMime = env.isTypeSupported ? pickMime({ mimes }, env.isTypeSupported) : null
  const base = { codec, width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT, bitrate: 1_500_000, framerate: CAPTURE_FPS }
  const [sw, hw] = env.isConfigSupported
    ? await Promise.all([
        settle(() => env.isConfigSupported!({ ...base })),
        settle(() => env.isConfigSupported!({ ...base, hardwareAcceleration: 'prefer-hardware' })),
      ])
    : [undefined, undefined]
  const canPlay = env.canPlayType ? env.canPlayType(playType) : ''
  const info = env.decodingInfo
    ? await settle(() =>
        env.decodingInfo!({
          type: 'file',
          video: { contentType: playType, width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT, bitrate: 1_500_000, framerate: CAPTURE_FPS },
        }),
      )
    : undefined
  return {
    family,
    record: env.isTypeSupported ? tri(!!recordMime) : 'inconnu',
    recordMime,
    encode: env.isConfigSupported ? tri(!!(sw?.supported || hw?.supported)) : 'inconnu',
    encodeHardware: env.isConfigSupported ? tri(!!hw?.supported) : 'inconnu',
    canPlay,
    decode: info ? tri(info.supported) : canPlay ? 'oui' : env.canPlayType ? 'non' : 'inconnu',
    smooth: info ? tri(info.smooth) : 'inconnu',
    powerEfficient: info ? tri(info.powerEfficient) : 'inconnu',
  }
}

export function probeAll(env: BenchEnv = browserEnv()): Promise<FamilyProbe[]> {
  return Promise.all((['h264', 'hevc', 'av1', 'vp9'] as CodecFamily[]).map((f) => probeFamily(f, env)))
}

// ---------------------------------------------------------------------------
// Essai simultané

export interface BenchResult {
  variant: BenchVariant
  /** Format réellement produit par l'enregistreur (null : non pris en charge). */
  mime: string | null
  bytes: number
  durationSec: number
  error?: string
  blob?: Blob
}

/** Mo par minute de vidéo (extrapolé depuis l'essai). */
export const mbPerMinute = (r: Pick<BenchResult, 'bytes' | 'durationSec'>): number =>
  r.durationSec > 0 ? (r.bytes / r.durationSec) * 60 / 1_000_000 : 0

/** Débit réel en Mbit/s. */
export const actualMbps = (r: Pick<BenchResult, 'bytes' | 'durationSec'>): number =>
  r.durationSec > 0 ? (r.bytes * 8) / r.durationSec / 1_000_000 : 0

/** Écart de poids par rapport à la référence (négatif = plus léger), en %. */
export function savingVs(ref: Pick<BenchResult, 'bytes' | 'durationSec'> | undefined, r: Pick<BenchResult, 'bytes' | 'durationSec'>): number | null {
  if (!ref || ref.bytes <= 0 || r.bytes <= 0) return null
  return Math.round((mbPerMinute(r) / mbPerMinute(ref) - 1) * 100)
}

/**
 * Enregistre la même source dans chaque format accepté, en parallèle. Un enregistreur qui échoue
 * (encodeur matériel déjà occupé, format refusé au démarrage) est signalé sans arrêter les autres.
 */
export function recordSimultaneously(
  tracks: MediaStreamTrack[],
  durationMs: number,
  variants: BenchVariant[] = BENCH_VARIANTS,
): { done: Promise<BenchResult[]>; stop: () => void } {
  const stream = new MediaStream(tracks)
  const runs = variants.map((variant) => {
    const mime = pickMime(variant, (m) => MediaRecorder.isTypeSupported(m))
    if (!mime) return { variant, recorder: null as MediaRecorder | null, mime: null as string | null, chunks: [] as Blob[], error: undefined as string | undefined }
    try {
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: variant.videoBps, audioBitsPerSecond: variant.audioBps })
      return { variant, recorder, mime, chunks: [] as Blob[], error: undefined as string | undefined }
    } catch (err) {
      return { variant, recorder: null, mime, chunks: [] as Blob[], error: err instanceof Error ? `${err.name} : ${err.message}` : String(err) }
    }
  })
  const started = performance.now()
  let timer: ReturnType<typeof setTimeout> | null = null
  const stopAll = () => {
    if (timer) clearTimeout(timer)
    timer = null
    for (const r of runs) if (r.recorder?.state === 'recording') r.recorder.stop()
  }
  const done = Promise.all(
    runs.map(
      (r) =>
        new Promise<BenchResult>((resolve) => {
          const finish = (error?: string) => {
            const durationSec = Math.max(0.1, (performance.now() - started) / 1000)
            const type = baseMime(r.recorder?.mimeType || r.mime || 'video/mp4')
            const blob = r.chunks.length ? new Blob(r.chunks, { type }) : undefined
            resolve({ variant: r.variant, mime: r.recorder?.mimeType || r.mime, bytes: blob?.size ?? 0, durationSec, error: error ?? r.error, blob })
          }
          const rec = r.recorder
          if (!rec) return finish()
          rec.ondataavailable = (e) => {
            if (e.data?.size) r.chunks.push(e.data)
          }
          rec.onerror = (e) => {
            const err = (e as unknown as { error?: DOMException }).error
            finish(err ? `${err.name} : ${err.message}` : 'erreur de l’encodeur')
          }
          rec.onstop = () => finish()
          try {
            rec.start(1000)
          } catch (err) {
            finish(err instanceof Error ? `${err.name} : ${err.message}` : String(err))
          }
        }),
    ),
  )
  timer = setTimeout(stopAll, durationMs)
  return { done, stop: stopAll }
}

// ---------------------------------------------------------------------------
// Rapport texte (à copier et transmettre)

const fmt = (n: number, d = 1) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })

export function formatReport(probes: FamilyProbe[], results: BenchResult[] | null, extra: { userAgent: string; playable?: Record<string, boolean> }): string {
  const lines = [`Banc d'essai des formats — ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`, extra.userAgent, '']
  lines.push('Format | Enregistrer | Encoder (matériel) | Lire (fluide, économe)')
  for (const p of probes) {
    lines.push(
      `${FAMILY_CODEC[p.family].label} | ${p.record}${p.recordMime ? ` (${p.recordMime})` : ''} | ${p.encode} (${p.encodeHardware}) | ${p.decode} (${p.smooth}, ${p.powerEfficient})${p.canPlay ? ` canPlayType=${p.canPlay}` : ''}`,
    )
  }
  if (results) {
    const ref = results.find((r) => r.variant.id === 'h264-actuel' && r.bytes > 0)
    lines.push('', `Essai simultané (${fmt(results[0]?.durationSec ?? 0)} s)`)
    for (const r of results) {
      if (!r.mime) {
        lines.push(`${r.variant.label} : non pris en charge par l'enregistreur`)
        continue
      }
      if (r.error || r.bytes === 0) {
        lines.push(`${r.variant.label} : ÉCHEC ${r.error ?? 'fichier vide'} [${r.mime}]`)
        continue
      }
      const s = savingVs(ref, r)
      const play = extra.playable?.[r.variant.id]
      lines.push(
        `${r.variant.label} : ${fmt(mbPerMinute(r))} Mo/min, ${fmt(actualMbps(r), 2)} Mbit/s réels${s !== null && r !== ref ? `, ${s > 0 ? '+' : ''}${s} %` : ''}${play === undefined ? '' : play ? ', relu ici' : ', ILLISIBLE ici'} [${r.mime}]`,
      )
    }
  }
  return lines.join('\n')
}
