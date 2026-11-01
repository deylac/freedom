import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { Filter } from 'nostr-tools/filter'
import { WALL_KINDS } from '../config'
import { clipKeyFromPointer, KIND_DELETION, KIND_MUTE_LIST, KIND_REPORT, KIND_SERVER_LIST } from '../lib/nostr/events'
import { LiveSubscription, queryOnce } from '../lib/nostr/pool'
import { identityPubkey } from '../lib/nostr/signer'
import { hiddenKeys, localMutes } from '../lib/storage/personal'
import { WallStore, type StoreContext, type WallSnapshot } from '../lib/wall-store'
import { useSettings, usePersonalVersion } from './basics'
import * as nip19 from 'nostr-tools/nip19'

const probe = typeof document !== 'undefined' ? document.createElement('video') : null
const playable = new Map<string, boolean>()
export function canPlay(mime: string): boolean {
  if (!playable.has(mime)) playable.set(mime, !!probe && probe.canPlayType(mime) !== '')
  return playable.get(mime)!
}

const EMPTY: WallSnapshot = { items: [], loading: false, version: 0 }
const noop = () => () => {}

/** Relance les abonnements au retour du réseau ou quand l'onglet redevient visible. */
function useKick(subs: Array<LiveSubscription | null>) {
  useEffect(() => {
    let hiddenAt = 0
    const kick = () => subs.forEach((s) => s?.kick())
    const onVisibility = () => {
      if (document.hidden) hiddenAt = Date.now()
      else if (Date.now() - hiddenAt > 5000) kick()
    }
    window.addEventListener('online', kick)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('online', kick)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [subs])
}

export function useWall(tag: string | null, focusPointer?: string) {
  const settings = useSettings()
  const personal = usePersonalVersion()

  const context: StoreContext = useMemo(
    () => ({
      hiddenKeys: hiddenKeys(),
      localMutes: localMutes(),
      moderators: new Set(settings.moderators),
      threshold: settings.reportThreshold,
      self: identityPubkey(),
    }),
    [settings.moderators, settings.reportThreshold, personal],
  )

  const store = useMemo(() => (tag ? new WallStore(tag, context, canPlay) : null), [tag])
  useEffect(() => store?.setContext(context), [store, context])

  const snapshot = useSyncExternalStore(store?.subscribe ?? noop, store?.getSnapshot ?? (() => EMPTY))

  // --- abonnement principal : vidéos du mur + listes de masquage des modérateurs ---
  const [mainSub, setMainSub] = useState<LiveSubscription | null>(null)
  useEffect(() => {
    if (!store || !tag) return
    store.setLoading(true)
    const filters: Filter[] = [{ kinds: WALL_KINDS, '#t': [tag], limit: 200 }]
    const muteAuthors = [...new Set([...settings.moderators, identityPubkey()])]
    filters.push({ kinds: [KIND_MUTE_LIST], authors: muteAuthors })
    const sub = new LiveSubscription({
      relays: settings.relays,
      filters,
      label: `wall:${tag}`,
      onevent: (e) => store.ingest(e),
      oneose: () => store.setLoading(false),
    }).start()
    setMainSub(sub)
    return () => {
      sub.stop()
      setMainSub(null)
    }
  }, [store, tag, settings.relays, settings.moderators])

  // --- abonnement d'annotations : signalements, suppressions, listes de serveurs ---
  const targetsKey = useMemo(() => {
    if (!store) return ''
    const t = store.annotationTargets()
    return JSON.stringify(t)
  }, [store, snapshot.version])
  const [debouncedKey, setDebouncedKey] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setDebouncedKey(targetsKey), 1200)
    return () => clearTimeout(id)
  }, [targetsKey])

  const [annotationSub, setAnnotationSub] = useState<LiveSubscription | null>(null)
  useEffect(() => {
    if (!store || !debouncedKey) return
    const t = JSON.parse(debouncedKey) as ReturnType<WallStore['annotationTargets']>
    const filters: Filter[] = []
    if (t.hashes.length) filters.push({ kinds: [KIND_REPORT], '#x': t.hashes })
    if (t.ids.length) filters.push({ kinds: [KIND_REPORT, KIND_DELETION], '#e': t.ids })
    if (t.addresses.length) filters.push({ kinds: [KIND_REPORT, KIND_DELETION], '#a': t.addresses })
    if (t.pubkeys.length) filters.push({ kinds: [KIND_SERVER_LIST], authors: t.pubkeys })
    if (filters.length === 0) return
    const sub = new LiveSubscription({
      relays: settings.relays,
      filters,
      label: 'annotations',
      onevent: (e) => store.ingest(e),
    }).start()
    setAnnotationSub(sub)
    return () => {
      sub.stop()
      setAnnotationSub(null)
    }
  }, [store, debouncedKey, settings.relays])

  useKick(useMemo(() => [mainSub, annotationSub], [mainSub, annotationSub]))

  // --- lien direct vers un clip (#tag/naddr…) plus ancien que l'historique chargé ---
  useEffect(() => {
    if (!store || !focusPointer) return
    try {
      const decoded = nip19.decode(focusPointer)
      const filter: Filter =
        decoded.type === 'naddr'
          ? { kinds: [decoded.data.kind], authors: [decoded.data.pubkey], '#d': [decoded.data.identifier] }
          : decoded.type === 'nevent'
            ? { ids: [decoded.data.id] }
            : { ids: [] }
      if (!filter.ids || filter.ids.length) {
        const hints = decoded.type === 'naddr' || decoded.type === 'nevent' ? (decoded.data.relays ?? []) : []
        void queryOnce([...settings.relays, ...hints], filter).then((events) => events.forEach((e) => store.ingest(e)))
      }
    } catch {
      /* pointeur invalide : ignoré */
    }
  }, [store, focusPointer, settings.relays])

  const focusKey = focusPointer ? clipKeyFromPointer(focusPointer) : null
  return { store, snapshot, focusKey }
}
