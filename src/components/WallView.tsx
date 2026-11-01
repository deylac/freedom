import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMediaQuery } from '../hooks/basics'
import { useWall } from '../hooks/useWall'
import type { Route } from '../lib/hashtag'
import type { Clip } from '../lib/nostr/events'
import type { WallItem, WallStore } from '../lib/wall-store'
import { ClipCard, FeedItem } from './Clip'
import { ClipMenu, ResilienceSheet } from './ClipSheets'
import { Header } from './Header'
import { IconBack, IconPlus } from './icons'
import type { SourceState } from './ResilientVideo'

type Target = { clip: Clip; source: SourceState | null }

const shownCount = (n: number) => n > 0

/** Fige l'ordre affiché quand l'utilisateur n'est pas en haut : les nouveautés attendent derrière une pastille. */
function useFrozenOrder(items: WallItem[], live: boolean) {
  const keys = items.map((i) => i.clip.key).join('|')
  const [order, setOrder] = useState<string[]>([])
  useEffect(() => {
    if (live) setOrder(keys ? keys.split('|') : [])
  }, [live, keys])
  return useMemo(() => {
    if (live) return { shown: items, fresh: 0 }
    const byKey = new Map(items.map((i) => [i.clip.key, i]))
    const known = new Set(order)
    const shown = order.map((k) => byKey.get(k)).filter((i): i is WallItem => !!i)
    return { shown, fresh: items.filter((i) => !known.has(i.clip.key)).length }
  }, [items, live, order])
}

function FreshPill({ count, onClick }: { count: number; onClick: () => void }) {
  if (count <= 0) return null
  return (
    <button
      onClick={onClick}
      className="animate-rise fixed left-1/2 top-24 z-40 -translate-x-1/2 rounded-full bg-accent px-4 py-2 text-sm font-bold text-night shadow-lg shadow-accent/30"
    >
      ↑ {count} nouvelle{count > 1 ? 's' : ''} vidéo{count > 1 ? 's' : ''}
    </button>
  )
}

export function RecordFab({ tag, onRecord }: { tag: string; onRecord: () => void }) {
  return (
    <button
      onClick={onRecord}
      className="fixed bottom-safe left-1/2 z-40 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-2 rounded-full bg-accent px-6 py-4 text-base font-extrabold text-night shadow-xl shadow-accent/25 transition hover:scale-[1.02] active:scale-95"
    >
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-rec text-white">
        <IconPlus size={16} strokeWidth={3} />
      </span>
      <span className="truncate">Filmer pour #{tag}</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Flux vertical (mobile, et mode théâtre desktop)

function FeedView({
  items,
  tag,
  store,
  startKey,
  onAtTop,
  onMenu,
  onResilience,
  scrollToTopSignal,
  footer,
}: {
  items: WallItem[]
  tag: string
  store: WallStore | null
  startKey?: string | null
  onAtTop?: (atTop: boolean) => void
  onMenu: (t: Target) => void
  onResilience: (t: Target) => void
  scrollToTopSignal?: number
  footer?: React.ReactNode
}) {
  const container = useRef<HTMLDivElement>(null)
  const [activeKey, setActiveKey] = useState<string | null>(startKey ?? null)
  const [muted, setMuted] = useState(true)
  const activeIndex = Math.max(0, items.findIndex((i) => i.clip.key === activeKey))
  const keys = items.map((i) => i.clip.key).join('|')

  useEffect(() => {
    const root = container.current
    if (!root) return
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && e.intersectionRatio >= 0.6) {
            const key = (e.target as HTMLElement).dataset.clipKey
            if (key) setActiveKey(key)
          }
        }
      },
      { root, threshold: [0.6] },
    )
    root.querySelectorAll('[data-clip-key]').forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [keys])

  // Positionnement initial sur le clip demandé (lien direct / ouverture depuis la grille).
  const positioned = useRef(false)
  useEffect(() => {
    if (positioned.current || !startKey) return
    const el = container.current?.querySelector(`[data-clip-key="${CSS.escape(startKey)}"]`)
    if (el) {
      el.scrollIntoView({ block: 'start' })
      positioned.current = true
    }
  }, [startKey, keys])

  useEffect(() => {
    if (scrollToTopSignal) container.current?.scrollTo({ top: 0, behavior: 'smooth' })
  }, [scrollToTopSignal])

  useEffect(() => {
    onAtTop?.(activeIndex === 0)
  }, [activeIndex, onAtTop])

  // Nouveauté arrivée en tête alors qu'on regardait le premier clip : on l'affiche.
  // (Le « re-snap » CSS garderait sinon l'ancien clip à l'écran, la nouveauté restant invisible au-dessus.)
  const firstKey = items[0]?.clip.key
  const previousFirst = useRef(firstKey)
  const wasAtTop = useRef(true)
  useLayoutEffect(() => {
    if (firstKey && previousFirst.current && firstKey !== previousFirst.current && wasAtTop.current) {
      container.current?.scrollTo({ top: 0 })
      setActiveKey(firstKey)
    }
    previousFirst.current = firstKey
  }, [firstKey])
  useEffect(() => {
    wasAtTop.current = activeIndex === 0
  }, [activeIndex])

  const toggleMute = useCallback(() => setMuted((m) => !m), [])

  return (
    <div ref={container} className="no-scrollbar h-[100dvh] snap-y snap-mandatory overflow-y-scroll overscroll-contain [overflow-anchor:none]" data-testid="feed">
      {items.map((item, i) => (
        <FeedItem
          key={item.clip.key}
          clip={item.clip}
          verdict={item.verdict}
          tag={tag}
          store={store}
          active={i === activeIndex}
          near={Math.abs(i - activeIndex) <= 1}
          muted={muted}
          onToggleMute={toggleMute}
          onMenu={(clip, source) => onMenu({ clip, source })}
          onResilience={(clip, source) => onResilience({ clip, source })}
        />
      ))}
      {footer && <section className="flex h-[40dvh] snap-start items-center justify-center bg-night">{footer}</section>}
    </div>
  )
}

