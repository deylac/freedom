/**
 * FR-07 — Modération décentralisée côté client (couches 2 et 3 du PRD).
 *
 * Couche 2 : signalements NIP-56 comptés par clés publiques DISTINCTES.
 *   Angle mort : les clés sont gratuites, un seul acteur peut produire N signalements
 *   (attaque Sybil) et flouter n'importe quelle vidéo. Le floutage reste donc réversible
 *   (« Afficher quand même »), jamais une suppression, et les signalements de modérateurs
 *   de confiance comptent seuls.
 * Couche 3 : listes de masquage kind 10000 (NIP-51) publiées par des collectifs de confiance.
 */
import type { NostrEvent } from 'nostr-tools/pure'
import type { Clip, ReportReason } from '../nostr/events'

export interface MuteList {
  pubkeys: Set<string>
  hashtags: Set<string>
  words: string[]
  events: Set<string>
}

export const emptyMuteList = (): MuteList => ({ pubkeys: new Set(), hashtags: new Set(), words: [], events: new Set() })

/** Lit les entrées publiques d'une liste kind 10000 (les entrées chiffrées restent privées à leur auteur). */
export function parseMuteList(event: NostrEvent): MuteList {
  const list = emptyMuteList()
  for (const [name, value] of event.tags) {
    if (!value) continue
    if (name === 'p' && /^[0-9a-f]{64}$/.test(value)) list.pubkeys.add(value)
    else if (name === 't') list.hashtags.add(value.toLowerCase())
    else if (name === 'word') list.words.push(value.toLowerCase())
    else if (name === 'e' && /^[0-9a-f]{64}$/.test(value)) list.events.add(value)
  }
  return list
}

export function mergeMuteLists(lists: MuteList[]): MuteList {
  const out = emptyMuteList()
  for (const l of lists) {
    l.pubkeys.forEach((p) => out.pubkeys.add(p))
    l.hashtags.forEach((t) => out.hashtags.add(t))
    l.events.forEach((e) => out.events.add(e))
    out.words.push(...l.words)
  }
  return out
}

export interface ModerationContext {
  /** Tag du mur courant : un modérateur qui masque ce tag ne vide pas le mur entier. */
  wallTag: string
  mutes: MuteList
  /** Clips masqués localement (signalés par moi, « ne plus voir »). */
  hiddenKeys: Set<string>
  moderators: Set<string>
  /** Clés suivies par un modérateur (Web of Trust de profondeur 1, kind 3). */
  trusted: Set<string>
  /** Preuve de travail minimale (bits NIP-13) d'un signalement venant d'une clé inconnue. */
  powBits: number
  threshold: number
}

/** Un signalement : motif et preuve de travail (bits de tête nuls de l'id). */
export interface ReportInfo {
  reason: ReportReason
  pow: number
}

export type Verdict =
  | { status: 'hidden'; reason: string }
  | { status: 'warn'; reasons: string[]; reports: number; unverified: number }
  | { status: 'visible'; unverified: number }

/**
 * reporters : clé publique → signalement, pour toutes les cibles (x, e, a) du clip.
 *
 * Seuls les signalements VÉRIFIÉS comptent pour le seuil : modérateur, clé suivie par un modérateur,
 * ou preuve de travail ≥ powBits. Sans cela, créer N clés gratuites suffirait à flouter n'importe
 * quelle vidéo (attaque Sybil). Les autres restent comptés à titre indicatif.
 */
export function evaluateClip(clip: Clip, reporters: Map<string, ReportInfo>, ctx: ModerationContext): Verdict {
  if (ctx.hiddenKeys.has(clip.key)) return { status: 'hidden', reason: 'Masqué par vous' }
  if (ctx.mutes.pubkeys.has(clip.pubkey)) return { status: 'hidden', reason: 'Auteur masqué' }
  if (ctx.mutes.events.has(clip.id)) return { status: 'hidden', reason: 'Vidéo masquée par une liste de modération' }
  if (clip.hashtags.some((t) => t !== ctx.wallTag && ctx.mutes.hashtags.has(t))) {
    return { status: 'hidden', reason: 'Hashtag masqué' }
  }
  const text = `${clip.title}\n${clip.content}`.toLowerCase()
  if (ctx.mutes.words.some((w) => w && text.includes(w))) return { status: 'hidden', reason: 'Mot masqué' }

  let count = 0
  let unverified = 0
  let byModerator = false
  const reasons = new Set<string>()
  for (const [reporter, info] of reporters) {
    // Un auteur ne compte pas contre lui-même ; les clés masquées ne comptent pas.
    if (reporter === clip.pubkey || ctx.mutes.pubkeys.has(reporter)) continue
    const moderator = ctx.moderators.has(reporter)
    if (!moderator && !ctx.trusted.has(reporter) && info.pow < ctx.powBits) {
      unverified++
      continue
    }
    count++
    reasons.add(REASON_LABELS[info.reason] ?? REASON_LABELS.other)
    if (moderator) byModerator = true
  }

  const warnings: string[] = []
  if (clip.contentWarning !== undefined) warnings.push(clip.contentWarning || 'Contenu sensible')
  if (byModerator || count >= Math.max(1, ctx.threshold)) {
    warnings.push(`Signalée ${count} fois${byModerator ? ' (dont un modérateur)' : ''} : ${[...reasons].join(', ')}`)
  }
  return warnings.length > 0 ? { status: 'warn', reasons: warnings, reports: count, unverified } : { status: 'visible', unverified }
}

export const REASON_LABELS: Record<ReportReason, string> = {
  illegal: 'contenu illégal',
  spam: 'spam',
  nudity: 'nudité',
  profanity: 'haine / appel à la violence',
  other: 'autre',
}

const VALID_REASONS = new Set<string>(Object.keys(REASON_LABELS))

/** Extrait les cibles d'un signalement kind 1984 : `x:<sha>`, `e:<id>`, `a:<adresse>`. */
export function reportTargets(event: NostrEvent): { targets: string[]; reason: ReportReason } {
  const targets: string[] = []
  let reason: ReportReason = 'other'
  for (const t of event.tags) {
    if ((t[0] === 'x' || t[0] === 'e' || t[0] === 'a') && t[1]) {
      targets.push(`${t[0]}:${t[1]}`)
      if (t[2] && VALID_REASONS.has(t[2])) reason = t[2] as ReportReason
    }
  }
  return { targets, reason }
}
