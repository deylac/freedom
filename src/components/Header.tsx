import { useState, type FormEvent } from 'react'
import { useReadRelays, useRelayStatus } from '../hooks/basics'
import { normalizeTag, type Route } from '../lib/hashtag'
import { IconQr, IconSearch, IconSettings } from './icons'

export function RelayBadge() {
  const reading = useReadRelays()
  const { connected, total } = useRelayStatus(reading)
  const online = connected > 0
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-black/40 px-2.5 py-1 text-xs font-medium backdrop-blur"
      title={`${connected} relais connectés sur ${total}`}
      role="status"
    >
      <span className={`h-2 w-2 rounded-full ${online ? 'animate-blink bg-ok' : 'bg-rec'}`} />
      <span className={online ? 'text-ok' : 'text-rec'}>
        {online ? `${connected} Relais actif${connected > 1 ? 's' : ''}` : 'Connexion…'}
      </span>
    </span>
  )
}

export function TagSwitcher({ onGo, autoFocus = false, className = '' }: { onGo: (tag: string) => void; autoFocus?: boolean; className?: string }) {
  const [value, setValue] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const tag = normalizeTag(value)
    if (tag) {
      onGo(tag)
      setValue('')
    }
  }
  return (
    <form onSubmit={submit} className={`flex items-center gap-2 rounded-xl border border-line bg-night/80 px-3 backdrop-blur focus-within:border-accent ${className}`} role="search">
      <span className="text-lg font-bold text-accent">#</span>
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="changer de mur"
        aria-label="Aller au mur du hashtag"
        autoFocus={autoFocus}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="go"
        className="h-10 min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-muted focus:outline-none"
      />
      <button type="submit" aria-label="Ouvrir le mur" className="text-muted hover:text-accent">
        <IconSearch size={18} />
      </button>
    </form>
  )
}

export function Header({
  tag,
  overlay,
  navigate,
  onQr,
  onSettings,
}: {
  tag: string
  overlay: boolean
  navigate: (r: Route) => void
  onQr: () => void
  onSettings: () => void
}) {
  const [searching, setSearching] = useState(false)
  const iconBtn = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-black/40 text-white backdrop-blur hover:text-accent'
  return (
    <header
      className={`${overlay ? 'fixed bg-gradient-to-b from-night/90 via-night/50 to-transparent pb-8' : 'sticky border-b border-line bg-night/95 pb-3 backdrop-blur'} inset-x-0 top-0 z-30 px-4 pt-safe`}
    >
      <div className="flex items-center gap-2">
        <button onClick={() => navigate({ view: 'home' })} aria-label="Accueil HashWall" className="shrink-0">
          <img src="./icons/icon.svg" alt="" className="h-9 w-9 rounded-xl" />
        </button>
        <h1 className="min-w-0 flex-1 truncate text-3xl font-extrabold tracking-tight text-white">
          <span className="text-accent">#</span>
          {tag}
        </h1>
        <span className="hidden md:inline-flex">
          <RelayBadge />
        </span>
        <TagSwitcher className="hidden w-56 md:flex" onGo={(t) => navigate({ view: 'wall', tag: t })} />
        <button className={iconBtn} onClick={onQr} aria-label="Afficher le QR code du mur">
          <IconQr size={18} />
        </button>
        <button className={iconBtn} onClick={onSettings} aria-label="Réglages">
          <IconSettings size={18} />
        </button>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2 md:hidden">
        <RelayBadge />
        <button
          className="flex items-center gap-1.5 rounded-full bg-black/40 px-3 py-1.5 text-xs font-medium text-white backdrop-blur hover:text-accent"
          onClick={() => setSearching((s) => !s)}
          aria-label="Changer de mur"
          aria-expanded={searching}
        >
          <IconSearch size={14} /> Changer de mur
        </button>
      </div>
      {searching && (
        <TagSwitcher
          autoFocus
          className="mt-3 md:hidden"
          onGo={(t) => {
            setSearching(false)
            navigate({ view: 'wall', tag: t })
          }}
        />
      )}
    </header>
  )
}
