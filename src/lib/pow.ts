/**
 * Preuve de travail NIP-13 pour les signalements : rend coûteuse la fabrication en masse de
 * signalements par des clés jetables (voir moderation/policy.ts).
 */
import { minePow } from 'nostr-tools/nip13'
import type { EventTemplate } from 'nostr-tools/pure'

/** Ajoute le tag `nonce` (et met à jour created_at) pour atteindre `bits` ; dans un worker si possible. */
export async function withProofOfWork(template: EventTemplate, pubkey: string, bits: number): Promise<EventTemplate> {
  const unsigned = { ...template, pubkey, tags: template.tags.map((t) => [...t]) }
  let result: { created_at: number; tags: string[][] }
  try {
    const worker = new Worker(new URL('./pow.worker.ts', import.meta.url), { type: 'module' })
    result = await new Promise((resolve, reject) => {
      worker.onmessage = (e) => resolve(e.data)
      worker.onerror = (e) => reject(e)
      worker.postMessage({ event: unsigned, bits })
    }).finally(() => worker.terminate()) as { created_at: number; tags: string[][] }
  } catch {
    // Pas de worker (environnement restreint) : minage sur le fil principal.
    const mined = minePow(unsigned, bits)
    result = { created_at: mined.created_at, tags: mined.tags }
  }
  return { ...template, created_at: result.created_at, tags: result.tags }
}
