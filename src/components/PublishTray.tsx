import { useEffect, useSyncExternalStore } from 'react'
import { useWakeLock } from '../hooks/basics'
import { formatBytes } from '../lib/format'
import { publisher } from '../lib/publish'
import { IconCheck, IconClose, IconRetry, IconTrash } from './icons'

/** Suivi des envois en cours (file persistante, reprise automatique). */
export function PublishTray() {
  const jobs = useSyncExternalStore(publisher.subscribe, publisher.getSnapshot)
  const busy = jobs.some((j) => j.state !== 'done' && j.progress.stage !== 'error')
  useWakeLock(busy)

  // Les confirmations disparaissent seules.
  useEffect(() => {
    const done = jobs.filter((j) => j.state === 'done')
    if (done.length === 0) return
    const id = setTimeout(() => done.forEach((j) => publisher.dismiss(j.id)), 8000)
    return () => clearTimeout(id)
  }, [jobs])

  if (jobs.length === 0) return null
  return (
    <div className="fixed inset-x-3 top-[calc(max(env(safe-area-inset-top),0.75rem)+6.5rem)] z-40 flex flex-col gap-2 md:top-auto md:bottom-24 md:left-4 md:right-auto md:w-96" aria-live="polite" data-testid="publish-tray">
      {jobs.map((job) => {
        const p = job.progress
        const pct = p.sent !== undefined && p.total ? Math.round((p.sent / p.total) * 100) : null
        const failed = p.stage === 'error'
        const done = job.state === 'done'
        const ttw =
          job.timings.publishedAt && job.timings.recordedAt
            ? ((job.timings.publishedAt - job.timings.recordedAt) / 1000).toFixed(1).replace('.', ',')
            : null
        return (
          <div key={job.id} className={`animate-rise rounded-2xl border bg-surface/95 p-3 shadow-xl backdrop-blur ${failed ? 'border-rec/60' : done ? 'border-ok/60' : 'border-line'}`} data-state={done ? 'done' : failed ? 'error' : p.stage}>
            <div className="flex items-center gap-3">
              <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${done ? 'bg-ok/20 text-ok' : failed ? 'bg-rec/20 text-rec' : 'bg-accent/15 text-accent'}`}>
                {done ? <IconCheck size={18} /> : failed ? '!' : <span className="h-4 w-4 animate-spin rounded-full border-2 border-accent/30 border-t-accent" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-white">
                  {done ? `Publiée sur #${job.tag}` : failed ? `Échec de l’envoi (#${job.tag})` : `#${job.tag} — ${p.message}`}
                </p>
                <p className="truncate text-xs text-muted">
                  {done
                    ? `${ttw ? `envoi ${ttw} s · ` : ''}${job.mirrors} miroir${job.mirrors > 1 ? 's' : ''}`
                    : failed
                      ? 'Conservée sur l’appareil : nouvel essai possible.'
                      : pct !== null
                        ? `${pct} % · ${formatBytes(p.sent!)} / ${formatBytes(p.total!)}`
                        : job.state === 'published'
                          ? 'Visible sur le mur · réplication en cours'
                          : ' '}
                </p>
              </div>
              {failed && (
                <>
                  <button onClick={() => publisher.retry(job.id)} aria-label="Réessayer l'envoi" className="rounded-full p-2 text-accent">
                    <IconRetry size={18} />
                  </button>
                  <button onClick={() => void publisher.cancel(job.id)} aria-label="Abandonner et supprimer la vidéo" className="rounded-full p-2 text-muted">
                    <IconTrash size={18} />
                  </button>
                </>
              )}
              {done && (
                <button onClick={() => publisher.dismiss(job.id)} aria-label="Fermer" className="rounded-full p-2 text-muted">
                  <IconClose size={16} />
                </button>
              )}
            </div>
            {pct !== null && !done && !failed && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-night">
                <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
              </div>
            )}
            {failed && job.error && <p className="mt-2 max-h-24 overflow-y-auto whitespace-pre-line text-xs text-rec/90">{job.error}</p>}
          </div>
        )
      })}
    </div>
  )
}
