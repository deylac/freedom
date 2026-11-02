import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MAX_CLIP_MS, MAX_UPLOAD_BYTES } from '../config'
import { updateSettings } from '../lib/storage/settings'
import { useSettings, useWakeLock } from '../hooks/basics'
import { formatBytes, formatDuration } from '../lib/format'
import { detectCaptureSupport } from '../lib/media/mime'
import type { PassStage } from '../lib/media/face-pass'
import { CaptureError, CaptureSession, type FaceStatus, type FilterMode, type Recording } from '../lib/media/recorder'
import { newIdentity } from '../lib/nostr/signer'
import { createJob, publisher } from '../lib/publish'
import { isDurable } from '../lib/storage/outbox'
import { IconCheck, IconClose, IconFace, IconMic, IconRetry, IconSwitch } from './icons'
import { Button, Toggle, useToast } from './ui'

type Phase = 'starting' | 'ready' | 'recording' | 'processing' | 'review' | 'error'

const AUTO_PUBLISH_SECONDS = 3

function maxDuration(): number {
  // Les tests de bout en bout raccourcissent la limite ; jamais en production.
  if (import.meta.env.MODE === 'e2e') {
    const override = Number(localStorage.getItem('hw:e2e:maxMs'))
    if (override > 0) return override
  }
  return MAX_CLIP_MS
}

function Ring({ remaining, total }: { remaining: number; total: number }) {
  const r = 46
  const c = 2 * Math.PI * r
  const fraction = Math.max(0, Math.min(1, remaining / total))
  return (
    <svg viewBox="0 0 100 100" className="pointer-events-none absolute inset-0 h-full w-full -rotate-90" aria-hidden>
      <circle cx="50" cy="50" r={r} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth="5" />
      <circle
        cx="50"
        cy="50"
        r={r}
        fill="none"
        stroke="#00F0FF"
        strokeWidth="5"
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - fraction)}
        style={{ transition: 'stroke-dashoffset 0.1s linear', filter: 'drop-shadow(0 0 6px rgba(0,240,255,0.7))' }}
      />
    </svg>
  )
}

/** Libellés courts, toujours visibles (même sur un petit écran) : l'état du filtre ne doit pas être deviné. */
const PASS_LABEL: Record<PassStage, string> = {
  analyse: 'Recherche des visages…',
  floutage: 'Floutage des visages…',
  contrôle: 'Contrôle du résultat…',
  correction: 'Correction…',
}

const FILTER_SHORT: Record<FilterMode, string> = {
  none: 'Sans flou',
  faces: 'Visages',
  pixelate: 'Tout flou',
}

const FILTER_LABEL: Record<FilterMode, string> = {
  none: 'Sans filtre',
  faces: 'Visages floutés',
  pixelate: 'Image pixelisée',
}

