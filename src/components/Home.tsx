import { useEffect, useMemo, useState } from 'react'
import { FEATURED_TAGS, SOURCE_URL } from '../config'
import { useSettings } from '../hooks/basics'
import { normalizeTag, type Route } from '../lib/hashtag'
import { KIND_SHORT_VIDEO, nowSeconds } from '../lib/nostr/events'
import { queryOnce, readRelays } from '../lib/nostr/pool'
import { persistentStorageAvailable } from '../lib/storage/local'
import { RelayBadge, TagSwitcher } from './Header'
import { IconSettings } from './icons'

interface Trend {
  tag: string
  clips: number
  authors: number
}

/** Murs populaires : hashtags des vidéos courtes des 3 derniers jours, pondérés par auteurs distincts. */
function useTrending(relays: string[]) {
  const [trends, setTrends] = useState<Trend[] | null>(null)
  useEffect(() => {
    let cancelled = false
    queryOnce(relays, { kinds: [KIND_SHORT_VIDEO], since: nowSeconds() - 3 * 86400, limit: 400 }, 6000)
      .then((events) => {
        const byTag = new Map<string, { clips: number; authors: Set<string> }>()
        for (const e of events) {
          for (const t of new Set(e.tags.filter((t) => t[0] === 't' && t[1]).map((t) => normalizeTag(t[1])))) {
            if (!t) continue
            const entry = byTag.get(t) ?? { clips: 0, authors: new Set() }
            entry.clips++
            entry.authors.add(e.pubkey)
            byTag.set(t, entry)
          }
        }
        const list = [...byTag.entries()]
          .map(([tag, v]) => ({ tag, clips: v.clips, authors: v.authors.size }))
          .filter((t) => t.authors >= 2)
          .sort((a, b) => b.authors - a.authors || b.clips - a.clips)
          .slice(0, 16)
        if (!cancelled) setTrends(list)
      })
      .catch(() => !cancelled && setTrends([]))
    return () => {
      cancelled = true
    }
  }, [relays])
  return trends
}

function Chip({ tag, sub, onClick }: { tag: string; sub?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="rounded-full border border-line bg-surface px-4 py-2 text-sm font-semibold text-white transition hover:border-accent hover:text-accent">
      #{tag}
      {sub && <span className="ml-2 text-xs font-normal text-muted">{sub}</span>}
    </button>
  )
}

export function Home({ navigate, onSettings }: { navigate: (r: Route) => void; onSettings: () => void }) {
  const settings = useSettings()
  // Tendances : 3 relais suffisent (requête ponctuelle, coûteuse pour les relais à grande échelle).
  const trendRelays = useMemo(() => readRelays(settings.relays, 3), [settings.relays])
  const trends = useTrending(trendRelays)
  const go = (tag: string) => navigate({ view: 'wall', tag })

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-2xl flex-col px-5 pt-safe pb-safe">
      <header className="flex items-center justify-between py-3">
        <div className="flex items-center gap-2">
          <img src="./icons/icon.svg" alt="" className="h-9 w-9 rounded-xl" />
          <span className="text-lg font-extrabold text-white">HashWall</span>
        </div>
        <div className="flex items-center gap-2">
          <RelayBadge />
          <button onClick={onSettings} aria-label="Réglages" className="rounded-full p-2 text-muted hover:text-white">
            <IconSettings size={20} />
          </button>
        </div>
      </header>

      <main className="flex flex-1 flex-col justify-center gap-8 py-10">
        <div className="space-y-3">
          <h1 className="text-4xl font-black leading-tight tracking-tight text-white sm:text-5xl">
            Filmez 60 secondes.
            <br />
            <span className="text-accent">Publiées sans compte.</span>
          </h1>
          <p className="text-base text-muted">
            Un mur vidéo public par hashtag, en direct, hébergé par personne en particulier : les vidéos sont signées sur
            Nostr et répliquées sur plusieurs serveurs Blossom indépendants.
          </p>
        </div>

        <TagSwitcher autoFocus className="h-14 text-base" onGo={go} />

        {FEATURED_TAGS.length > 0 && (
          <section>
            <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">À la une</h2>
            <div className="flex flex-wrap gap-2">
              {FEATURED_TAGS.map((t) => (
                <Chip key={t} tag={normalizeTag(t)} onClick={() => go(normalizeTag(t))} />
              ))}
            </div>
          </section>
        )}

        <section>
          <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Murs actifs (72 h)</h2>
          {trends === null ? (
            <p className="text-sm text-muted">Recherche sur les relais…</p>
          ) : trends.length === 0 ? (
            <p className="text-sm text-muted">Aucun mur actif trouvé. Créez le vôtre : tapez un hashtag ci-dessus.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {trends.map((t) => (
                <Chip key={t.tag} tag={t.tag} sub={`${t.authors} pers.`} onClick={() => go(t.tag)} />
              ))}
            </div>
          )}
        </section>

        <ul className="grid gap-3 text-sm sm:grid-cols-3">
          {[
            ['Sans compte', 'Une clé anonyme est créée sur votre téléphone. Aucun email, aucun mot de passe.'],
            ['Anti-censure', 'Chaque vidéo est copiée sur 3 serveurs ; le lecteur bascule seul si l’un tombe.'],
            ['GPS supprimé', 'La vidéo passe par un canvas : aucune position ni information sur l’appareil n’est envoyée.'],
          ].map(([title, text]) => (
            <li key={title} className="rounded-2xl border border-line bg-surface p-4">
              <p className="font-semibold text-ok">{title}</p>
              <p className="mt-1 text-muted">{text}</p>
            </li>
          ))}
        </ul>

        {!persistentStorageAvailable() && (
          <p className="rounded-xl border border-rec/40 bg-rec/10 p-3 text-sm text-white/90">
            Vous consultez HashWall via une passerelle partagée : votre clé ne sera pas enregistrée sur l’appareil.
          </p>
        )}
      </main>

      <footer className="py-4 text-center text-xs text-muted">
        Fonctionne à 100 % dans votre navigateur. Le #hashtag de l’adresse n’est jamais envoyé au serveur de ce site ·{' '}
        <a className="text-accent" href={SOURCE_URL} target="_blank" rel="noreferrer noopener">
          code source
        </a>
      </footer>
    </div>
  )
}
