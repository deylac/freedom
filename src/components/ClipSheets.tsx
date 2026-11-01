import { useEffect, useState } from 'react'
import { downloadVerified, hasBlob } from '../lib/blossom/client'
import { blossomUri, extFromMime, hostOf, normalizeServer } from '../lib/blossom/urls'
import { absoluteDate, shortHash } from '../lib/format'
import { sha256Hex } from '../lib/media/hash'
import { clipNaddr, type Clip, type ReportReason } from '../lib/nostr/events'
import { seenOn } from '../lib/nostr/pool'
import { shortNpub } from '../lib/nostr/signer'
import { reportClip } from '../lib/publish'
import { preservationPlan, preserveClip } from '../lib/preserve'
import { hideClip, muteAuthor, unhideClip } from '../lib/storage/personal'
import { useSettings } from '../hooks/basics'
import { upgradeProof, verifyProof, type ProofStatus } from '../lib/ots/client'
import { fromBase64, hexToBytes, parseOts, serializeOts } from '../lib/ots/ots'
import { clipShareUrl, useExtraServers } from './Clip'
import { useCandidates, type SourceState } from './ResilientVideo'
import type { WallStore } from '../lib/wall-store'
import { IconCheck, IconDownload, IconEyeOff, IconFlag, IconLink, IconShield } from './icons'
import { Button, copyText, Sheet, useToast } from './ui'

const REPORT_CHOICES: { reason: ReportReason; label: string }[] = [
  { reason: 'illegal', label: 'Contenu illégal (pédocriminalité, terrorisme…)' },
  { reason: 'profanity', label: 'Appel au meurtre, à la violence ou à la haine' },
  { reason: 'nudity', label: 'Nudité, pornographie' },
  { reason: 'spam', label: 'Spam, publicité, hors sujet' },
  { reason: 'other', label: 'Autre' },
]

function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

// ---------------------------------------------------------------------------
// Menu […] d'une vidéo

