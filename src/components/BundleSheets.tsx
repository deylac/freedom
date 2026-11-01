/**
 * Paquets hors ligne (docs/RESILIENCE.md, R3) : confier une vidéo non publiée à quelqu'un qui a du
 * réseau, et publier une vidéo reçue d'un autre.
 */
import { useEffect, useState } from 'react'
import { checkBundle, relayBundle, type BundleCheck, type RelayResult } from '../lib/bundle'
import { formatBytes, formatDuration } from '../lib/format'
import { shortNpub } from '../lib/nostr/signer'
import { publisher } from '../lib/publish'
import { IconDownload, IconShare } from './icons'
import { Button, Sheet } from './ui'

function saveFile(file: File) {
  const url = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = url
  a.download = file.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/** Étape 1 : préparer (signatures). Étape 2 : partager — geste distinct, exigé par Safari pour le partage. */
export function BundleShareSheet({ jobId, onClose }: { jobId: string; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    publisher.bundle(jobId).then(setFile, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [jobId])
  const canShare = !!file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })

  return (
    <Sheet title="Confier la vidéo à un proche" onClose={onClose}>
      <div className="space-y-3 text-sm text-white" data-testid="bundle-share">
        <p className="text-muted">
          Pas de réseau ? Transmettez ce fichier par AirDrop, Quick Share, Bluetooth ou clé USB à quelqu’un qui en a.
          Il l’ouvrira dans HashWall (Réglages → « Publier une vidéo reçue ») : la vidéo partira <strong className="text-white">signée par vous</strong>,
          sans qu’il puisse la modifier. Valable 7 jours.
        </p>
        <p className="rounded-xl border border-rec/50 p-2.5 text-xs text-muted">
          Envoyez-le <strong className="text-white">comme fichier</strong> : une messagerie qui recompresse les vidéos (WhatsApp…)
          détruit le paquet. La personne qui le reçoit pourra regarder la vidéo avant de la publier : choisissez-la de confiance.
        </p>
        {error && <p className="text-rec">{error}</p>}
        {!file && !error && <p className="text-muted">Préparation…</p>}
        {file && (
          <>
            <p className="font-mono text-xs text-muted" data-testid="bundle-name">
              {file.name} · {formatBytes(file.size)}
            </p>
            <div className="flex flex-wrap gap-2">
              {canShare && (
                <Button onClick={() => void navigator.share({ files: [file], title: 'Vidéo HashWall à publier' }).catch(() => {})}>
                  <IconShare size={16} /> Partager le fichier
                </Button>
              )}
              <Button variant={canShare ? 'ghost' : 'primary'} onClick={() => saveFile(file)}>
                <IconDownload size={16} /> Enregistrer le fichier
              </Button>
            </div>
          </>
        )}
      </div>
    </Sheet>
  )
}

export function BundleImportSheet({ onClose }: { onClose: () => void }) {
  const [check, setCheck] = useState<BundleCheck | null>(null)
  const [preview, setPreview] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [step, setStep] = useState<string | null>(null)
  const [result, setResult] = useState<RelayResult | null>(null)

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview])

  const open = async (file: File | undefined) => {
    setError(null)
    setCheck(null)
    setResult(null)
    if (!file) return
    try {
      const c = await checkBundle(file)
      setCheck(c)
      setPreview(URL.createObjectURL(c.video))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const publish = async () => {
    if (!check) return
    setError(null)
    try {
      setResult(await relayBundle(check, setStep))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setStep(null)
    }
  }

  return (
    <Sheet title="Publier une vidéo reçue" onClose={onClose}>
      <div className="space-y-3 text-sm text-white" data-testid="bundle-import">
        <p className="text-muted">
          Quelqu’un sans réseau vous a transmis une vidéo HashWall ? Ouvrez-la ici : vous ne faites que la transporter.
          Elle reste signée par son auteur et ne peut pas être modifiée.
        </p>
        <label className="block">
          <span className="sr-only">Fichier reçu</span>
          <input
            type="file"
            accept="video/mp4,video/webm,video/*"
            data-testid="bundle-file"
            onChange={(e) => void open(e.target.files?.[0])}
            className="block w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-2 file:font-semibold file:text-night"
          />
        </label>
        {error && (
          <p className="text-rec" role="alert">
            {error}
          </p>
        )}
        {check && (
          <div className="space-y-2 rounded-xl border border-line p-3" data-testid="bundle-summary">
            {preview && <video src={preview} controls playsInline muted className="max-h-64 w-full rounded-lg bg-black" />}
            <p>
              <span className="font-semibold text-accent">#{check.clip.hashtags[0]}</span> · {formatDuration(check.clip.video.duration ?? 0)} ·{' '}
              {formatBytes(check.video.size)}
            </p>
            <p className="text-xs text-muted">
              Auteur {shortNpub(check.clip.pubkey)} · signature et empreinte vérifiées · autorisation valable jusqu’au{' '}
              {new Date(check.expiresAt * 1000).toLocaleDateString('fr-FR')}
            </p>
            {!result && (
              <Button onClick={() => void publish()} disabled={!!step}>
                {step ?? 'Publier sur le mur'}
              </Button>
            )}
          </div>
        )}
        {result && (
          <p className="text-ok" data-testid="bundle-result">
            Publiée : {result.copies.length} copie{result.copies.length > 1 ? 's' : ''}, {result.relays} relais. Merci !
          </p>
        )}
      </div>
    </Sheet>
  )
}
