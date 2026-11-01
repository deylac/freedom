/** Minage NIP-13 hors du fil principal (≈ 1 million de hachages pour 20 bits). */
import { minePow } from 'nostr-tools/nip13'
import type { UnsignedEvent } from 'nostr-tools/pure'

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<{ event: UnsignedEvent; bits: number }>) => void) | null
  postMessage(m: unknown): void
}

scope.onmessage = (e) => {
  const mined = minePow(e.data.event, e.data.bits)
  scope.postMessage({ created_at: mined.created_at, tags: mined.tags })
}
