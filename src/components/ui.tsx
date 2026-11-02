import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { useEscape } from '../hooks/basics'
import { IconClose } from './icons'

// ---------------------------------------------------------------------------
// Feuille modale (bas d'écran sur mobile, centrée sur desktop)

export function Sheet({
  title,
  onClose,
  children,
  wide = false,
  labelledBy,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
  labelledBy?: string
}) {
  useEscape(onClose)
  const panel = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    panel.current?.focus()
    return () => previous?.focus?.()
  }, [])
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center" role="presentation">
      <button aria-label="Fermer" className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy ?? 'sheet-title'}
        className={`animate-rise relative max-h-[92dvh] w-full overflow-y-auto rounded-t-3xl border border-line bg-surface p-5 pb-safe shadow-2xl outline-none sm:rounded-3xl ${wide ? 'sm:max-w-2xl' : 'sm:max-w-md'}`}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2 id={labelledBy ?? 'sheet-title'} className="text-lg font-semibold text-white">
            {title}
          </h2>
          <button onClick={onClose} aria-label="Fermer" className="-m-2 rounded-full p-2 text-muted hover:text-white">
            <IconClose />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

export function Button({
  children,
  variant = 'primary',
  className = '',
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'ok' }) {
  const styles = {
    primary: 'bg-accent text-night hover:brightness-110',
    ghost: 'border border-line bg-night/60 text-white hover:border-accent/60',
    danger: 'bg-rec text-white hover:brightness-110',
    ok: 'bg-ok text-night hover:brightness-110',
  }[variant]
  return (
    <button
      {...props}
      className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold transition disabled:opacity-40 ${styles} ${className}`}
    >
      {children}
    </button>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label className={`flex items-start justify-between gap-4 py-2 ${disabled ? 'opacity-50' : ''}`}>
      <span>
        <span className="block text-sm text-white">{label}</span>
        {hint && <span className="mt-0.5 block text-xs text-muted">{hint}</span>}
      </span>
      <input
        type="checkbox"
        role="switch"
        className="peer sr-only"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span
        aria-hidden
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full border transition ${checked ? 'border-accent bg-accent/30' : 'border-line bg-night'} peer-focus-visible:outline-2 peer-focus-visible:outline-accent`}
      >
        <span className={`absolute top-0.5 h-4.5 w-4.5 rounded-full transition-all ${checked ? 'left-5.5 bg-accent' : 'left-0.5 bg-muted'}`} />
      </span>
    </label>
  )
}

// ---------------------------------------------------------------------------
// Notifications éphémères

interface ToastItem {
  id: number
  text: string
  tone: 'info' | 'ok' | 'error'
  action?: { label: string; run: () => void }
}

const ToastContext = createContext<(text: string, tone?: ToastItem['tone'], action?: ToastItem['action']) => void>(() => {})

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([])
  const push = useCallback((text: string, tone: ToastItem['tone'] = 'info', action?: ToastItem['action']) => {
    const id = Date.now() + Math.random()
    setItems((list) => [...list.slice(-2), { id, text, tone, action }])
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), action ? 7000 : 4000)
  }, [])
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 top-20 z-[70] flex flex-col items-center gap-2 px-4">
        {items.map((t) => (
          <div
            key={t.id}
            className={`animate-rise pointer-events-auto flex max-w-md items-center gap-3 rounded-2xl border px-4 py-3 text-sm shadow-xl ${
              t.tone === 'error' ? 'border-rec/50 bg-surface text-white' : t.tone === 'ok' ? 'border-ok/50 bg-surface text-white' : 'border-line bg-surface text-white'
            }`}
          >
            <span>{t.text}</span>
            {t.action && (
              <button
                className="shrink-0 font-semibold text-accent"
                onClick={() => {
                  t.action!.run()
                  setItems((list) => list.filter((x) => x.id !== t.id))
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export const useToast = () => useContext(ToastContext)

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Partage natif (Web Share) avec repli sur le presse-papiers. */
export async function shareLink(url: string, title: string): Promise<'shared' | 'copied' | 'failed'> {
  if (navigator.share) {
    try {
      await navigator.share({ url, title })
      return 'shared'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'shared'
    }
  }
  return (await copyText(url)) ? 'copied' : 'failed'
}

/**
 * Partage du FICHIER vidéo (Instagram, TikTok, WhatsApp, Signal, X… acceptent un fichier, pas un lien
 * vers une application web). Doit être appelé directement dans le geste de l'utilisateur (Safari).
 * Sans partage de fichiers : le fichier est enregistré et le lien copié.
 */
export async function shareVideoFile(file: File, text: string, url: string): Promise<'shared' | 'saved'> {
  if (typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], text: `${text}\n${url}` })
      return 'shared'
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'shared'
    }
  }
  const objectUrl = URL.createObjectURL(file)
  const a = document.createElement('a')
  a.href = objectUrl
  a.download = file.name
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000)
  await copyText(url)
  return 'saved'
}
