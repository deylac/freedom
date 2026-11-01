import { useCallback, useMemo, useState } from 'react'
import { useNow, useSettings } from '../hooks/basics'
import { formatDuration, relativeTime } from '../lib/format'
import { wallUrl } from '../lib/hashtag'
import type { Verdict } from '../lib/moderation/policy'
import { clipNaddr, type Clip } from '../lib/nostr/events'
import type { WallStore } from '../lib/wall-store'
import { ResilientVideo, type SourceState } from './ResilientVideo'
import { IconAlert, IconMore, IconShare, IconShield, IconSound } from './icons'
import { shareLink, useToast } from './ui'

/**
 * Serveurs à essayer pour un auteur : sa liste kind 10063 puis ceux configurés par l'utilisateur.
 * (Les serveurs par défaut ne sont pas réajoutés : un utilisateur qui les a retirés ne veut pas les contacter.)
 */
export function useExtraServers(store: WallStore | null, pubkey: string): string[] {
  const settings = useSettings()
  const authorServers = store?.serversOf(pubkey) ?? []
  const key = authorServers.join(' ')
  return useMemo(
    () => [...new Set([...authorServers, ...settings.blossomServers])],
    [key, settings.blossomServers],
  )
}

export function clipShareUrl(clip: Clip, tag: string, relays: string[]): string {
  return wallUrl(tag, clipNaddr(clip, relays))
}

export function useShare(clip: Clip, tag: string) {
  const toast = useToast()
  const settings = useSettings()
  return useCallback(async () => {
    const result = await shareLink(clipShareUrl(clip, tag, settings.relays), `#${tag} — HashWall`)
    if (result === 'copied') toast('Lien copié', 'ok')
    if (result === 'failed') toast('Partage impossible', 'error')
  }, [clip, tag, settings.relays, toast])
}

/** Écran d'avertissement : rien n'est chargé (ni vignette, ni vidéo) avant le choix explicite. */
export function WarningCover({ reasons, onReveal, compact = false }: { reasons: string[]; onReveal: () => void; compact?: boolean }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-gradient-to-b from-surface to-night p-5 text-center">
      <IconAlert size={compact ? 26 : 36} className="text-rec" />
      <p className={`font-semibold text-white ${compact ? 'text-sm' : 'text-base'}`}>Contenu masqué</p>
      <ul className="space-y-1 text-xs text-muted">
        {reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <button
        onClick={(e) => {
          e.stopPropagation()
          onReveal()
        }}
        className="mt-1 rounded-xl border border-line px-4 py-2 text-sm font-semibold text-accent hover:border-accent"
      >
        Afficher quand même
      </button>
    </div>
  )
}

function Meta({ clip, compact }: { clip: Clip; compact?: boolean }) {
  const now = useNow()
  return (
    <span className={`font-medium text-white/90 ${compact ? 'text-xs' : 'text-sm'}`}>
      <time dateTime={new Date(clip.publishedAt * 1000).toISOString()}>{relativeTime(clip.publishedAt, now)}</time>
      {clip.duration !== undefined && <span className="text-white/60"> · {formatDuration(clip.duration)}</span>}
    </span>
  )
}

const roundBtn =
  'flex h-11 w-11 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-md transition hover:bg-black/70 hover:text-accent'

// ---------------------------------------------------------------------------
// Élément du flux vertical (mobile + mode théâtre)

