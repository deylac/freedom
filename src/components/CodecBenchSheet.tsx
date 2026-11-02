/**
 * Banc d'essai des formats vidéo (Réglages → Diagnostic) : voir src/lib/media/codec-bench.ts.
 * Mesure, sur le téléphone de la personne, ce que chaque codec permettrait de gagner. Rien n'est envoyé.
 */
import { useEffect, useRef, useState } from 'react'
import { WATERMARK_NAME } from '../config'
import {
  actualMbps,
  FAMILY_CODEC,
  formatReport,
  mbPerMinute,
  probeAll,
  recordSimultaneously,
  savingVs,
  type BenchResult,
  type FamilyProbe,
  type Tri,
} from '../lib/media/codec-bench'
import { detectCaptureSupport } from '../lib/media/mime'
import { CaptureSession } from '../lib/media/recorder'
import { Button, copyText, Sheet, useToast } from './ui'

const BENCH_MS = 20_000

function benchDuration(): number {
  // Les tests de bout en bout raccourcissent l'essai ; jamais en production.
  if (import.meta.env.MODE === 'e2e') {
    const override = Number(localStorage.getItem('hw:e2e:benchMs'))
    if (override > 0) return override
  }
  return BENCH_MS
}

const fmt = (n: number, d = 1) => n.toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d })

function Mark({ value }: { value: Tri }) {
  return <span className={value === 'oui' ? 'text-ok' : value === 'non' ? 'text-rec' : 'text-muted'}>{value === 'oui' ? 'oui' : value === 'non' ? 'non' : '?'}</span>
}

/** La vidéo produite se relit-elle sur cet appareil ? (premier image décodée en moins de 8 s) */
function checkPlayable(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    const end = (ok: boolean) => {
      clearTimeout(timer)
      v.removeAttribute('src')
      v.load()
      resolve(ok)
    }
    const timer = setTimeout(() => end(false), 8000)
    v.onloadeddata = () => end(v.videoWidth > 0)
    v.onerror = () => end(false)
    v.src = url
  })
}

type Phase = 'idle' | 'starting' | 'recording' | 'checking' | 'done' | 'error'

