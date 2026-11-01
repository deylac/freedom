import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { describe, expect, it } from 'vitest'
import { buildMirrorListEvent, isValidMirror, parseMirrorList } from './mirrors'

describe('adresses de secours', () => {
  const project = generateSecretKey()
  const pk = getPublicKey(project)

  it('accepte https et .onion, refuse le reste', () => {
    expect(isValidMirror('https://miroir.example/hashwall/')).toBe(true)
    expect(isValidMirror('http://abcdefghijklmnop.onion/')).toBe(true)
    expect(isValidMirror('http://miroir.example/')).toBe(false)
    expect(isValidMirror('javascript:alert(1)')).toBe(false)
    expect(isValidMirror('https://user:pass@miroir.example/')).toBe(false)
  })

  it('liste signée par la clé du projet : lue ; par une autre clé : ignorée', () => {
    const template = buildMirrorListEvent([
      { url: 'https://a.example', label: 'Europe' },
      { url: 'http://x.example' },
      { url: 'http://abcd.onion' },
    ])
    const signed = finalizeEvent(template, project)
    expect(parseMirrorList(signed, pk)).toEqual([
      { url: 'https://a.example/', label: 'Europe' },
      { url: 'http://abcd.onion/', label: undefined },
    ])
    const forged = finalizeEvent(template, generateSecretKey())
    expect(parseMirrorList(forged, pk)).toBeNull()
  })
})
