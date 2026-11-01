import { describe, expect, it } from 'vitest'
import { finalizeEvent, generateSecretKey } from 'nostr-tools/pure'
import { checkBundle, createBundle, decodeBundle, encodeBundle, type BundlePayload } from './bundle'
import { sha256Hex } from './media/hash'
import { localSigner } from './nostr/signer'
import type { OutboxJob } from './storage/outbox'

const SERVERS = ['https://a.example', 'https://b.example']

async function makeJob(bytes = new Uint8Array(4096).map((_, i) => (i * 7) % 251)) {
  const videoBlob = new Blob([bytes], { type: 'video/mp4' })
  const sha256 = await sha256Hex(videoBlob)
  const sk = generateSecretKey()
  const job = {
    id: sha256,
    createdAt: Date.now(),
    tag: 'secours',
    caption: 'sans réseau',
    video: { sha256, mime: 'video/mp4', ext: 'mp4', size: bytes.length, duration: 5, width: 720, height: 1280, bitrate: 1e6 },
    videoBlob,
    signer: { type: 'local', sk: '', pubkey: '' },
    state: 'pending',
    servers: [],
    mirrors: [],
    posterMirrors: [],
    attempts: 0,
    timings: { recordedAt: Date.now() - 60_000 },
  } as unknown as OutboxJob
  return { job, signer: localSigner(sk), sk, sha256, videoBlob }
}

describe('paquets hors ligne', () => {
  it('reste une vidéo : la boîte est ajoutée à la fin et se retire à l’octet près', async () => {
    const { job, signer, sha256 } = await makeJob()
    const file = await createBundle(job, signer, SERVERS)
    expect(file.type).toBe('video/mp4')
    expect(file.name).toMatch(/^hashwall-secours-[0-9a-f]{8}\.mp4$/)
    const decoded = await decodeBundle(file)
    expect(decoded).not.toBeNull()
    expect(await sha256Hex(decoded!.video)).toBe(sha256)
    // Boîte MP4 valide : taille sur 4 octets puis « uuid ».
    const bytes = new Uint8Array(await file.arrayBuffer())
    const at = job.video.size
    expect(new TextDecoder().decode(bytes.subarray(at + 4, at + 8))).toBe('uuid')
    expect(((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0).toBe(bytes.length - at)
  })

  it('un porteur peut vérifier le paquet hors ligne', async () => {
    const { job, signer } = await makeJob()
    const check = await checkBundle(await createBundle(job, signer, SERVERS))
    expect(check.clip.hashtags).toContain('secours')
    expect(check.clip.pubkey).toBe(signer.pubkey)
    expect(check.payload.servers).toEqual(SERVERS)
    expect(check.expiresAt).toBeGreaterThan(Date.now() / 1000 + 6 * 86400)
    expect(check.clip.video.url).toBe(`https://a.example/${job.video.sha256}.mp4`)
    expect(check.clip.video.fallbacks).toEqual([`https://b.example/${job.video.sha256}.mp4`])
  })

  it('refuse une vidéo modifiée, un texte modifié, une autorisation expirée ou étrangère', async () => {
    const { job, signer, sk } = await makeJob()
    const file = await createBundle(job, signer, SERVERS)
    const decoded = (await decodeBundle(file))!

    const tamperedVideo = new Uint8Array(await decoded.video.arrayBuffer())
    tamperedVideo[100] ^= 1
    await expect(checkBundle(encodeBundle(new Blob([tamperedVideo]), decoded.payload))).rejects.toThrow(/empreinte/)

    const edited: BundlePayload = { ...decoded.payload, event: { ...decoded.payload.event, content: 'texte changé' } }
    await expect(checkBundle(encodeBundle(decoded.video, edited))).rejects.toThrow(/Signature/)

    await expect(checkBundle(file, Math.floor(Date.now() / 1000) + 8 * 86400)).rejects.toThrow(/expirée/)

    // Jeton signé par quelqu'un d'autre que l'auteur.
    const foreign = finalizeEvent({ ...decoded.payload.token, pubkey: undefined } as never, generateSecretKey())
    await expect(checkBundle(encodeBundle(decoded.video, { ...decoded.payload, token: foreign }))).rejects.toThrow(/Autorisation/)
    expect(sk.length).toBe(32)
  })

  it('ignore un fichier ordinaire ou recompressé', async () => {
    expect(await decodeBundle(new Blob([new Uint8Array(1000)]))).toBeNull()
    await expect(checkBundle(new Blob([new Uint8Array(1000)]))).rejects.toThrow(/pas un paquet/)
  })
})
