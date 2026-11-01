import { describe, expect, it } from 'vitest'
import { DEFAULT_BLOSSOM_SERVERS, DEFAULT_RELAYS, LEGACY_DEFAULT_BLOSSOM_SERVERS, LEGACY_DEFAULT_RELAYS } from '../../config'
import { DEFAULT_SETTINGS, loadOverrides } from './settings'

describe('loadOverrides', () => {
  it('oublie une ancienne liste par défaut enregistrée (elle n’était pas un choix)', () => {
    const o = loadOverrides({ ...DEFAULT_SETTINGS, blossomServers: LEGACY_DEFAULT_BLOSSOM_SERVERS[0], termsAcceptedVersion: 1 })
    expect(o.blossomServers).toBeUndefined()
    expect({ ...DEFAULT_SETTINGS, ...o }.blossomServers).toEqual(DEFAULT_BLOSSOM_SERVERS)
    expect(o.termsAcceptedVersion).toBe(1)
  })
  it('toutes les anciennes listes (serveurs et relais) cèdent la place aux nouvelles', () => {
    for (const legacy of LEGACY_DEFAULT_BLOSSOM_SERVERS) expect(loadOverrides({ blossomServers: legacy }).blossomServers).toBeUndefined()
    for (const legacy of LEGACY_DEFAULT_RELAYS) expect(loadOverrides({ relays: legacy }).relays).toBeUndefined()
    expect(DEFAULT_RELAYS.length).toBeGreaterThanOrEqual(12)
  })
  it('conserve une liste réellement personnalisée', () => {
    expect(loadOverrides({ blossomServers: ['https://mon-serveur.example'] }).blossomServers).toEqual(['https://mon-serveur.example'])
  })
  it('n’enregistre que les écarts aux valeurs par défaut', () => {
    expect(loadOverrides({ ...DEFAULT_SETTINGS, autoPublish: false })).toEqual({ autoPublish: false })
  })
})
