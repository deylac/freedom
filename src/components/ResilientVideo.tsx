/**
 * FR-06 — Lecteur anti-censure.
 *
 * Bascule automatique, sans recharger la carte, entre :
 *   url → fallback (imeta) → serveurs de l'auteur (kind 10063) → serveurs par défaut,
 * déclenchée par :
 *   - un événement `error` (404, 451, 503, échec DNS, requête bloquée) ;
 *   - un blocage silencieux : aucune donnée après STALL_MS (IP en trou noir : le navigateur
 *     ne lève une erreur qu'au bout de 20 à 75 s) ;
 * La position de lecture est conservée d'une source à l'autre.
 *
 * La vignette est un <img> confié à `handleMediaFallbacks` de blossom-client-sdk, qui
 * reconstruit l'URL sur les serveurs de l'auteur à partir du hash.
 */
import { handleMediaFallbacks } from 'blossom-client-sdk/media'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MAX_DECLARED_DURATION_S } from '../config'
import { candidateUrls, extFromMime, hostOf } from '../lib/blossom/urls'
import type { Clip } from '../lib/nostr/events'

const STALL_MS = 7000

export interface SourceState {
  url: string | null
  index: number
  total: number
  failed: boolean
}

export function useCandidates(clip: Clip, extraServers: string[]): string[] {
  const { video } = clip
  return useMemo(
    () => candidateUrls([video.url, ...video.fallbacks], video.sha256, extFromMime(video.mime ?? 'video/mp4'), extraServers),
    [video, extraServers],
  )
}

export function ResilientVideo({
  clip,
  extraServers,
  active,
  muted,
  load,
  fit = 'contain',
  onSource,
  onTap,
  className = '',
}: {
  clip: Clip
  extraServers: string[]
  /** Doit jouer maintenant. */
  active: boolean
  muted: boolean
  /** Autorise le chargement (sinon seule la vignette est affichée). */
  load: boolean
  fit?: 'contain' | 'cover'
  onSource?: (state: SourceState) => void
  onTap?: () => void
  className?: string
}) {
  const candidates = useCandidates(clip, extraServers)
  const videoRef = useRef<HTMLVideoElement>(null)
  const posterRef = useRef<HTMLImageElement>(null)
  const [index, setIndex] = useState(0)
  const [failed, setFailed] = useState(false)
  const [started, setStarted] = useState(false)
  const resumeAt = useRef(0)
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Nouvelle liste de candidats (ex. v2 avec fallback reçue) : on garde la source courante si possible.
  const src = load && !failed ? (candidates[index] ?? null) : null

  useEffect(() => {
    onSource?.({ url: src, index, total: candidates.length, failed })
  }, [src, index, candidates.length, failed, onSource])

  // Élément vidéo démonté (carte hors écran) : on réaffiche la vignette.
  useEffect(() => {
    if (!src) setStarted(false)
  }, [src])

  const clearStall = () => {
    if (stallTimer.current) clearTimeout(stallTimer.current)
    stallTimer.current = null
  }

  const next = useCallback(() => {
    clearStall()
    const v = videoRef.current
    if (v && Number.isFinite(v.currentTime) && v.currentTime > 0) resumeAt.current = v.currentTime
    setIndex((i) => {
      if (i + 1 >= candidates.length) {
        setFailed(true)
        return i
      }
      return i + 1
    })
  }, [candidates.length])

  const armStall = useCallback(() => {
    clearStall()
    stallTimer.current = setTimeout(next, STALL_MS)
  }, [next])

  // Chargement / lecture
  useEffect(() => {
    const v = videoRef.current
    if (!v || !src) return
    if (active) {
      armStall()
      v.play().catch(() => {
        /* lecture refusée (autoplay) : l'utilisateur peut toucher pour lancer */
      })
    } else {
      clearStall()
      v.pause()
    }
    return clearStall
  }, [active, src, armStall])

  useEffect(() => {
    if (videoRef.current) videoRef.current.muted = muted
  }, [muted])

  // Vignette : bascule de serveur gérée par blossom-client-sdk
  useEffect(() => {
    const img = posterRef.current
    if (!img) return
    return handleMediaFallbacks(img, async () => extraServers, clip.pubkey)
  }, [clip.pubkey, extraServers])

  const onLoadedMetadata = () => {
    const v = videoRef.current
    if (v && resumeAt.current > 0) {
      v.currentTime = resumeAt.current
      resumeAt.current = 0
    }
  }

  const onTimeUpdate = () => {
    const v = videoRef.current
    // Le format est de 60 s : on ne lit pas au-delà, quoi que contienne le fichier.
    if (v && v.currentTime > MAX_DECLARED_DURATION_S) v.currentTime = 0
  }

  const poster = clip.video.images[0]
  const objectFit = fit === 'cover' ? 'object-cover' : 'object-contain'

  return (
    <div className={`relative h-full w-full overflow-hidden bg-black ${className}`} onClick={onTap}>
      {poster && !started && (
        <img
          ref={posterRef}
          src={poster}
          alt=""
          decoding="async"
          loading="lazy"
          referrerPolicy="no-referrer"
          className={`absolute inset-0 h-full w-full ${objectFit}`}
        />
      )}
      {src && (
        <video
          ref={videoRef}
          key={clip.key}
          src={src}
          muted={muted}
          playsInline
          loop
          preload={active ? 'auto' : 'metadata'}
          aria-label={clip.alt || clip.title || 'Vidéo'}
          className={`absolute inset-0 h-full w-full ${objectFit} ${started ? 'opacity-100' : 'opacity-0'}`}
          onError={next}
          onLoadStart={() => active && armStall()}
          onLoadedMetadata={onLoadedMetadata}
          onLoadedData={clearStall}
          onPlaying={() => {
            clearStall()
            setStarted(true)
          }}
          onWaiting={() => active && armStall()}
          onTimeUpdate={onTimeUpdate}
          data-source-host={hostOf(src)}
        />
      )}
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-6 text-center text-sm text-muted">
          <span className="text-white">Vidéo introuvable sur les {candidates.length} serveurs connus.</span>
          <button
            className="rounded-lg border border-line px-3 py-1.5 text-accent"
            onClick={(e) => {
              e.stopPropagation()
              setFailed(false)
              setIndex(0)
            }}
          >
            Réessayer
          </button>
        </div>
      )}
    </div>
  )
}
