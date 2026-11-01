import { useEffect, useState } from 'react'
import { TERMS_VERSION } from './config'
import { useHashRoute, useSettings } from './hooks/basics'
import { publisher } from './lib/publish'
import { CaptureScreen } from './components/CaptureScreen'
import { Home } from './components/Home'
import { InstallBanner } from './components/InstallBanner'
import { PublishTray } from './components/PublishTray'
import { QrModal } from './components/QrModal'
import { SettingsSheet } from './components/SettingsSheet'
import { TermsModal } from './components/TermsModal'
import { ToastProvider } from './components/ui'
import { WallView } from './components/WallView'

export default function App() {
  const [route, navigate] = useHashRoute()
  const settings = useSettings()
  const [overlay, setOverlay] = useState<'none' | 'terms' | 'capture' | 'qr' | 'settings'>('none')

  // Reprise des envois interrompus (fermeture d'onglet, coupure réseau).
  useEffect(() => {
    void publisher.resumeAll()
    const onOnline = () => void publisher.resumeAll()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  // Changer de mur ferme les surcouches liées au mur précédent.
  const tag = route.view === 'wall' ? route.tag : null
  useEffect(() => {
    setOverlay((o) => (o === 'qr' || o === 'capture' ? 'none' : o))
    document.title = tag ? `#${tag} — HashWall` : 'HashWall'
  }, [tag])

  const record = () => setOverlay(settings.termsAcceptedVersion >= TERMS_VERSION ? 'capture' : 'terms')
  const close = () => setOverlay('none')

  return (
    <ToastProvider>
      {route.view === 'wall' ? (
        <WallView
          key={route.tag}
          tag={route.tag}
          focusPointer={route.clip}
          navigate={navigate}
          onRecord={record}
          onQr={() => setOverlay('qr')}
          onSettings={() => setOverlay('settings')}
        />
      ) : (
        <Home navigate={navigate} onSettings={() => setOverlay('settings')} />
      )}

      <PublishTray />
      {overlay === 'none' && <InstallBanner />}

      {overlay === 'terms' && tag && <TermsModal onAccept={() => setOverlay('capture')} onClose={close} />}
      {overlay === 'capture' && tag && <CaptureScreen tag={tag} onClose={close} />}
      {overlay === 'qr' && tag && <QrModal tag={tag} onClose={close} />}
      {overlay === 'settings' && <SettingsSheet onClose={close} />}
    </ToastProvider>
  )
}
