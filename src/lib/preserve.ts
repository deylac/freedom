/**
 * Réplication par les spectateurs (docs/RESILIENCE.md, R1).
 *
 * Un spectateur demande à d'autres serveurs Blossom de COPIER la vidéo de serveur à serveur
 * (PUT /mirror) : aucun octet ne transite par son téléphone. Les copies sont annoncées sur Nostr
 * (NIP-94, kind 1063) ; tous les lecteurs les ajoutent à leurs sources de secours. Plus une vidéo
 * est regardée, plus elle existe en exemplaires : la supprimer d'un serveur ne suffit plus.
 *
 * Vie privée : jetons et annonce sont signés par une clé JETABLE, jamais par l'identité du
 * spectateur (sinon on relierait ce qu'il regarde à ce qu'il publie).
 */
import { generateSecretKey } from 'nostr-tools/pure'
import { createAuthToken, mirrorBlob } from './blossom/client'
import { hostOf, normalizeServer } from './blossom/urls'
import { extFromMime } from './blossom/urls'
import { KIND_FILE_METADATA, nowSeconds, type Clip } from './nostr/events'
import { publishEvent } from './nostr/pool'
import { localSigner } from './nostr/signer'
import { readJSON, writeJSON } from './storage/local'
import { getSettings } from './storage/settings'

export interface PreserveResult {
  copies: string[]
  failed: { server: string; reason: string }[]
}

const PRESERVED_KEY = 'preserved'

export const alreadyPreserved = (sha256: string): boolean => readJSON<string[]>(PRESERVED_KEY, []).includes(sha256)

function markPreserved(sha256: string) {
  writeJSON(PRESERVED_KEY, [sha256, ...readJSON<string[]>(PRESERVED_KEY, []).filter((s) => s !== sha256)].slice(0, 500))
}

/**
 * @param sources URLs connues pour fonctionner (la source en lecture d'abord).
 * @param holders Serveurs (origines) qui détiennent déjà le fichier.
 * @param candidates Serveurs où tenter une copie.
 */
export async function preserveClip(
  clip: Clip,
  sources: string[],
  holders: string[],
  candidates: string[],
  max = 3,
): Promise<PreserveResult> {
  const sha256 = clip.video.sha256
  if (!sha256 || sources.length === 0) return { copies: [], failed: [] }
  const held = new Set(holders.map((h) => normalizeServer(h)).filter(Boolean))
  const targets = [...new Set(candidates.map((c) => normalizeServer(c)).filter((c): c is string => !!c && !held.has(c)))].slice(0, max + 2)
  if (targets.length === 0) return { copies: [], failed: [] }

  const signer = localSigner(generateSecretKey())
  const token = await createAuthToken(signer, 'upload', { sha256, servers: targets, message: 'Preserve video copy' })
  const mime = clip.video.mime ?? 'video/mp4'
  const results = await Promise.allSettled(
    targets.map((server) => mirrorBlob(server, sources[0], { sha256, type: mime, size: clip.video.size ?? 0, token, timeoutMs: 120_000 })),
  )
  const copies: string[] = []
  const failed: PreserveResult['failed'] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') copies.push(r.value.url)
    else failed.push({ server: hostOf(targets[i]), reason: r.reason instanceof Error ? r.reason.message : String(r.reason) })
  })
  markPreserved(sha256)

  if (copies.length > 0) {
    // NIP-94 : métadonnées de fichier, pour que les lecteurs trouvent ces copies par l'empreinte.
    const event = await signer.sign({
      kind: KIND_FILE_METADATA,
      created_at: nowSeconds(),
      content: '',
      tags: [
        ['url', copies[0]],
        ...copies.slice(1).map((u) => ['fallback', u]),
        ['x', sha256],
        ['ox', sha256],
        ['m', mime],
        ['alt', `Copie de préservation (${extFromMime(mime)})`],
      ],
    })
    await publishEvent(getSettings().relays, event, signer).first.catch(() => {})
  }
  return { copies, failed }
}

/** Sources, détenteurs et cibles d'une préservation pour un clip. */
export function preservationPlan(clip: Clip, copyServers: string[], knownServers: string[], playing?: string | null) {
  const declared = [clip.video.url, ...clip.video.fallbacks]
  const sources = [...new Set([...(playing ? [playing] : []), ...declared])]
  const holders = [...declared.map((u) => new URL(u).origin), ...copyServers]
  const candidates = [...getSettings().blossomServers, ...knownServers]
  return { sources, holders, candidates }
}

// ---------------------------------------------------------------------------
// Préservation automatique (réglage, activée par défaut)

let lastAuto = 0
let todayCount = 0
let today = ''

/** Limites : une préservation toutes les 20 s, 50 par jour, jamais deux fois la même vidéo. */
export function mayAutoPreserve(sha256: string | undefined, now = Date.now()): boolean {
  if (!sha256 || !getSettings().autoPreserve || alreadyPreserved(sha256)) return false
  const day = new Date(now).toISOString().slice(0, 10)
  if (day !== today) {
    today = day
    todayCount = 0
  }
  if (now - lastAuto < 20_000 || todayCount >= 50) return false
  lastAuto = now
  todayCount++
  return true
}
