/**
 * Stockage local tolérant aux pannes.
 *
 * Angle mort traité : sur une passerelle IPFS « par chemin » (https://passerelle/ipfs/<cid>/),
 * TOUS les sites IPFS partagent la même origine, donc le même localStorage. N'importe quelle
 * page IPFS pourrait y lire la clé secrète nsec. Dans ce cas on bascule sur un stockage en
 * mémoire (perdu à la fermeture) et l'interface affiche un avertissement.
 */

const PREFIX = 'hw:'

export function isSharedOriginGateway(loc: Pick<Location, 'pathname'> = globalThis.location): boolean {
  return !!loc && /^\/(ipfs|ipns)\//.test(loc.pathname)
}

const memory = new Map<string, string>()

function backend(): Storage | null {
  if (typeof window === 'undefined' || isSharedOriginGateway()) return null
  try {
    const s = window.localStorage
    const probe = `${PREFIX}probe`
    s.setItem(probe, '1')
    s.removeItem(probe)
    return s
  } catch {
    return null
  }
}

let cached: Storage | null | undefined

function store(): Storage | null {
  if (cached === undefined) cached = backend()
  return cached
}

export const persistentStorageAvailable = (): boolean => store() !== null

export function readJSON<T>(key: string, fallback: T): T {
  const k = PREFIX + key
  try {
    const raw = store()?.getItem(k) ?? memory.get(k) ?? null
    return raw === null ? fallback : (JSON.parse(raw) as T)
  } catch {
    return fallback
  }
}

export function writeJSON(key: string, value: unknown): void {
  const k = PREFIX + key
  const raw = JSON.stringify(value)
  memory.set(k, raw)
  try {
    store()?.setItem(k, raw)
  } catch {
    /* quota ou stockage bloqué : la copie mémoire suffit pour la session */
  }
}

export function removeKey(key: string): void {
  const k = PREFIX + key
  memory.delete(k)
  try {
    store()?.removeItem(k)
  } catch {
    /* ignoré */
  }
}

/** Efface toutes les clés HashWall (bouton « Tout effacer » / panique). */
export function wipeLocalKeys(): void {
  for (const k of [...memory.keys()]) if (k.startsWith(PREFIX)) memory.delete(k)
  const s = store()
  if (!s) return
  try {
    const keys: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k?.startsWith(PREFIX)) keys.push(k)
    }
    keys.forEach((k) => s.removeItem(k))
  } catch {
    /* ignoré */
  }
}
