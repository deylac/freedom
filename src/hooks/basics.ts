import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { parseHash, routeToHash, type Route } from '../lib/hashtag'
import { connectionStatus } from '../lib/nostr/pool'
import { personalVersion, subscribePersonal } from '../lib/storage/personal'
import { getSettings, subscribeSettings, type Settings } from '../lib/storage/settings'

/** FR-01 — route dérivée du fragment ; aucune requête HTTP lors d'un changement de #. */
export function useHashRoute(): [Route, (route: Route) => void] {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash))
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash))
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  const navigate = useCallback((next: Route) => {
    const hash = routeToHash(next)
    if (hash) window.location.hash = hash
    else history.pushState(null, '', window.location.pathname + window.location.search)
    setRoute(parseHash(window.location.hash))
  }, [])
  return [route, navigate]
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, getSettings)
}

export function usePersonalVersion(): number {
  return useSyncExternalStore(subscribePersonal, personalVersion)
}

export function useRelayStatus(relays: string[]) {
  const [status, setStatus] = useState(() => connectionStatus(relays))
  useEffect(() => {
    const tick = () => setStatus(connectionStatus(relays))
    tick()
    const id = setInterval(tick, 1500)
    return () => clearInterval(id)
  }, [relays])
  return status
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const onChange = () => setMatches(mql.matches)
    mql.addEventListener('change', onChange)
    onChange()
    return () => mql.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** Horloge partagée pour l'horodatage relatif (« il y a 2 min »). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

/** Empêche la mise en veille de l'écran (enregistrement, envoi). */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let cancelled = false
    const acquire = () => {
      navigator.wakeLock
        .request('screen')
        .then((l) => {
          if (cancelled) void l.release()
          else lock = l
        })
        .catch(() => {})
    }
    acquire()
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !cancelled) acquire()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      void lock?.release().catch(() => {})
    }
  }, [active])
}

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

/** Parcours C — installation PWA (Android : prompt natif ; iOS : instructions). */
export function useInstallPrompt() {
  const deferred = useRef<BeforeInstallPromptEvent | null>(null)
  const [canPrompt, setCanPrompt] = useState(false)
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) && !/crios|fxios/i.test(navigator.userAgent)

  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault()
      deferred.current = e as BeforeInstallPromptEvent
      setCanPrompt(true)
    }
    window.addEventListener('beforeinstallprompt', onPrompt)
    return () => window.removeEventListener('beforeinstallprompt', onPrompt)
  }, [])

  const prompt = useCallback(async () => {
    const e = deferred.current
    if (!e) return false
    await e.prompt()
    const choice = await e.userChoice
    deferred.current = null
    setCanPrompt(false)
    return choice.outcome === 'accepted'
  }, [])

  return { standalone, ios, canPrompt, prompt }
}

/** Ferme au clavier (Échap). */
export function useEscape(onEscape: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onEscape()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onEscape, enabled])
}
