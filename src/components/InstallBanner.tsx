import { useInstallPrompt, useSettings } from '../hooks/basics'
import { updateSettings } from '../lib/storage/settings'
import { IconClose, IconShare } from './icons'

/** Parcours C — bannière discrète d'installation PWA. */
export function InstallBanner() {
  const settings = useSettings()
  const { standalone, ios, canPrompt, prompt } = useInstallPrompt()
  if (standalone || settings.installBannerDismissed || (!canPrompt && !ios)) return null
  const dismiss = () => updateSettings({ installBannerDismissed: true })
  return (
    <div className="animate-rise fixed inset-x-3 top-[calc(env(safe-area-inset-top)+4.5rem)] z-30 mx-auto flex max-w-md items-center gap-3 rounded-2xl border border-line bg-surface/95 p-3 text-sm shadow-xl backdrop-blur">
      <img src="./icons/icon.svg" alt="" className="h-9 w-9 rounded-lg" />
      <p className="min-w-0 flex-1 text-white/90">
        {ios ? (
          <>
            Installez HashWall : <IconShare size={14} className="inline align-[-2px] text-accent" /> puis « Sur l’écran d’accueil ».
          </>
        ) : (
          'Installer HashWall sur l’écran d’accueil (plein écran, lancement rapide).'
        )}
      </p>
      {canPrompt && (
        <button
          className="rounded-lg bg-accent px-3 py-1.5 font-semibold text-night"
          onClick={async () => {
            if (await prompt()) dismiss()
          }}
        >
          Installer
        </button>
      )}
      <button onClick={dismiss} aria-label="Ne plus proposer" className="p-1 text-muted">
        <IconClose size={18} />
      </button>
    </div>
  )
}
