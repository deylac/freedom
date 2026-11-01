import { TERMS_VERSION } from '../config'
import { updateSettings } from '../lib/storage/settings'
import { Button, Sheet } from './ui'

export function TermsModal({ onAccept, onClose }: { onAccept: () => void; onClose: () => void }) {
  return (
    <Sheet title="Avant de filmer" onClose={onClose} labelledBy="terms-title">
      <div className="space-y-4 text-sm leading-relaxed text-white/90">
        <p>
          HashWall est un outil de <strong>journalisme citoyen</strong> : vos vidéos documentent des faits d’intérêt public.
          Aucune inscription, aucun email : une clé anonyme est créée sur votre téléphone.
        </p>
        <div className="rounded-xl border border-rec/40 bg-rec/10 p-3">
          <p className="font-semibold text-white">Strictement interdit</p>
          <p className="text-white/85">
            Contenus pédocriminels, appels au meurtre ou à la violence, apologie du terrorisme, harcèlement. Ces contenus
            sont signalés aux hébergeurs, qui les suppriment et peuvent coopérer avec les autorités.
          </p>
        </div>
        <ul className="list-disc space-y-1.5 pl-5 text-white/80">
          <li>
            <strong className="text-white">Publication publique et durable.</strong> La vidéo est copiée sur plusieurs
            serveurs indépendants, <strong className="text-white">non chiffrée</strong> : tout le monde peut la regarder, hébergeurs
            compris. L’empreinte et la signature prouvent qu’elle n’a pas été modifiée, pas qu’elle est confidentielle. Une
            suppression peut être demandée mais jamais garantie.
          </li>
          <li>
            <strong className="text-white">Pensez aux personnes filmées.</strong> Un visage reconnaissable peut les exposer.
            Utilisez le filtre « Visages floutés » quand c’est possible, et « Voix robot » pour masquer votre voix.
          </li>
          <li>
            <strong className="text-white">Votre adresse IP</strong> reste visible des relais et serveurs média contactés.
            Si vous êtes exposé·e, utilisez un VPN ou Tor.
          </li>
          <li>Les coordonnées GPS et les informations sur l’appareil sont supprimées avant l’envoi.</li>
        </ul>
        <Button
          className="w-full"
          onClick={() => {
            updateSettings({ termsAcceptedVersion: TERMS_VERSION })
            onAccept()
          }}
          data-testid="accept-terms"
        >
          J’ai compris, filmer
        </Button>
      </div>
    </Sheet>
  )
}
