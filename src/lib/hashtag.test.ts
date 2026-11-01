import { describe, expect, it } from 'vitest'
import { normalizeTag, parseHash, routeToHash, wallUrl } from './hashtag'

describe('normalizeTag (FR-01)', () => {
  it('met en minuscules et retire le # initial', () => {
    expect(normalizeTag('#14Octobre')).toBe('14octobre')
    expect(normalizeTag('##14OCTOBRE')).toBe('14octobre')
  })
  it('retire les espaces et caractères spéciaux', () => {
    expect(normalizeTag(' 14 octobre ! ')).toBe('14octobre')
    expect(normalizeTag('<script>alert(1)</script>')).toBe('scriptalert1script')
  })
  it('conserve les lettres accentuées et décode les fragments percent-encodés', () => {
    expect(normalizeTag('%C3%89t%C3%A9')).toBe('été')
    expect(normalizeTag('Été2026')).toBe('été2026')
  })
  it('normalise en NFC (é composé ≡ e + accent combinant)', () => {
    expect(normalizeTag('été')).toBe('été')
  })
  it('tolère un percent-encoding invalide', () => {
    expect(normalizeTag('%E0%A4%A')).toBe('e0a4a')
  })
  it('borne la longueur', () => {
    expect(normalizeTag('a'.repeat(200))).toHaveLength(64)
  })
})

describe('parseHash', () => {
  it('retourne la page d’accueil si vide', () => {
    expect(parseHash('')).toEqual({ view: 'home' })
    expect(parseHash('#')).toEqual({ view: 'home' })
    expect(parseHash('#!!!')).toEqual({ view: 'home' })
  })
  it('extrait le mur', () => {
    expect(parseHash('#14Octobre')).toEqual({ view: 'wall', tag: '14octobre' })
    expect(parseHash('#/14octobre')).toEqual({ view: 'wall', tag: '14octobre' })
  })
  it('extrait un pointeur de clip valide uniquement', () => {
    expect(parseHash('#14octobre/naddr1qqxnzd3cxqmrzv3exgmr2wfeqgsgydql3q4ka27d9wnlrmus4tvkrnc8ftc4h8h5fgyln54gl0a7dgsrqsqqqa28pccpzu')).toMatchObject({
      view: 'wall',
      tag: '14octobre',
    })
    expect(parseHash('#14octobre/javascript:alert(1)')).toEqual({ view: 'wall', tag: '14octobre' })
  })
  it('aller-retour', () => {
    expect(parseHash(routeToHash({ view: 'wall', tag: 'été' }))).toEqual({ view: 'wall', tag: 'été' })
  })
})

describe('wallUrl', () => {
  it('construit une URL ASCII valable sur miroir / IPFS', () => {
    expect(wallUrl('été', undefined, { origin: 'https://dweb.link', pathname: '/ipfs/bafy/' })).toBe(
      'https://dweb.link/ipfs/bafy/#%C3%A9t%C3%A9',
    )
  })
})
