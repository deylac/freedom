import { useEffect, useState } from 'react'
import { useReadRelays, useRelayStatus } from '../hooks/basics'
import { IconAlert, IconClose } from './icons'

/** Délai sans aucun relais joignable avant d'expliquer le blocage (le premier contact prend 1–3 s). */
export const BLOCKED_AFTER_MS = 15_000

/**
 * Diagnostic « réseau bloqué » : un mur vide sans explication ressemble à un mur sans vidéos.
 * Si aucun relais ne répond, on le dit et on propose les adresses de secours.
 */
export function NetworkBanner({ onHelp }: { onHelp: () => void }) {
  const reading = useReadRelays()
  const { connected } = useRelayStatus(reading)
  const [online, setOnline] = useState(() => navigator.onLine)
  const [blocked, setBlocked] = useState(false)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  // Retour de l'onglet au premier plan : les connexions reprennent, ce n'est pas un blocage. Le délai
  // ne compte que le temps passé au premier plan (constat réel : fausse alerte au réveil de l'onglet).
  const [visibleSince, setVisibleSince] = useState(() => Date.now())
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const update = () => {
      const v = document.visibilityState === 'visible'
      setVisible(v)
      if (v) setVisibleSince(Date.now())
    }
    document.addEventListener('visibilitychange', update)
    window.addEventListener('pageshow', update)
    return () => {
      document.removeEventListener('visibilitychange', update)
      window.removeEventListener('pageshow', update)
    }
  }, [])

  useEffect(() => {
    if (connected > 0 || !online || !visible) {
      setBlocked(false)
      return
    }
    const id = setTimeout(() => setBlocked(true), BLOCKED_AFTER_MS)
    return () => clearTimeout(id)
  }, [connected, online, visible, visibleSince])

  if (dismissed || (online && !blocked)) return null
  return (
    <div
      className="fixed inset-x-3 bottom-24 z-40 mx-auto flex max-w-md items-start gap-3 rounded-2xl border border-rec/60 bg-surface/95 p-3 text-sm text-white shadow-2xl backdrop-blur"
      role="alert"
      data-testid="network-banner"
    >
      <IconAlert size={18} className="mt-0.5 shrink-0 text-rec" />
      <div className="min-w-0 flex-1">
        {online ? (
          <>
            <p className="font-semibold">Aucun relais ne répond</p>
            <p className="text-muted">Votre réseau bloque peut-être HashWall. Vos vidéos restent enregistrées et partiront plus tard.</p>
          </>
        ) : (
          <>
            <p className="font-semibold">Hors ligne</p>
            <p className="text-muted">Vous pouvez filmer : la vidéo sera publiée dès le retour du réseau.</p>
          </>
        )}
        <button className="mt-1 font-semibold text-accent underline" onClick={onHelp}>
          Que faire ? Adresses de secours
        </button>
      </div>
      <button aria-label="Masquer" className="-m-1 p-1 text-muted hover:text-white" onClick={() => setDismissed(true)}>
        <IconClose size={16} />
      </button>
    </div>
  )
}