export function ClipMenu({
  clip,
  tag,
  store,
  onClose,
  onResilience,
  source,
}: {
  clip: Clip
  tag: string
  store: WallStore | null
  onClose: () => void
  onResilience: () => void
  source?: string | null
}) {
  const toast = useToast()
  const settings = useSettings()
  const extraServers = useExtraServers(store, clip)
  const candidates = useCandidates(clip, extraServers)
  const [mode, setMode] = useState<'menu' | 'report'>('menu')
  const [busy, setBusy] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [preserving, setPreserving] = useState(false)

  const preserve = async () => {
    setPreserving(true)
    try {
      const plan = preservationPlan(clip, store?.copyServersOf(clip.video.sha256) ?? [], store?.knownServers() ?? [], source)
      const r = await preserveClip(clip, plan.sources, plan.holders, plan.candidates)
      toast(
        r.copies.length
          ? `Copiée sur ${r.copies.length} serveur${r.copies.length > 1 ? 's' : ''} de plus (${r.copies.map(hostOf).join(', ')}). Merci !`
          : 'Aucun serveur supplémentaire n’a accepté la copie.',
        r.copies.length ? 'ok' : 'error',
      )
    } catch (err) {
      toast(`Préservation impossible : ${err instanceof Error ? err.message : err}`, 'error')
    } finally {
      setPreserving(false)
      onClose()
    }
  }

  const report = async (reason: ReportReason) => {
    setBusy(true)
    // FR-07 : masquage immédiat pour l'utilisateur courant.
    hideClip(clip.key)
    try {
      const authorServers = store?.serversOf(clip.pubkey) ?? []
      const res = await reportClip(clip, reason, '', authorServers)
      toast(`Signalement envoyé (${res.relays} relais, ${res.servers} serveurs média). Vidéo masquée.`, 'ok', {
        label: 'Annuler le masquage',
        run: () => unhideClip(clip.key),
      })
    } catch (err) {
      toast(`Vidéo masquée, mais le signalement n'a pas pu être diffusé : ${err instanceof Error ? err.message : err}`, 'error')
    } finally {
      setBusy(false)
      onClose()
    }
  }

  const download = async () => {
    if (!clip.video.sha256) return
    setDownloading(true)
    try {
      const { blob, url } = await downloadVerified(candidates, clip.video.sha256, sha256Hex)
      saveBlob(blob, `${tag}-${clip.video.sha256.slice(0, 12)}.${extFromMime(clip.video.mime ?? 'video/mp4')}`)
      toast(`Téléchargée depuis ${hostOf(url)} — empreinte SHA-256 vérifiée`, 'ok')
    } catch (err) {
      toast(`Téléchargement impossible : ${err instanceof Error ? err.message : err}`, 'error')
    } finally {
      setDownloading(false)
    }
  }

  if (mode === 'report') {
    return (
      <Sheet title="Signaler cette vidéo" onClose={onClose}>
        <p className="mb-4 text-sm text-muted">
          Le signalement (NIP-56) est diffusé sur les relais et envoyé aux serveurs qui hébergent le fichier (BUD-09). La vidéo
          sera immédiatement masquée pour vous. Un calcul anti-spam de quelques secondes rend le signalement crédible.
        </p>
        <div className="space-y-2">
          {REPORT_CHOICES.map((c) => (
            <button
              key={c.reason}
              disabled={busy}
              onClick={() => report(c.reason)}
              className="flex w-full items-center gap-3 rounded-xl border border-line bg-night/60 px-4 py-3 text-left text-sm text-white hover:border-rec/60 disabled:opacity-50"
            >
              <IconFlag size={18} className="text-rec" />
              {c.label}
            </button>
          ))}
        </div>
      </Sheet>
    )
  }

  const item = 'flex w-full items-center gap-3 rounded-xl px-3 py-3 text-left text-sm text-white hover:bg-night/70 disabled:opacity-50'
  return (
    <Sheet title="Actions" onClose={onClose}>
      <div className="space-y-1">
        <button className={item} onClick={() => setMode('report')}>
          <IconFlag size={20} className="text-rec" /> Signaler ce contenu
        </button>
        <button
          className={item}
          onClick={() => {
            muteAuthor(clip.pubkey)
            toast('Auteur masqué sur cet appareil', 'ok')
            onClose()
          }}
        >
          <IconEyeOff size={20} className="text-muted" /> Masquer cet auteur
        </button>
        <button
          className={item}
          onClick={async () => {
            const ok = await copyText(clipShareUrl(clip, tag, settings.relays))
            toast(ok ? 'Lien copié' : 'Copie impossible', ok ? 'ok' : 'error')
            onClose()
          }}
        >
          <IconLink size={20} className="text-muted" /> Copier le lien de la vidéo
        </button>
        <button className={item} onClick={download} disabled={downloading || !clip.video.sha256}>
          <IconDownload size={20} className="text-muted" /> {downloading ? 'Téléchargement et vérification…' : 'Télécharger (empreinte vérifiée)'}
        </button>
        <button className={item} onClick={preserve} disabled={preserving || !clip.video.sha256} data-testid="preserve">
          <IconShield size={20} className="text-accent" /> {preserving ? 'Copie en cours…' : 'Préserver cette vidéo (copie sur d’autres serveurs)'}
        </button>
        <button className={item} onClick={onResilience}>
          <IconShield size={20} className="text-ok" /> Résilience et intégrité
        </button>
      </div>
    </Sheet>
  )
}

// ---------------------------------------------------------------------------
// Horodatage Bitcoin (OpenTimestamps) de l'empreinte du fichier

