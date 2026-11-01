import { useEffect, useState, useSyncExternalStore } from 'react'
import { useWakeLock } from '../hooks/basics'
import { formatBytes } from '../lib/format'
import { publisher } from '../lib/publish'
import type { Diagnostic } from '../lib/storage/outbox'
import { IconCheck, IconClose, IconRetry, IconTrash } from './icons'

/** Résultat serveur par serveur de la dernière publication (refus compris). */
export function DiagnosticList({ items }: { items: Diagnostic[] }) {
  if (items.length === 0) return <p className="text-xs text-muted">Aucun serveur contacté.</p>
  return (
    <ul className="space-y-1 text-xs" data-testid="diagnostics">
      {items.map((d, i) => (
        <li key={`${d.server}-${d.step}-${i}`} className="flex gap-2">
          <span className={d.ok ? 'text-ok' : 'text-rec'}>{d.ok ? '✓' : '✗'}</span>
          <span className="min-w-0 break-words text-white/85">
            <span className="font-semibold text-white">{d.server}</span> <span className="text-muted">({d.step})</span> : {d.detail}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** Suivi des envois en cours (file persistante, reprise automatique). */
export function PublishTray() {
  const jobs = useSyncExternalStore(publisher.subscribe, publisher.getSnapshot)
  const busy = jobs.some((j) => j.state !== 'done' && j.progress.stage !== 'error')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  useWakeLock(busy)

  // Les confirmations disparaissent seules, sauf si l'on consulte leurs détails.
  useEffect(() => {
    const done = jobs.filter((j) => j.state === 'done' && !expanded.has(j.id))
    if (done.length === 0) return
    const id = setTimeout(() => done.forEach((j) => publisher.dismiss(j.id)), 8000)
    return () => clearTimeout(id)
  }, [jobs, expanded])

  const toggle = (id: string) =>
    setExpanded((set) => {
      const next = new Set(set)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (jobs.length === 0) return null
  return (
    <div className="fixed inset-x-3 top-[calc(max(env(safe-area-inset-top),0.75rem)+6.5rem)] z-40 flex flex-col gap-2 md:top-auto md:bottom-24 md:left-4 md:right-auto md:w-96" aria-live="polite" data-testid="publish-tray">
      {jobs.map((job) => {
        const p = job.progress
        const pct = p.sent !== undefined && p.total ? Math.round((p.sent / p.total) * 100) : null
        const failed = p.stage === 'error'
        const done = job.state === 'done'
        const refusals = job.diagnostics.filter((d) => !d.ok).length
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
                    ? `${ttw ? `envoi ${ttw} s · ` : ''}${job.mirrors} miroir${job.mirrors > 1 ? 's' : ''}${refusals ? ` · ${refusals} refus` : ''}`
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
            {job.diagnostics.length > 0 && !failed && (
              <button onClick={() => toggle(job.id)} className="mt-1.5 text-xs font-semibold text-accent" aria-expanded={expanded.has(job.id)}>
                {expanded.has(job.id) ? 'Masquer les détails' : 'Détails par serveur'}
              </button>
            )}
            {expanded.has(job.id) && (
              <div className="mt-2 max-h-48 overflow-y-auto rounded-xl bg-night/80 p-2.5">
                <DiagnosticList items={job.diagnostics} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
