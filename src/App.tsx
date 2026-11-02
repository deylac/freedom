import { useEffect, useState } from 'react'
import { TERMS_VERSION } from './config'
import { useHashRoute, useSettings } from './hooks/basics'
import { refreshSignedMirrors } from './lib/mirrors'
import { publisher } from './lib/publish'
import { onRemoteWipe } from './lib/storage/outbox'
import { BundleImportSheet, BundleShareSheet } from './components/BundleSheets'
import { CaptureScreen } from './components/CaptureScreen'
import { Home } from './components/Home'
import { InstallBanner } from './components/InstallBanner'
import { NetworkBanner } from './components/NetworkBanner'
import { PublishTray } from './components/PublishTray'
import { QrModal } from './components/QrModal'
import { RescueSheet } from './components/RescueSheet'
import { CodecBenchSheet } from './components/CodecBenchSheet'
import { SettingsSheet } from './components/SettingsSheet'
import { TermsModal } from './components/TermsModal'
import { ToastProvider } from './components/ui'
import { WallView } from './components/WallView'

export default function App() {
  const [route, navigate] = useHashRoute()
  const settings = useSettings()
  const [bundleJob, setBundleJob] = useState<string | null>(null)
  const [overlay, setOverlay] = useState<'none' | 'terms' | 'capture' | 'qr' | 'settings' | 'rescue' | 'import' | 'codecs'>('none')

  // Reprise des envois interrompus (fermeture d'onglet, coupure réseau).
  useEffect(() => {
    void publisher.resumeAll()
    const onOnline = () => void publisher.resumeAll()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [])

  // Effacement des données demandé dans un autre onglet : on arrête tout et on recharge (audit F03).
  useEffect(
    () =>
      onRemoteWipe(() => {
        publisher.stopAll()
        location.reload()
      }),
    [],
  )

  // Liste signée des adresses de secours : mise en cache, elle survit au blocage de cette adresse.
  useEffect(() => {
    const id = setTimeout(() => void refreshSignedMirrors(settings.relays).catch(() => {}), 3000)
    return () => clearTimeout(id)
  }, [settings.relays])

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

      <PublishTray onBundle={setBundleJob} />
      {overlay === 'none' && <InstallBanner />}
      {overlay === 'none' && <NetworkBanner onHelp={() => setOverlay('rescue')} />}

      {overlay === 'terms' && tag && <TermsModal onAccept={() => setOverlay('capture')} onClose={close} />}
      {overlay === 'capture' && tag && <CaptureScreen tag={tag} onClose={close} />}
      {overlay === 'qr' && tag && <QrModal tag={tag} onClose={close} />}
      {overlay === 'settings' && <SettingsSheet onClose={close} onRescue={() => setOverlay('rescue')} onImport={() => setOverlay('import')} onCodecBench={() => setOverlay('codecs')} />}
      {overlay === 'codecs' && <CodecBenchSheet onClose={close} />}
      {overlay === 'import' && <BundleImportSheet onClose={close} />}
      {bundleJob && <BundleShareSheet jobId={bundleJob} onClose={() => setBundleJob(null)} />}
      {overlay === 'rescue' && <RescueSheet tag={tag} onClose={close} />}
    </ToastProvider>
  )
}
