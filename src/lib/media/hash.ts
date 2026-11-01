import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex } from '@noble/hashes/utils.js'

/**
 * SHA-256 hexadécimal d'un Blob. Web Crypto (rapide, natif) quand le contexte est sécurisé,
 * repli @noble/hashes sinon (http sur réseau local, vieux navigateurs).
 */
export async function sha256Hex(data: Blob | ArrayBuffer | Uint8Array): Promise<string> {
  const buffer =
    data instanceof Blob ? await data.arrayBuffer() : data instanceof Uint8Array ? data : new Uint8Array(data)
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    try {
      const digest = await subtle.digest('SHA-256', buffer as BufferSource)
      return bytesToHex(new Uint8Array(digest))
    } catch {
      /* repli ci-dessous */
    }
  }
  return bytesToHex(sha256(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)))
}
