/**
 * Parcours C — QR code plein écran généré LOCALEMENT.
 * Angle mort : les générateurs en ligne (api.qrserver.com…) recevraient le hashtag et l'IP.
 */
import qrcode from 'qrcode-generator'
import { useMemo } from 'react'
import { useEscape } from '../hooks/basics'
import { wallUrl } from '../lib/hashtag'
import { IconClose, IconLink, IconShare } from './icons'
import { copyText, shareLink, useToast } from './ui'

export function QrSvg({ text, className = '' }: { text: string; className?: string }) {
  const { path, size } = useMemo(() => {
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const count = qr.getModuleCount()
    let d = ''
    for (let r = 0; r < count; r++) for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`
    return { path: d, size: count + 8 }
  }, [text])
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className={className} role="img" aria-label={`QR code : ${text}`} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#ffffff" />
      <path d={path} fill="#000000" />
    </svg>
  )
}

export function QrModal({ tag, onClose }: { tag: string; onClose: () => void }) {
  useEscape(onClose)
  const toast = useToast()
  const url = wallUrl(tag)
  return (
    <div className="fixed inset-0 z-[60] flex flex-col items-center justify-center gap-6 bg-white p-6 pt-safe pb-safe text-black" role="dialog" aria-modal="true" aria-label={`QR code du mur #${tag}`}>
      <button onClick={onClose} aria-label="Fermer" className="absolute right-4 top-4 rounded-full p-3 text-black">
        <IconClose size={28} />
      </button>
      <p className="text-center text-3xl font-black tracking-tight sm:text-5xl">#{tag}</p>
      <QrSvg text={url} className="aspect-square w-full max-w-[min(80vw,70vh)]" />
      <p className="max-w-full break-all text-center font-mono text-sm text-black/70">{url}</p>
      <p className="text-center text-base font-semibold">Scannez pour filmer et regarder ce mur</p>
      <div className="flex gap-3">
        <button
          className="flex items-center gap-2 rounded-xl border-2 border-black px-4 py-2.5 font-semibold"
          onClick={async () => toast((await copyText(url)) ? 'Lien copié' : 'Copie impossible', 'ok')}
        >
          <IconLink size={18} /> Copier
        </button>
        <button
          className="flex items-center gap-2 rounded-xl bg-black px-4 py-2.5 font-semibold text-white"
          onClick={() => void shareLink(url, `#${tag} — HashWall`)}
        >
          <IconShare size={18} /> Partager
        </button>
      </div>
    </div>
  )
}