export function FeedItem({
  clip,
  verdict,
  tag,
  store,
  active,
  near,
  muted,
  onToggleMute,
  onMenu,
  onResilience,
}: {
  clip: Clip
  verdict: Verdict
  tag: string
  store: WallStore | null
  active: boolean
  near: boolean
  muted: boolean
  onToggleMute: () => void
  onMenu: (clip: Clip, source: SourceState | null) => void
  onResilience: (clip: Clip, source: SourceState | null) => void
}) {
  const [revealed, setRevealed] = useState(false)
  const [source, setSource] = useState<SourceState | null>(null)
  const extraServers = useExtraServers(store, clip.pubkey)
  const share = useShare(clip, tag)
  const masked = verdict.status === 'warn' && !revealed

  return (
    <section
      className="relative h-[100dvh] w-full snap-start snap-always overflow-hidden bg-black"
      data-clip-key={clip.key}
      aria-label={clip.alt || clip.title}
    >
      {masked ? (
        <WarningCover reasons={verdict.status === 'warn' ? verdict.reasons : []} onReveal={() => setRevealed(true)} />
      ) : (
        <ResilientVideo
          clip={clip}
          extraServers={extraServers}
          active={active}
          load={near}
          muted={muted}
          onSource={setSource}
          onTap={onToggleMute}
        />
      )}

      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-56 bg-gradient-to-t from-black/80 to-transparent" />
      <div className="absolute bottom-28 left-4 right-20 space-y-1 sm:bottom-10">
        <Meta clip={clip} />
        {clip.content && clip.content !== `#${tag}` && <p className="line-clamp-3 text-sm text-white/85">{clip.content}</p>}
      </div>

      <div className="absolute bottom-28 right-3 flex flex-col items-center gap-3 sm:bottom-10">
        {!masked && (
          <button className={roundBtn} onClick={onToggleMute} aria-label={muted ? 'Activer le son' : 'Couper le son'}>
            <IconSound muted={muted} />
          </button>
        )}
        <button className={`${roundBtn} text-ok`} onClick={() => onResilience(clip, source)} aria-label="Résilience et intégrité">
          <IconShield />
        </button>
        <button className={roundBtn} onClick={share} aria-label="Partager">
          <IconShare />
        </button>
        <button className={roundBtn} onClick={() => onMenu(clip, source)} aria-label="Plus d'actions">
          <IconMore />
        </button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Carte de grille (desktop)

export function ClipCard({
  clip,
  verdict,
  store,
  onOpen,
  onMenu,
  onResilience,
}: {
  clip: Clip
  verdict: Verdict
  store: WallStore | null
  onOpen: (clip: Clip) => void
  onMenu: (clip: Clip, source: SourceState | null) => void
  onResilience: (clip: Clip, source: SourceState | null) => void
}) {
  const [hover, setHover] = useState(false)
  const [warm, setWarm] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [source, setSource] = useState<SourceState | null>(null)
  const extraServers = useExtraServers(store, clip.pubkey)
  const masked = verdict.status === 'warn' && !revealed

  return (
    <article
      className="group relative aspect-[9/16] overflow-hidden rounded-2xl border border-line bg-surface shadow-lg transition hover:border-accent/50"
      onMouseEnter={() => {
        setHover(true)
        setWarm(true)
      }}
      onMouseLeave={() => setHover(false)}
      data-clip-key={clip.key}
    >
      {masked ? (
        <WarningCover compact reasons={verdict.status === 'warn' ? verdict.reasons : []} onReveal={() => setRevealed(true)} />
      ) : (
        <button className="absolute inset-0 h-full w-full" onClick={() => onOpen(clip)} aria-label={`Ouvrir : ${clip.alt || clip.title}`}>
          <ResilientVideo
            clip={clip}
            extraServers={extraServers}
            active={hover}
            load={warm}
            muted
            onSource={setSource}
          />
        </button>
      )}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 to-transparent px-3 pb-2.5 pt-10">
        <Meta clip={clip} compact />
      </div>
      <div className="absolute right-2 top-2 flex gap-1.5 opacity-90">
        <button
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-ok backdrop-blur hover:text-accent"
          onClick={() => onResilience(clip, source)}
          aria-label="Résilience et intégrité"
        >
          <IconShield size={18} />
        </button>
        <button
          className="flex h-9 w-9 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur hover:text-accent"
          onClick={() => onMenu(clip, source)}
          aria-label="Plus d'actions"
        >
          <IconMore size={18} />
        </button>
      </div>
    </article>
  )
}
