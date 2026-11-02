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
import { visitSeed } from '../lib/nostr/pool'
import type { Clip } from '../lib/nostr/events'

const STALL_MS = 7000

export interface SourceState {
  url: string | null
  index: number
  total: number
  failed: boolean
}

/**
 * Montée en charge : chaque visiteur commence par une copie DIFFÉRENTE parmi celles déclarées par
 * l'auteur (rotation selon une graine propre à la visite). 10 000 spectateurs se répartissent ainsi
 * sur tous les serveurs qui détiennent la vidéo au lieu de saturer le premier. La bascule automatique
 * reste la même si la copie choisie ne répond pas.
 */
export function spreadSources(declared: string[], seed: number): string[] {
  if (declared.length < 2) return declared
  const k = seed % declared.length
  return [...declared.slice(k), ...declared.slice(0, k)]
}

/** Tests de bout en bout : ordre déclaré conservé (scénarios de censure écrits pour le serveur principal). */
const spreadEnabled = (): boolean => {
  if (import.meta.env.MODE !== 'e2e') return true
  try {
    return localStorage.getItem('hw:e2e:spread') === '1'
  } catch {
    return false
  }
}

export function useCandidates(clip: Clip, extraServers: string[]): string[] {
  const { video } = clip
  return useMemo(() => {
    const declared = [video.url, ...video.fallbacks]
    const ordered = spreadEnabled() ? spreadSources(declared, visitSeed()) : declared
    return candidateUrls(ordered, video.sha256, extFromMime(video.mime ?? 'video/mp4'), extraServers)
  }, [video, extraServers])
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
  /** Lecture automatique refusée par le navigateur (iOS en mode économie d'énergie, politique d'autoplay). */
  const [needsTap, setNeedsTap] = useState(false)
  const resumeAt = useRef(0)
  const stallTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Une tentative de lecture est en cours : seul cas où l'absence de données signale un blocage serveur. */
  const playPending = useRef(false)
  /** Identifiant de tentative : la promesse d'une tentative abandonnée ne doit pas modifier la suivante. */
  const attemptId = useRef(0)

  // Nouvelle liste de candidats (ex. v2 avec fallback reçue) : on garde la source courante si possible.
  const src = load && !failed ? (candidates[index] ?? null) : null

  /**
   * La liste des candidats change en cours de route (v2 avec fallback, copie annoncée par un
   * spectateur, liste de serveurs de l'auteur) et une nouvelle source peut s'insérer AVANT celles
   * déjà essayées : on raisonne donc sur les URL essayées, pas sur des positions.
   */
  const tried = useRef(new Set<string>())
  const current = useRef<string | null>(null)
  const candidatesRef = useRef(candidates)
  useEffect(() => {
    if (src) {
      tried.current.add(src)
      current.current = src
    }
  }, [src])
  useEffect(() => {
    candidatesRef.current = candidates
    if (failed) {
      // Tout avait échoué : on reprend sur la première source jamais essayée.
      const i = candidates.findIndex((u) => !tried.current.has(u))
      if (i >= 0) {
        setIndex(i)
        setFailed(false)
      }
    } else if (current.current) {
      // On garde la source en cours de lecture même si sa position a changé.
      const i = candidates.indexOf(current.current)
      if (i >= 0) setIndex(i)
    }
  }, [candidates, failed])

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
    const list = candidatesRef.current
    const i = list.findIndex((u) => !tried.current.has(u))
    if (i < 0) setFailed(true)
    else setIndex(i)
  }, [])

  const armStall = useCallback(() => {
    clearStall()
    stallTimer.current = setTimeout(() => {
      // Ne jamais accuser le serveur d'une pause voulue ou d'un autoplay refusé.
      const v = videoRef.current
      if (v && v.paused && !playPending.current) return
      next()
    }, STALL_MS)
  }, [next])

  /**
   * Lance la lecture. Un refus `NotAllowedError` n'est PAS une panne de serveur : c'est le navigateur
   * qui interdit l'autoplay (iOS en mode économie d'énergie, réglages Safari, onglet en arrière-plan).
   * On affiche alors un bouton « Lire » au lieu de basculer sur un miroir.
   */
  const attemptPlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    const id = ++attemptId.current
    playPending.current = true
    armStall()
    const promise = v.play()
    if (!promise) return
    promise.then(
      () => {
        if (id !== attemptId.current) return
        playPending.current = false
        clearStall()
        setNeedsTap(false)
      },
      (err: unknown) => {
        if (id !== attemptId.current) return
        playPending.current = false
        const name = err instanceof DOMException ? err.name : ''
        if (name === 'NotAllowedError') {
          clearStall()
          setNeedsTap(true)
        }
        // AbortError : lecture interrompue par un changement de source ou une pause, sans gravité.
        // NotSupportedError : l'événement `error` de l'élément déclenche déjà la bascule.
      },
    )
  }, [armStall])

  // Chargement / lecture
  useEffect(() => {
    const v = videoRef.current
    if (!v || !src) return
    if (active) attemptPlay()
    else {
      attemptId.current++
      playPending.current = false
      clearStall()
      v.pause()
    }
    return clearStall
  }, [active, src, attemptPlay])

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
          onLoadStart={() => active && playPending.current && armStall()}
          onLoadedMetadata={onLoadedMetadata}
          onLoadedData={clearStall}
          onPlaying={() => {
            clearStall()
            setStarted(true)
            setNeedsTap(false)
          }}
          onWaiting={() => {
            if (active && !videoRef.current?.paused) armStall()
          }}
          onTimeUpdate={onTimeUpdate}
          data-source-host={hostOf(src)}
        />
      )}
      {needsTap && src && !failed && (
        <button
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/30 text-white"
          onClick={(e) => {
            e.stopPropagation()
            setNeedsTap(false)
            attemptPlay()
          }}
          aria-label="Lire la vidéo"
          data-testid="tap-to-play"
        >
          <span className="flex h-20 w-20 items-center justify-center rounded-full bg-black/55 backdrop-blur">
            <svg viewBox="0 0 24 24" width="36" height="36" fill="currentColor" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
          <span className="rounded-full bg-black/55 px-3 py-1 text-xs">Lecture automatique bloquée par le navigateur — touchez pour lire</span>
        </button>
      )}
      {failed && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/70 p-6 text-center text-sm text-muted">
          <span className="text-white">Vidéo introuvable sur les {candidates.length} serveurs connus.</span>
          <button
            className="rounded-lg border border-line px-3 py-1.5 text-accent"
            onClick={(e) => {
              e.stopPropagation()
              tried.current.clear()
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
