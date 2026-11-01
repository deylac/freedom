const rtf = new Intl.RelativeTimeFormat('fr', { numeric: 'auto' })

/** « il y a 2 min », « hier »… */
export function relativeTime(unixSeconds: number, now = Date.now()): string {
  const diff = unixSeconds - now / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return "à l'instant"
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day')
  return new Date(unixSeconds * 1000).toLocaleDateString('fr-FR')
}

/** 58.4 → « 0:58 » */
export function formatDuration(seconds?: number): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return ''
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} Ko`
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} Mo`
}

export function absoluteDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString('fr-FR', { dateStyle: 'medium', timeStyle: 'medium' })
}

export function shortHash(sha: string): string {
  return `${sha.slice(0, 8)}…${sha.slice(-8)}`
}
