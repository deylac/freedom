/**
 * Adresses de secours (docs/RESILIENCE.md, R2) : où retrouver HashWall si cette adresse est bloquée,
 * et que faire si le réseau bloque les relais. Tout est généré localement (QR compris).
 */
import { useMemo, useState } from 'react'
import { useRelayStatus, useSettings } from '../hooks/basics'
import { knownMirrors, type Mirror } from '../lib/mirrors'
import { QrSvg } from './QrModal'
import { IconLink, IconShare } from './icons'
import { copyText, Sheet, shareLink, useToast } from './ui'

const SOURCE_LABEL: Record<Mirror['source'], string> = {
  actuelle: 'cette adresse',
  signée: 'liste signée du projet',
  intégrée: 'intégrée à l’application',
}

export function RescueSheet({ tag, onClose }: { tag: string | null; onClose: () => void }) {
  const toast = useToast()
  const settings = useSettings()
  const { connected, total } = useRelayStatus(settings.relays)
  const mirrors = useMemo(() => knownMirrors(), [])
  const [qr, setQr] = useState<string | null>(null)
  const link = (m: Mirror) => (tag ? `${m.url}#${tag}` : m.url)

  return (
    <Sheet title="Adresses de secours" onClose={onClose} wide>
      <div className="space-y-4 text-sm text-white" data-testid="rescue">
        <p className="text-muted">
          HashWall n’a pas de serveur central : la même application est publiée à plusieurs adresses et chacune
          affiche les mêmes murs. Si une adresse est bloquée, utilisez-en une autre. Une fois ouverte, l’application
          installée continue de démarrer même si son adresse est bloquée.
        </p>

        <ul className="space-y-2">
          {mirrors.map((m) => (
            <li key={m.url} className="rounded-xl border border-line bg-night p-3" data-mirror={m.url} data-source={m.source}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="break-all font-mono text-xs text-white">{link(m)}</p>
                  <p className="mt-0.5 text-xs text-muted">
                    {m.label ? `${m.label} · ` : ''}
                    {SOURCE_LABEL[m.source]}
                    {m.url.includes('.onion') ? ' · Tor Browser' : ''}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    className="rounded-lg border border-line px-2 py-1 text-xs hover:border-accent"
                    onClick={() => setQr((q) => (q === m.url ? null : m.url))}
                    aria-expanded={qr === m.url}
                  >
                    QR
                  </button>
                  <button
                    className="rounded-lg border border-line p-1.5 hover:border-accent"
                    aria-label="Copier l’adresse"
                    onClick={async () => toast((await copyText(link(m))) ? 'Adresse copiée' : 'Copie impossible', 'ok')}
                  >
                    <IconLink size={14} />
                  </button>
                  <button
                    className="rounded-lg border border-line p-1.5 hover:border-accent"
                    aria-label="Partager l’adresse"
                    onClick={() => void shareLink(link(m), 'HashWall — adresse de secours')}
                  >
                    <IconShare size={14} />
                  </button>
                </div>
              </div>
              {qr === m.url && <QrSvg text={link(m)} className="mx-auto mt-3 aspect-square w-full max-w-64 rounded-lg" />}
            </li>
          ))}
        </ul>
        {mirrors.length < 3 && (
          <p className="text-xs text-muted">
            Peu d’adresses connues pour l’instant : la liste s’enrichit automatiquement quand le projet en publie de
            nouvelles (liste signée, transmise par les relais).
          </p>
        )}

        <div className="rounded-xl border border-line p-3" data-testid="network-help">
          <p className="font-semibold">
            Relais joignables : {connected} sur {total}
          </p>
          <p className="mt-1 text-muted">Si aucun relais ne répond, votre réseau bloque peut-être HashWall :</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted">
            <li>passez du Wi-Fi aux données mobiles (ou l’inverse) ;</li>
            <li>activez un VPN, ou ouvrez une adresse ci-dessus dans Tor Browser ;</li>
            <li>ajoutez d’autres relais dans Réglages → Réseau ;</li>
            <li>sans aucun réseau : filmez quand même, la vidéo part dès que la connexion revient.</li>
          </ul>
        </div>
      </div>
    </Sheet>
  )
}