export function CodecBenchSheet({ onClose }: { onClose: () => void }) {
  const toast = useToast()
  const [probes, setProbes] = useState<FamilyProbe[] | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState<string | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [results, setResults] = useState<BenchResult[] | null>(null)
  const [urls, setUrls] = useState<Record<string, string>>({})
  const [playable, setPlayable] = useState<Record<string, boolean>>({})
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const session = useRef<CaptureSession | null>(null)
  const stopRun = useRef<(() => void) | null>(null)

  useEffect(() => {
    void probeAll().then(setProbes)
  }, [])

  // Fermeture : caméra coupée, enregistreurs arrêtés, fichiers libérés.
  const urlsRef = useRef(urls)
  urlsRef.current = urls
  useEffect(
    () => () => {
      stopRun.current?.()
      session.current?.close()
      Object.values(urlsRef.current).forEach((u) => URL.revokeObjectURL(u))
    },
    [],
  )

  const run = async () => {
    const support = detectCaptureSupport()
    if (!support.ok || !support.mime) {
      setError(support.reason ?? 'Enregistrement impossible sur ce navigateur.')
      setPhase('error')
      return
    }
    Object.values(urls).forEach((u) => URL.revokeObjectURL(u))
    setUrls({})
    setPlayable({})
    setResults(null)
    setError(null)
    setPhase('starting')
    const s = new CaptureSession(videoRef.current!, canvasRef.current!, support.mime, 'standard')
    s.watermark = [`${WATERMARK_NAME} · essai`, `${location.host}${location.pathname}`.replace(/\/$/, '')]
    session.current = s
    let canvasTrack: MediaStreamTrack | null = null
    try {
      await s.open()
      // Laisser la caméra s'exposer avant de mesurer.
      await new Promise((r) => setTimeout(r, 800))
      canvasTrack = canvasRef.current!.captureStream(30).getVideoTracks()[0]
      const tracks = [canvasTrack, ...(s.microphone ? [s.microphone] : [])]
      const total = benchDuration()
      const t0 = Date.now()
      setRemaining(Math.ceil(total / 1000))
      const tick = setInterval(() => setRemaining(Math.max(0, Math.ceil((total - (Date.now() - t0)) / 1000))), 250)
      setPhase('recording')
      const r = recordSimultaneously(tracks, total)
      stopRun.current = r.stop
      const out = await r.done
      clearInterval(tick)
      stopRun.current = null
      canvasTrack.stop()
      s.close()
      session.current = null
      setResults(out)
      setPhase('checking')
      const made: Record<string, string> = {}
      for (const res of out) if (res.blob) made[res.variant.id] = URL.createObjectURL(res.blob)
      setUrls(made)
      const checks = await Promise.all(Object.entries(made).map(async ([id, u]) => [id, await checkPlayable(u)] as const))
      setPlayable(Object.fromEntries(checks))
      setPhase('done')
    } catch (err) {
      canvasTrack?.stop()
      s.close()
      session.current = null
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }

  const report = () => (probes ? formatReport(probes, results, { userAgent: navigator.userAgent, playable }) : '')
  const shareReport = async () => {
    const text = report()
    if (navigator.share) {
      try {
        await navigator.share({ text, title: 'HashWall — banc d’essai des formats' })
        return
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
      }
    }
    toast((await copyText(text)) ? 'Rapport copié' : 'Copie impossible', 'ok')
  }

  const ref = results?.find((r) => r.variant.id === 'h264-actuel' && r.bytes > 0)
  const busy = phase === 'starting' || phase === 'recording' || phase === 'checking'

  return (
    <Sheet title="Banc d’essai des formats vidéo" onClose={onClose} wide>
      <div className="space-y-4 text-sm text-white" data-testid="codec-bench">
        <p className="text-muted">
          Mesure ce que ce téléphone sait enregistrer et lire, et combien pèserait une même vidéo dans chaque format.
          Rien n’est publié ni envoyé : les fichiers d’essai disparaissent à la fermeture.
        </p>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs" data-testid="codec-probe">
            <thead className="text-muted">
              <tr>
                <th className="py-1 pr-2 font-normal">Format</th>
                <th className="py-1 pr-2 font-normal">Enregistrer</th>
                <th className="py-1 pr-2 font-normal">Encodeur matériel</th>
                <th className="py-1 pr-2 font-normal">Lire</th>
                <th className="py-1 font-normal">Lecture économe</th>
              </tr>
            </thead>
            <tbody>
              {probes ? (
                probes.map((p) => (
                  <tr key={p.family} className="border-t border-line" data-family={p.family} data-record={p.record} data-decode={p.decode}>
                    <td className="py-1.5 pr-2 font-semibold">{FAMILY_CODEC[p.family].label}</td>
                    <td className="py-1.5 pr-2"><Mark value={p.record} /></td>
                    <td className="py-1.5 pr-2"><Mark value={p.encodeHardware} /></td>
                    <td className="py-1.5 pr-2"><Mark value={p.decode} /></td>
                    <td className="py-1.5"><Mark value={p.powerEfficient} /></td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="py-2 text-muted">Analyse…</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className={busy ? 'relative mx-auto aspect-[9/16] w-40 overflow-hidden rounded-xl bg-black' : 'hidden'}>
          <video ref={videoRef} className="hidden" muted playsInline />
          <canvas ref={canvasRef} className="h-full w-full object-cover" />
          {phase === 'recording' && (
            <span className="absolute left-2 top-2 rounded-full bg-rec px-2 py-0.5 text-xs font-semibold" data-testid="bench-remaining">
              {remaining} s
            </span>
          )}
        </div>

        {phase === 'idle' || phase === 'done' || phase === 'error' ? (
          <Button onClick={() => void run()} data-testid="bench-run">
            {phase === 'idle' ? `Essai de ${Math.round(benchDuration() / 1000)} secondes` : 'Recommencer l’essai'}
          </Button>
        ) : (
          <p className="text-muted" role="status">
            {phase === 'starting' ? 'Ouverture de la caméra…' : phase === 'recording' ? 'Filmez une scène qui bouge (rue, foule, mouvement de la main)…' : 'Vérification de la relecture…'}
          </p>
        )}
        {phase === 'recording' && (
          <Button variant="ghost" onClick={() => stopRun.current?.()}>
            Arrêter maintenant
          </Button>
        )}
        {error && (
          <p className="rounded-xl border border-rec/50 p-2.5 text-xs text-rec" role="alert">
            {error}
          </p>
        )}

        {results && (
          <ul className="space-y-3" data-testid="bench-results">
            {results.map((r) => {
              const ok = !!r.mime && !r.error && r.bytes > 0
              const saving = ok && r !== ref ? savingVs(ref, r) : null
              return (
                <li key={r.variant.id} className="rounded-xl border border-line bg-night p-3" data-variant={r.variant.id} data-bytes={r.bytes} data-playable={playable[r.variant.id] === undefined ? '' : String(playable[r.variant.id])}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-semibold">{r.variant.label}</span>
                    {saving !== null && (
                      <span className={`text-xs font-semibold ${saving < 0 ? 'text-ok' : 'text-rec'}`}>
                        {saving > 0 ? '+' : ''}
                        {saving} %
                      </span>
                    )}
                  </div>
                  {!r.mime ? (
                    <p className="mt-1 text-xs text-muted">Non pris en charge par ce navigateur.</p>
                  ) : !ok ? (
                    <p className="mt-1 text-xs text-rec">Échec : {r.error ?? 'fichier vide'}</p>
                  ) : (
                    <>
                      <p className="mt-1 text-xs text-muted">
                        {fmt(mbPerMinute(r))} Mo par minute · {fmt(actualMbps(r), 2)} Mbit/s réels
                        {playable[r.variant.id] === false && <span className="text-rec"> · illisible sur cet appareil</span>}
                      </p>
                      {urls[r.variant.id] && (
                        <video src={urls[r.variant.id]} controls muted playsInline preload="metadata" className="mt-2 aspect-[9/16] w-full max-w-56 rounded-lg bg-black" />
                      )}
                    </>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {probes && (
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => void shareReport()} data-testid="bench-report">
              Envoyer le rapport
            </Button>
          </div>
        )}
        <p className="text-xs text-muted">
          Comparez la netteté en plein écran (visages, texte, mouvements). Les pourcentages comparent le poids au réglage
          actuel de l’application.
        </p>
      </div>
    </Sheet>
  )
}
