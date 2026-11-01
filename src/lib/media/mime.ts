/**
 * FR-03 — Négociation dynamique du format d'enregistrement.
 *
 * Ordre de préférence : MP4 H.264/AAC d'abord (lisible nativement partout, y compris iPhone ;
 * enregistré nativement par Safari et Chrome ≥ 126), puis WebM.
 *
 * Correction du PRD : Firefox n'encode PAS de H.264 dans du WebM via MediaRecorder
 * (`video/webm;codecs="avc1…"` est une particularité de Chrome). Firefox se replie sur
 * VP8/Opus, que l'on place avant le H.264-en-WebM car VP8 est bien plus largement lisible
 * (Safari ≥ 14.1 / iOS ≥ 15) que le H.264 encapsulé en WebM.
 */
export const MIME_CANDIDATES = [
  'video/mp4;codecs="avc1.42E01F,mp4a.40.2"',
  'video/mp4;codecs="avc1.4D401F,mp4a.40.2"',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs="vp8,opus"',
  'video/webm;codecs="vp9,opus"',
  'video/webm;codecs="avc1.42E01F,opus"',
  'video/webm',
] as const

export function negotiateMime(isTypeSupported: (mime: string) => boolean): string | undefined {
  for (const mime of MIME_CANDIDATES) {
    try {
      if (isTypeSupported(mime)) return mime
    } catch {
      /* certains navigateurs lèvent une exception sur les chaînes de codecs inconnues */
    }
  }
  return undefined
}

export interface CaptureSupport {
  ok: boolean
  reason?: string
  mime?: string
}

/** Diagnostic des capacités du navigateur avant d'ouvrir la caméra. */
export function detectCaptureSupport(): CaptureSupport {
  if (typeof window === 'undefined') return { ok: false, reason: 'Environnement sans navigateur' }
  if (!window.isSecureContext) {
    return { ok: false, reason: 'La caméra exige une connexion sécurisée (https).' }
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    return {
      ok: false,
      reason: isInAppBrowser()
        ? "Ce navigateur intégré (Instagram, Facebook, WhatsApp…) bloque la caméra. Ouvrez le lien dans Safari ou Chrome."
        : "Ce navigateur ne donne pas accès à la caméra.",
    }
  }
  if (typeof MediaRecorder === 'undefined') {
    return { ok: false, reason: "Ce navigateur ne sait pas enregistrer de vidéo (MediaRecorder absent)." }
  }
  if (typeof HTMLCanvasElement.prototype.captureStream !== 'function') {
    return { ok: false, reason: 'Ce navigateur ne permet pas la capture via canvas (purge des métadonnées impossible).' }
  }
  const mime = negotiateMime((m) => MediaRecorder.isTypeSupported(m))
  if (!mime) return { ok: false, reason: 'Aucun format vidéo enregistrable par ce navigateur.' }
  return { ok: true, mime }
}

export function isInAppBrowser(ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''): boolean {
  return /FBAN|FBAV|Instagram|Line\/|WhatsApp|Snapchat|TikTok|; wv\)/i.test(ua)
}