export function CaptureScreen({ tag, onClose }: { tag: string; onClose: () => void }) {
  const settings = useSettings()
  const toast = useToast()
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const [pass, setPass] = useState<{ stage: PassStage; fraction: number } | null>(null)
  const session = useRef<CaptureSession | null>(null)
  const [phase, setPhase] = useState<Phase>('starting')
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [recording, setRecording] = useState<Recording | null>(null)
  const [filter, setFilter] = useState<FilterMode>(settings.captureFilter)
  const [facing, setFacing] = useState<'environment' | 'user'>('environment')
  const [voice, setVoice] = useState<'natural' | 'robot'>('natural')
  const [faceStatus, setFaceStatus] = useState<FaceStatus>({ state: 'off', trusted: false, count: 0 })
  const total = useMemo(maxDuration, [])

  useWakeLock(phase !== 'error')

  // Ouverture immédiate de la caméra (Time-to-Camera < 2 s).
  useEffect(() => {
    const support = detectCaptureSupport()
    if (!support.ok || !support.mime) {
      setError(support.reason ?? 'Capture impossible')
      setPhase('error')
      return
    }
    const s = new CaptureSession(videoRef.current!, canvasRef.current!, support.mime, settings.quality, overlayRef.current)
    s.onProcessing = (stage, fraction) => setPass({ stage, fraction })
    s.maxMs = total
    s.filter = filter
    session.current = s
    s.open()
      .then(() => setPhase((p) => (p === 'starting' ? 'ready' : p)))
      .catch((err: unknown) => {
        setError(err instanceof CaptureError ? err.message : String(err))
        setPhase('error')
      })
    return () => s.close()
    // La qualité est figée à l'ouverture de la caméra.
  }, [])

  useEffect(() => {
    if (phase !== 'recording') return
    const id = setInterval(() => {
      const s = session.current
      if (!s) return
      setElapsed(s.elapsedMs())
    }, 100)
    return () => clearInterval(id)
  }, [phase])

  const start = () => {
    const s = session.current
    if (!s || phase !== 'ready') return
    setElapsed(0)
    setPass(null)
    let done: Promise<Recording>
    try {
      done = s.start()
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
      return
    }
    setPhase('recording')
    done
      .then((rec) => {
        setRecording(rec)
        setPhase('review')
        if (rec.stoppedBy === 'interrupted') toast('Enregistrement interrompu (écran verrouillé ou caméra coupée) : la partie filmée est conservée.', 'info')
      })
      .catch((err: unknown) => {
        setError(`Échec de l'enregistrement : ${err instanceof Error ? err.message : err}`)
        setPhase('error')
      })
  }

  const stop = () => {
    if (phase !== 'recording') return
    setPhase('processing')
    session.current?.stop()
  }

  // État du détecteur de visages, y compris avant l'enregistrement (chargement du modèle).
  useEffect(() => {
    if (filter !== 'faces') return
    const id = setInterval(() => {
      const s = session.current
      if (s) setFaceStatus(s.faceStatus())
    }, 250)
    return () => clearInterval(id)
  }, [filter])

  const toggleVoice = () => {
    const next = voice === 'robot' ? 'natural' : 'robot'
    setVoice(next)
    if (session.current) session.current.voice = next
    if (next === 'robot') toast('Voix robot : hauteur et timbre effacés (non réversible). Les mots prononcés restent compréhensibles.', 'info')
  }

  const cycleFilter = () => {
    const order: FilterMode[] = ['none', 'faces', 'pixelate']
    const next = order[(order.indexOf(filter) + 1) % order.length]
    setFilter(next)
    updateSettings({ captureFilter: next })
    if (session.current) session.current.filter = next
  }

  const switchCamera = async () => {
    try {
      await session.current?.switchCamera()
      setFacing(session.current?.facing ?? 'environment')
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error')
    }
  }

  const retake = () => {
    setRecording(null)
    setElapsed(0)
    setPhase('ready')
  }

  const remaining = total - elapsed

  return (
    <div className="fixed inset-0 z-50 bg-black text-white" role="dialog" aria-modal="true" aria-label={`Filmer pour #${tag}`} data-testid="capture">
      {/* La vidéo brute reste dans le DOM (iOS ne décode pas une vidéo masquée), sous le canvas. */}
      <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover opacity-0" muted playsInline aria-hidden />
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full object-cover"
        style={{ transform: facing === 'user' ? 'scaleX(-1)' : undefined, visibility: phase === 'review' || phase === 'processing' ? 'hidden' : 'visible' }}
        aria-label="Aperçu de la caméra"
      />
      {/* Calque de l'aperçu flouté : l'image enregistrée reste brute (en mémoire) jusqu'au second passage. */}
      <canvas
        ref={overlayRef}
        className="pointer-events-none absolute inset-0 h-full w-full object-cover"
        style={{ transform: facing === 'user' ? 'scaleX(-1)' : undefined, visibility: phase === 'review' || phase === 'processing' ? 'hidden' : 'visible' }}
        aria-hidden
        data-testid="blur-overlay"
      />

      {phase === 'review' && recording && (
        <Review
          tag={tag}
          recording={recording}
          autoPublish={settings.autoPublish}
          onRetake={retake}
          onCancel={onClose}
          onPublish={async (caption, contentWarning) => {
            try {
              const job = await createJob(recording, { tag, caption, contentWarning, useExtension: settings.useExtension })
              publisher.enqueue(job)
              if (!isDurable(job.id)) {
                // Audit F06 : ne pas laisser croire que la vidéo est en sécurité sur l'appareil.
                toast('Stockage de l’appareil indisponible (plein ou navigation privée) : la vidéo n’existe que dans cet onglet. Ne le fermez pas avant la fin de l’envoi.', 'error')
              }
              if (settings.rotateIdentity && !settings.useExtension) newIdentity()
              onClose()
            } catch (err) {
              toast(`Publication impossible : ${err instanceof Error ? err.message : err}`, 'error')
            }
          }}
        />
      )}

      {phase !== 'review' && (
        <>
          <div className="absolute inset-x-0 top-0 flex items-center justify-between gap-2 bg-gradient-to-b from-black/70 to-transparent px-4 pb-10 pt-safe">
            <button onClick={onClose} aria-label="Fermer la caméra" className="rounded-full bg-black/40 p-2.5">
              <IconClose />
            </button>
            <span className="truncate text-lg font-bold">
              <span className="text-accent">#</span>
              {tag}
            </span>
            <div className="flex gap-2">
              <button onClick={cycleFilter} aria-label={`Filtre d'anonymisation : ${FILTER_LABEL[filter]}`} className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold ${filter === 'none' ? 'bg-black/40' : 'bg-accent text-night'}`} disabled={phase === 'starting' || phase === 'error'}>
                <IconFace size={18} />
                <span>{FILTER_SHORT[filter]}</span>
              </button>
              <button
                onClick={toggleVoice}
                aria-label={voice === 'robot' ? 'Voix robot (anonymisée) activée' : 'Activer la voix robot (anonymisée)'}
                aria-pressed={voice === 'robot'}
                className={`flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-semibold ${voice === 'robot' ? 'bg-accent text-night' : 'bg-black/40'}`}
                disabled={phase !== 'ready' && phase !== 'starting'}
                data-testid="voice-toggle"
              >
                <IconMic size={18} muted={voice === 'robot'} />
                <span className="hidden sm:inline">{voice === 'robot' ? 'Voix robot' : 'Voix naturelle'}</span>
              </button>
              <button onClick={switchCamera} aria-label="Changer de caméra" className="rounded-full bg-black/40 p-2.5" disabled={phase === 'starting' || phase === 'error'}>
                <IconSwitch />
              </button>
            </div>
          </div>

          {filter !== 'none' && phase !== 'processing' && (
            <p
              className="absolute inset-x-4 top-24 rounded-xl bg-black/50 px-3 py-2 text-center text-xs text-white/90 backdrop-blur"
              role="status"
              data-testid="face-status"
              data-state={filter === 'faces' ? faceStatus.state : 'pixelate'}
              data-trusted={faceStatus.trusted}
              data-count={faceStatus.count}
            >
              {filter === 'pixelate'
                ? 'Toute l’image est pixelisée dans le fichier final.'
                : faceStatus.state === 'error'
                  ? `Détecteur de visages indisponible (${faceStatus.error ?? 'erreur'}) : image entière pixelisée par sécurité.`
                  : faceStatus.state !== 'ready'
                    ? 'Chargement du détecteur de visages (≈ 15 Mo, une seule fois)… En attendant, toute l’image est pixelisée.'
                    : !faceStatus.trusted
                      ? 'Analyse de toute l’image… En attendant, elle est entièrement pixelisée.'
                      : `${faceStatus.count} visage${faceStatus.count > 1 ? 's' : ''} flouté${faceStatus.count > 1 ? 's' : ''} dans le fichier final. Visages très lointains ou de profil : préférez « Image pixelisée ».`}
            </p>
          )}

          {phase === 'error' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 bg-night/95 p-8 text-center">
              <p className="text-lg font-semibold">Caméra indisponible</p>
              <p className="max-w-sm text-sm text-muted">{error}</p>
              <Button variant="ghost" onClick={onClose}>
                Retour au mur
              </Button>
            </div>
          )}

          {phase === 'starting' && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted" role="status">
              Ouverture de la caméra…
            </div>
          )}

          <div className="absolute inset-x-0 bottom-0 flex flex-col items-center gap-3 bg-gradient-to-t from-black/80 to-transparent pb-safe pt-16">
            <span className={`font-mono text-lg font-bold tabular-nums ${phase === 'recording' ? 'text-accent' : 'text-white/70'}`} aria-live="off">
              {formatDuration(Math.ceil(remaining / 1000))}
            </span>
            <div className="relative h-24 w-24">
              <Ring remaining={phase === 'recording' || phase === 'processing' ? remaining : total} total={total} />
              {phase === 'recording' ? (
                <button onClick={stop} aria-label="Arrêter l'enregistrement" className="absolute inset-4 flex items-center justify-center rounded-full bg-white/10" data-testid="stop">
                  <span className="h-8 w-8 rounded-md bg-rec" />
                </button>
              ) : (
                <button
                  onClick={start}
                  disabled={phase !== 'ready'}
                  aria-label="Démarrer l'enregistrement (60 secondes maximum)"
                  className="absolute inset-3 rounded-full bg-rec shadow-lg shadow-rec/40 transition active:scale-90 disabled:opacity-40"
                  data-testid="record"
                />
              )}
            </div>
            <span className="text-xs text-white/60" data-testid="capture-status">
              {phase === 'recording'
                ? 'Enregistrement…'
                : phase === 'processing'
                  ? pass
                    ? `${PASS_LABEL[pass.stage]} ${Math.round(pass.fraction * 100)} %`
                    : 'Finalisation…'
                  : '60 secondes max · métadonnées GPS supprimées'}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

function Review({
  tag,
  recording,
  autoPublish,
  onRetake,
  onCancel,
  onPublish,
}: {
  tag: string
  recording: Recording
  autoPublish: boolean
  onRetake: () => void
  onCancel: () => void
  onPublish: (caption: string, contentWarning?: string) => Promise<void>
}) {
  const url = useMemo(() => URL.createObjectURL(recording.blob), [recording.blob])
  useEffect(() => () => URL.revokeObjectURL(url), [url])
  const [countdown, setCountdown] = useState<number | null>(autoPublish ? AUTO_PUBLISH_SECONDS : null)
  const [caption, setCaption] = useState('')
  const [sensitive, setSensitive] = useState(false)
  const [busy, setBusy] = useState(false)
  const tooBig = recording.size > MAX_UPLOAD_BYTES

  const publish = useCallback(async () => {
    if (busy) return
    setBusy(true)
    setCountdown(null)
    await onPublish(caption, sensitive ? 'Contenu sensible (violence possible)' : undefined)
    setBusy(false)
  }, [busy, caption, sensitive, onPublish])

  // « Zero-click » : publication après 3 s d'aperçu, interrompue par toute interaction.
  useEffect(() => {
    if (countdown === null) return
    if (countdown <= 0) {
      void publish()
      return
    }
    const id = setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000)
    return () => clearTimeout(id)
  }, [countdown, publish])

  const pause = () => setCountdown(null)

  return (
    <div className="absolute inset-0 flex flex-col bg-black" data-testid="review">
      <video src={url} className="min-h-0 flex-1 object-contain" autoPlay muted loop playsInline controls={false} aria-label="Aperçu de votre vidéo" />
      <div className="space-y-3 border-t border-line bg-surface p-4 pb-safe">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <span className="text-white">{formatDuration(recording.durationSec)}</span>
          <span>{formatBytes(recording.size)}</span>
          <span>{recording.mime}</span>
          <span className="text-ok">✓ aucune métadonnée GPS / appareil</span>
          {recording.scrub.datesCleared > 0 && <span className="text-ok">✓ dates internes effacées</span>}
          {recording.voice === 'robot' && <span className="text-ok">✓ voix anonymisée</span>}
          {recording.faces && (
            <span className="text-ok" data-testid="faces-report" data-faces={recording.faces.faces} data-corrected={recording.faces.corrected} data-full={recording.faces.fullyPixelated.length} data-ms={recording.faces.ms} data-steps={JSON.stringify(recording.faces.steps)}>
              ✓ {recording.faces.faces} visage{recording.faces.faces > 1 ? 's' : ''} flouté{recording.faces.faces > 1 ? 's' : ''} · résultat contrôlé
              {recording.faces.corrected > 0 ? ` (${recording.faces.corrected} oubli${recording.faces.corrected > 1 ? 's' : ''} corrigé${recording.faces.corrected > 1 ? 's' : ''})` : ''}
            </span>
          )}
        </div>
        {recording.faces && recording.faces.fullyPixelated.length > 0 && (
          <p className="text-xs text-rec">
            Un visage resté net malgré la correction : {recording.faces.fullyPixelated.length} passage
            {recording.faces.fullyPixelated.length > 1 ? 's' : ''} entièrement pixelisé{recording.faces.fullyPixelated.length > 1 ? 's' : ''} par sécurité.
            Vérifiez l’aperçu avant de publier.
          </p>
        )}
        {tooBig && <p className="text-xs text-rec">Fichier de {formatBytes(recording.size)} : certains serveurs gratuits (limite 20 Mio) le refuseront. Le mode « réseau saturé » des réglages réduit la taille.</p>}
        <input
          value={caption}
          onChange={(e) => setCaption(e.target.value.slice(0, 280))}
          onFocus={pause}
          placeholder={`Légende facultative (#${tag} est ajouté automatiquement)`}
          className="h-11 w-full rounded-xl border border-line bg-night px-3 text-sm text-white placeholder:text-muted focus:border-accent focus:outline-none"
          aria-label="Légende"
        />
        <Toggle
          checked={sensitive}
          onChange={(v) => {
            pause()
            setSensitive(v)
          }}
          label="Contenu sensible (violence, blessés…)"
          hint="La vidéo sera masquée derrière un avertissement et ne sera pas préchargée."
        />
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onCancel} aria-label="Annuler et supprimer la vidéo" className="px-3">
            <IconClose size={18} />
          </Button>
          <Button variant="ghost" onClick={onRetake} className="flex-1">
            <IconRetry size={18} /> Refaire
          </Button>
          <Button onClick={publish} disabled={busy} className="flex-[2]" data-testid="publish">
            <IconCheck size={18} />
            {busy ? 'Préparation…' : countdown !== null ? `Publication dans ${countdown}…` : 'Publier'}
          </Button>
        </div>
      </div>
    </div>
  )
}
