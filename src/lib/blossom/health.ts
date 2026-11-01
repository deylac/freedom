/**
 * Mémoire des serveurs défaillants (« disjoncteur »).
 *
 * Constaté en conditions réelles : un serveur qui ne répond pas fait attendre 45 à 90 s à chaque
 * clip. Un serveur en délai dépassé ou injoignable est mis de côté 30 minutes : il n'est plus
 * essayé qu'en dernier recours pour l'envoi principal, et plus du tout pour les miroirs.
 * (Un refus HTTP explicite n'est pas une panne : il est rapide et peut dépendre du fichier.)
 */
import { readJSON, writeJSON } from '../storage/local'

const KEY = 'server-health'
const PENALTY_MS = 30 * 60 * 1000

type Health = Record<string, { until: number; reason: string }>

const read = (): Health => readJSON<Health>(KEY, {})

export function penalize(server: string, reason: string, now = Date.now()): void {
  const health = read()
  health[server] = { until: now + PENALTY_MS, reason }
  writeJSON(KEY, health)
}

export function markHealthy(server: string): void {
  const health = read()
  if (!(server in health)) return
  delete health[server]
  writeJSON(KEY, health)
}

export function penaltyOf(server: string, now = Date.now()): string | null {
  const entry = read()[server]
  return entry && entry.until > now ? entry.reason : null
}

/** Serveurs sains d'abord (ordre de préférence conservé), serveurs pénalisés en dernier. */
export function orderByHealth(servers: string[], now = Date.now()): { healthy: string[]; penalized: string[] } {
  const healthy: string[] = []
  const penalized: string[] = []
  for (const s of servers) (penaltyOf(s, now) ? penalized : healthy).push(s)
  return { healthy, penalized }
}
