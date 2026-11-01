import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OutboxJob } from './outbox'

/** Nouvelle instance du module : équivaut à recharger la page (la mémoire est perdue, la base reste). */
const fresh = async () => {
  vi.resetModules()
  return import('./outbox')
}

const job = (id: string): OutboxJob =>
  ({
    id,
    createdAt: Date.now(),
    tag: 'mur',
    caption: '',
    video: { sha256: id, mime: 'video/mp4', ext: 'mp4', size: 3, duration: 1, width: 1, height: 1, bitrate: 1 },
    videoBlob: new Blob([new Uint8Array([1, 2, 3])]),
    signer: { type: 'local', sk: 'aa', pubkey: 'bb' },
    state: 'pending',
    servers: [],
    mirrors: [],
    posterMirrors: [],
    attempts: 0,
    timings: { recordedAt: Date.now() },
  }) as OutboxJob

const originalPut = IDBObjectStore.prototype.put

beforeEach(async () => {
  IDBObjectStore.prototype.put = originalPut
  const m = await fresh()
  await m.wipeOutbox().catch(() => {})
})
afterEach(() => {
  IDBObjectStore.prototype.put = originalPut
})

describe('file d’envoi : écriture durable (audit F06)', () => {
  it('une écriture réussie survit au rechargement', async () => {
    const a = await fresh()
    expect(await a.putJob(job('j1'))).toBe('durable')
    const b = await fresh()
    expect((await b.listJobs()).map((j) => j.id)).toEqual(['j1'])
  })

  it('quota dépassé : l’écriture est signalée comme non durable', async () => {
    const a = await fresh()
    IDBObjectStore.prototype.put = function () {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    expect(await a.putJob(job('j2'))).toBe('memory')
    expect(a.isDurable('j2')).toBe(false)
    // Visible dans cette instance (mémoire)…
    expect((await a.listJobs()).map((j) => j.id)).toContain('j2')
    IDBObjectStore.prototype.put = originalPut
    // …mais pas après rechargement : l'application ne doit pas prétendre le contraire.
    const b = await fresh()
    expect((await b.listJobs()).map((j) => j.id)).not.toContain('j2')
  })

  it('transaction annulée après le succès de la requête : non durable', async () => {
    const a = await fresh()
    IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
      const req = originalPut.apply(this, args)
      req.addEventListener('success', () => this.transaction.abort())
      return req
    }
    expect(await a.putJob(job('j3'))).toBe('memory')
    IDBObjectStore.prototype.put = originalPut
    const b = await fresh()
    expect((await b.listJobs()).map((j) => j.id)).not.toContain('j3')
  })
})

describe('effacement (audit F03)', () => {
  it('suppression bloquée par une connexion qui ne se ferme pas : échec signalé, pas de faux succès', async () => {
    const a = await fresh()
    await a.putJob(job('k1'))
    // Autre onglet « têtu » : connexion ouverte qui ignore versionchange.
    const stubborn = await new Promise<IDBDatabase>((resolve) => {
      const req = indexedDB.open('hashwall', 1)
      req.onsuccess = () => resolve(req.result)
    })
    stubborn.onversionchange = null
    await expect(a.wipeOutbox(300)).rejects.toThrow(/bloqu/)
    stubborn.close()
  })

  it('les autres instances ferment leur connexion sur versionchange : l’effacement aboutit', async () => {
    const a = await fresh()
    await a.putJob(job('k2'))
    const b = await fresh()
    await b.listJobs() // b ouvre sa propre connexion
    const c = await fresh()
    await expect(c.wipeOutbox(2000)).resolves.toBeUndefined()
    const d = await fresh()
    expect(await d.listJobs()).toEqual([])
  })

  it('après effacement, plus aucune écriture ne recrée la base dans cette instance', async () => {
    const a = await fresh()
    await a.wipeOutbox()
    expect(await a.putJob(job('k3'))).toBe('memory')
    const b = await fresh()
    expect(await b.listJobs()).toEqual([])
  })
})