// ---------------------------------------------------------------------------

export function WallView({
  tag,
  focusPointer,
  navigate,
  onRecord,
  onQr,
  onSettings,
}: {
  tag: string
  focusPointer?: string
  navigate: (r: Route) => void
  onRecord: () => void
  onQr: () => void
  onSettings: () => void
}) {
  const { store, snapshot, focusKey, older, loadOlder } = useWall(tag, focusPointer)
  const olderButton =
    shownCount(snapshot.items.length) && older !== 'done' ? (
      <button
        onClick={() => void loadOlder()}
        disabled={older === 'loading'}
        className="mx-auto my-6 block rounded-full border border-line bg-surface px-5 py-2.5 text-sm font-semibold text-white hover:border-accent disabled:opacity-50"
        data-testid="load-older"
      >
        {older === 'loading' ? 'Recherche…' : 'Vidéos plus anciennes'}
      </button>
    ) : older === 'done' ? (
      <p className="my-6 text-center text-xs text-muted">Début du mur atteint.</p>
    ) : null
  const desktop = useMediaQuery('(min-width: 768px)')
  const [menu, setMenu] = useState<Target | null>(null)
  const [resilience, setResilience] = useState<Target | null>(null)
  const [theater, setTheater] = useState<string | null>(null)
  const [atTop, setAtTop] = useState(true)
  const [topSignal, setTopSignal] = useState(0)
  const { shown, fresh } = useFrozenOrder(snapshot.items, atTop)

  // Lien direct vers un clip : théâtre sur desktop, positionnement dans le flux sur mobile.
  const focusAvailable = !!focusKey && snapshot.items.some((i) => i.clip.key === focusKey)
  useEffect(() => {
    if (desktop && focusAvailable) setTheater(focusKey)
  }, [desktop, focusAvailable, focusKey])

  // Grille desktop : « en haut » = défilement proche de 0.
  useEffect(() => {
    if (!desktop) return
    const onScroll = () => setAtTop(window.scrollY < 120)
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [desktop])

  const showFresh = () => {
    setAtTop(true)
    if (desktop) window.scrollTo({ top: 0, behavior: 'smooth' })
    else setTopSignal((n) => n + 1)
  }

  const empty = !snapshot.loading && shown.length === 0
  const header = <Header tag={tag} overlay={!desktop} navigate={navigate} onQr={onQr} onSettings={onSettings} />

  return (
    <div className="min-h-[100dvh] bg-night" data-testid="wall" data-tag={tag}>
      {header}
      <FreshPill count={fresh} onClick={showFresh} />

      {empty ? (
        <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-3 px-8 pt-24 text-center">
          <p className="text-xl font-bold text-white">Aucune vidéo pour #{tag} pour l’instant.</p>
          <p className="max-w-sm text-sm text-muted">
            Les nouvelles vidéos apparaîtront ici en direct, sans recharger la page. Partagez le QR code autour de vous et
            filmez la première.
          </p>
        </div>
      ) : snapshot.loading && shown.length === 0 ? (
        <div className="flex min-h-[70dvh] flex-col items-center justify-center gap-3 pt-24 text-muted" role="status">
          <span className="h-8 w-8 animate-spin rounded-full border-2 border-line border-t-accent" />
          Connexion aux relais Nostr…
        </div>
      ) : desktop ? (
        <main className="mx-auto grid max-w-7xl grid-cols-2 gap-4 p-4 pb-32 sm:grid-cols-3 lg:grid-cols-4" data-testid="grid">
          {shown.map((item) => (
            <ClipCard
              key={item.clip.key}
              clip={item.clip}
              verdict={item.verdict}
              store={store}
              onOpen={(c) => setTheater(c.key)}
              onMenu={(clip, source) => setMenu({ clip, source })}
              onResilience={(clip, source) => setResilience({ clip, source })}
            />
          ))}
          <div className="col-span-full">{olderButton}</div>
        </main>
      ) : (
        <FeedView
          items={shown}
          tag={tag}
          store={store}
          startKey={focusAvailable ? focusKey : null}
          onAtTop={setAtTop}
          onMenu={setMenu}
          onResilience={setResilience}
          scrollToTopSignal={topSignal}
          footer={olderButton}
        />
      )}

      {desktop && theater && (
        <div className="fixed inset-0 z-40 bg-black">
          <div className="mx-auto h-full max-w-[min(100vw,calc(100dvh*9/16))]">
            <FeedView
              items={shown}
              tag={tag}
              store={store}
              startKey={theater}
              onMenu={setMenu}
              onResilience={setResilience}
            />
          </div>
          <button
            onClick={() => setTheater(null)}
            className="absolute left-4 top-4 flex items-center gap-2 rounded-full bg-surface/90 px-4 py-2 text-sm font-semibold text-white hover:text-accent"
          >
            <IconBack size={18} /> Retour au mur
          </button>
        </div>
      )}

      <RecordFab tag={tag} onRecord={onRecord} />

      {menu && (
        <ClipMenu
          clip={menu.clip}
          tag={tag}
          store={store}
          source={menu.source?.url}
          onClose={() => setMenu(null)}
          onResilience={() => {
            setResilience(menu)
            setMenu(null)
          }}
        />
      )}
      {resilience && <ResilienceSheet clip={resilience.clip} store={store} source={resilience.source} onClose={() => setResilience(null)} />}
    </div>
  )
}
