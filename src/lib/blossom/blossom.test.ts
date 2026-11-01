import { generateSecretKey, verifyEvent } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { localSigner } from '../nostr/signer'
import { authHeader, createAuthToken } from './client'
import { blobUrl, blossomUri, candidateUrls, ensureExtension, extFromMime, getHashFromURL, normalizeServer } from './urls'

const SHA = 'b1674191a88ec5cdd733e4240a81803105dc412d6c6708d53ab94fc248f4f553'

describe('jeton BUD-11 (kind 24242)', () => {
  const signer = localSigner(generateSecretKey())

  it('contient t, x, expiration (+1 h) et server, et est signé', async () => {
    const token = await createAuthToken(signer, 'upload', {
      sha256: SHA,
      servers: ['https://blossom.nostr.build', 'https://blosstr.com/'],
    })
    expect(token.kind).toBe(24242)
    expect(verifyEvent(token)).toBe(true)
    expect(token.tags).toContainEqual(['t', 'upload'])
    expect(token.tags).toContainEqual(['x', SHA])
    expect(token.tags).toContainEqual(['server', 'blossom.nostr.build'])
    expect(token.tags).toContainEqual(['server', 'blosstr.com'])
    const exp = Number(token.tags.find((t) => t[0] === 'expiration')![1])
    expect(exp - token.created_at).toBeGreaterThan(3500)
    expect(exp - token.created_at).toBeLessThanOrEqual(3601)
    expect(token.content).toBe('Uploading 60s video clip')
  })

  it('en-tête Authorization: Nostr <base64url sans remplissage>', async () => {
    const token = await createAuthToken(signer, 'delete', { sha256: SHA })
    const header = authHeader(token)
    expect(header.startsWith('Nostr ')).toBe(true)
    const b64 = header.slice(6)
    expect(b64).toMatch(/^[A-Za-z0-9_-]+$/)
    const json = Buffer.from(b64, 'base64url').toString('utf8')
    expect(JSON.parse(json).id).toBe(token.id)
  })
})

describe('URLs Blossom', () => {
  it('extensions depuis le type MIME (avec codecs)', () => {
    expect(extFromMime('video/mp4;codecs="avc1.42E01F,mp4a.40.2"')).toBe('mp4')
    expect(extFromMime('video/webm;codecs=vp8,opus')).toBe('webm')
    expect(extFromMime('image/jpeg')).toBe('jpg')
  })

  it('ajoute l’extension aux chemins /<sha256> nus (pipelines de modération)', () => {
    expect(ensureExtension(`https://cdn.example.com/${SHA}`, 'video/mp4')).toBe(`https://cdn.example.com/${SHA}.mp4`)
    expect(ensureExtension(`https://cdn.example.com/${SHA}.webm`, 'video/mp4')).toBe(`https://cdn.example.com/${SHA}.webm`)
    expect(ensureExtension(`https://cdn.example.com/media/x.mp4`, 'video/mp4')).toBe('https://cdn.example.com/media/x.mp4')
  })

  it('extrait le dernier hash (BUD-03)', () => {
    expect(getHashFromURL(`https://cdn.example.com/${'a'.repeat(64)}/media/${SHA}.pdf`)).toBe(SHA)
  })

  it('normalise les serveurs et refuse http distant', () => {
    expect(normalizeServer('https://blossom.nostr.build/')).toBe('https://blossom.nostr.build')
    expect(normalizeServer('http://evil.example')).toBeNull()
    expect(normalizeServer('http://127.0.0.1:3001')).toBe('http://127.0.0.1:3001')
  })

  it('construit la liste de candidats : déclarés puis reconstruits par hash, sans doublon d’hôte', () => {
    const urls = candidateUrls(
      [`https://a.example/${SHA}.mp4`, `https://b.example/${SHA}.mp4`, 'javascript:alert(1)'],
      SHA,
      'mp4',
      ['https://b.example', 'https://c.example/', 'http://evil.example'],
    )
    expect(urls).toEqual([`https://a.example/${SHA}.mp4`, `https://b.example/${SHA}.mp4`, blobUrl('https://c.example', SHA, 'mp4')])
  })

  it('URI de résilience BUD-10', () => {
    expect(blossomUri(SHA, 'mp4', ['https://a.example/'], 'f'.repeat(64))).toBe(
      `blossom:${SHA}.mp4?xs=https%3A%2F%2Fa.example&as=${'f'.repeat(64)}`,
    )
  })
})