function OtsSection({ clip }: { clip: Clip }) {
  const settings = useSettings()
  const toast = useToast()
  const { ots, sha256 } = clip.video
  const [status, setStatus] = useState<'idle' | 'running' | ProofStatus>('idle')
  const [proof, setProof] = useState<Uint8Array | null>(null)
  const ext = extFromMime(clip.video.mime ?? 'video/mp4')

  if (!ots || !sha256) {
    return <p className="text-xs text-muted">Aucune preuve d’horodatage n’accompagne cette vidéo.</p>
  }

  // Contacte calendriers (liste blanche) et explorateurs Bitcoin seulement sur demande.
  const verify = async () => {
    setStatus('running')
    try {
      const file = parseOts(fromBase64(ots))
      await upgradeProof(file, { calendars: settings.otsCalendars }).catch(() => false)
      setProof(serializeOts(file))
      setStatus(await verifyProof(file, hexToBytes(sha256), { explorers: settings.btcExplorers }))
    } catch (err) {
      setStatus({ state: 'invalid', reason: err instanceof Error ? err.message : String(err) })
    }
  }

  const download = () => {
    saveBlob(new Blob([(proof ?? fromBase64(ots)) as BlobPart], { type: 'application/octet-stream' }), `${sha256}.${ext}.ots`)
    toast('Preuve téléchargée. Vérification indépendante : ots verify fichier.ots', 'ok')
  }

  return (
    <div className="space-y-2" data-testid="ots">
      <div className="flex flex-wrap gap-2">
        <Button variant="ghost" onClick={verify} disabled={status === 'running'}>
          {status === 'running' ? 'Vérification…' : 'Vérifier l’ancrage Bitcoin'}
        </Button>
        <Button variant="ghost" onClick={download}>
          <IconDownload size={16} /> Preuve .ots
        </Button>
      </div>
      {typeof status === 'object' && (
        <p className={`text-sm ${status.state === 'verified' ? 'text-ok' : status.state === 'invalid' ? 'text-rec' : 'text-white/85'}`} data-state={status.state}>
          {status.state === 'verified'
            ? `✓ Ce fichier existait avant le bloc Bitcoin n° ${status.height} (${absoluteDate(status.time)}) — confirmé par ${status.sources.join(' et ')}.`
            : status.state === 'pending'
              ? 'Preuve en attente d’ancrage dans Bitcoin (en général moins de 24 h après la publication). Réessayez plus tard.'
              : status.state === 'unverifiable'
                ? `Ancrée au bloc ${status.height}, mais ${status.reason}.`
                : `Preuve invalide : ${status.reason}.`}
        </p>
      )}
      <p className="text-xs text-muted">
        L’empreinte de la vidéo est horodatée dans la blockchain Bitcoin (OpenTimestamps) : cela prouve que ce fichier exact
        existait à cette date, sans révéler son contenu. Vérifiable hors de HashWall avec l’outil standard
        <code className="mx-1 text-white/80">ots verify</code>.
      </p>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Fiche de résilience (badge bouclier)

type Availability = 'checking' | 'ok' | 'down'

export function ResilienceSheet({
  clip,
  store,
  source,
  onClose,
}: {
  clip: Clip
  store: WallStore | null
  source: SourceState | null
  onClose: () => void
}) {
  const toast = useToast()
  const extraServers = useExtraServers(store, clip)
  const candidates = useCandidates(clip, extraServers)
  const declared = new Set([clip.video.url, ...clip.video.fallbacks])
  const [status, setStatus] = useState<Record<string, Availability>>({})
  const [integrity, setIntegrity] = useState<'idle' | 'running' | { ok: boolean; host?: string; message?: string }>('idle')
  const sha = clip.video.sha256
  const alsoBy = store?.getSnapshot().items.find((i) => i.clip.key === clip.key)?.alsoBy ?? []

  useEffect(() => {
    let cancelled = false
    const initial: Record<string, Availability> = {}
    candidates.forEach((u) => (initial[u] = 'checking'))
    setStatus(initial)
    // BUD-01 HEAD /<sha256> : vérifie la présence sans télécharger.
    candidates.forEach((u) =>
      hasBlob(u).then((ok) => !cancelled && setStatus((s) => ({ ...s, [u]: ok ? 'ok' : 'down' }))),
    )
    return () => {
      cancelled = true
    }
  }, [candidates])

  const relays = seenOn(clip.id)
  const servers = candidates.map((u) => normalizeServer(u)).filter((s): s is string => !!s)
  const uri = sha ? blossomUri(sha, extFromMime(clip.video.mime ?? 'video/mp4'), servers.slice(0, 4), clip.pubkey) : null
  const available = Object.values(status).filter((s) => s === 'ok').length

  const verify = async () => {
    if (!sha) return
    setIntegrity('running')
    try {
      const { url } = await downloadVerified(candidates, sha, sha256Hex)
      setIntegrity({ ok: true, host: hostOf(url) })
    } catch (err) {
      setIntegrity({ ok: false, message: err instanceof Error ? err.message : String(err) })
    }
  }

  const copy = async (value: string, label: string) => {
    const ok = await copyText(value)
    toast(ok ? `${label} copié` : 'Copie impossible', ok ? 'ok' : 'error')
  }

  return (
    <Sheet title="Résilience et intégrité" onClose={onClose} wide>
      <div className="space-y-5 text-sm">
        <section data-testid="provenance">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Provenance</h3>
          <p className="text-white">
            Publiée par <span className="font-mono text-xs">{shortNpub(clip.pubkey)}</span>
          </p>
          {alsoBy.length > 0 && (
            <div className="mt-1 text-xs text-muted">
              <p>
                Le même fichier a aussi été publié par {alsoBy.length} autre{alsoBy.length > 1 ? 's' : ''} clé{alsoBy.length > 1 ? 's' : ''}.
                Nostr ne permet pas de savoir avec certitude qui l’a publié en premier : seul un horodatage Bitcoin vérifié le prouve.
              </p>
              <ul className="mt-1 font-mono">
                {alsoBy.slice(0, 10).map((c) => (
                  <li key={c.id}>{shortNpub(c.pubkey)}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
        <section>
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Empreinte SHA-256 du fichier</h3>
          {sha ? (
            <button onClick={() => copy(sha, 'Empreinte')} className="w-full break-all rounded-xl bg-night p-3 text-left font-mono text-xs text-accent">
              {sha}
            </button>
          ) : (
            <p className="text-rec">Aucune empreinte déclarée : impossible de vérifier ou de retrouver ce fichier ailleurs.</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Button variant="ghost" onClick={verify} disabled={!sha || integrity === 'running'}>
              {integrity === 'running' ? 'Téléchargement…' : 'Vérifier l’intégrité'}
            </Button>
            {typeof integrity === 'object' &&
              (integrity.ok ? (
                <span className="flex items-center gap-1 text-ok">
                  <IconCheck size={16} /> Fichier conforme ({integrity.host})
                </span>
              ) : (
                <span className="text-rec">{integrity.message}</span>
              ))}
          </div>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">
            Serveurs média — {available}/{candidates.length} disponibles
          </h3>
          <ul className="space-y-1.5">
            {candidates.map((u) => (
              <li key={u} className="flex items-center justify-between gap-3 rounded-lg bg-night/70 px-3 py-2">
                <span className="truncate">
                  {hostOf(u)}
                  <span className="ml-2 text-xs text-muted">{declared.has(u) ? (u === clip.video.url ? 'primaire' : 'miroir déclaré') : 'résolu par hash'}</span>
                  {source?.url === u && <span className="ml-2 text-xs text-accent">● en lecture</span>}
                </span>
                <span className={status[u] === 'ok' ? 'text-ok' : status[u] === 'down' ? 'text-rec' : 'text-muted'}>
                  {status[u] === 'ok' ? 'disponible' : status[u] === 'down' ? 'indisponible' : '…'}
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">Horodatage Bitcoin</h3>
          <OtsSection clip={clip} />
        </section>

        <section className="grid gap-3 sm:grid-cols-2">
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Signature Nostr</h3>
            <p className="text-white">
              <span className="text-ok">✓ Schnorr vérifiée</span> · {shortNpub(clip.pubkey)}
            </p>
            <p className="text-xs text-muted">Signée le {absoluteDate(clip.createdAt)}</p>
            {clip.publishedAt !== clip.createdAt && <p className="text-xs text-muted">Première publication : {absoluteDate(clip.publishedAt)}</p>}
          </div>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">Relais ({relays.length})</h3>
            <p className="text-xs text-muted">{relays.length ? relays.map((r) => r.replace(/^wss:\/\//, '').replace(/\/$/, '')).join(', ') : 'Reçue depuis le cache'}</p>
          </div>
        </section>

        <section className="space-y-2">
          <button onClick={() => copy(clipNaddr(clip), 'Identifiant naddr')} className="block w-full truncate rounded-lg bg-night/70 px-3 py-2 text-left font-mono text-xs text-muted hover:text-white">
            {shortHash(clipNaddr(clip))} — copier l’adresse Nostr
          </button>
          {uri && (
            <button onClick={() => copy(uri, 'URI Blossom')} className="block w-full truncate rounded-lg bg-night/70 px-3 py-2 text-left font-mono text-xs text-muted hover:text-white">
              {uri.slice(0, 48)}… — copier l’URI blossom: (BUD-10)
            </button>
          )}
        </section>
        <p className="text-xs leading-relaxed text-muted">
          La signature prouve qu’une clé a publié cette vidéo à cette date ; elle ne prouve ni l’identité de la personne, ni
          le lieu, ni que la scène n’a pas été mise en scène. Un navigateur web ne peut pas fournir d’attestation matérielle
          de capture (Proofmode).
        </p>
      </div>
    </Sheet>
  )
}

