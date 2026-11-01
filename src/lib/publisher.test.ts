import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { Publisher } from './publish'
import { putJob, wipeOutbox, type OutboxJob } from './storage/outbox'

const job = (id: string): OutboxJob =>
  ({
    id,
    createdAt: Date.now(),
    tag: 'mur',
    caption: '',
    video: { sha256: id, mime: 'video/mp4', ext: 'mp4', size: 3, duration: 1, width: 1, height: 1, bitrate: 1 },
    signer: { type: 'local', sk: 'aa', pubkey: 'bb' },
    state: 'pending',
    servers: [],
    mirrors: [],
    posterMirrors: [],
    attempts: 0,
    timings: { recordedAt: Date.now() },
  }) as OutboxJob

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now()
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('délai dépassé')
    await new Promise((r) => setTimeout(r, 5))
  }
}

describe('reprise au retour du réseau (audit F07)', () => {
  it('une tâche déjà connue en échec est relancée par resumeAll', async () => {
    await wipeOutbox().catch(() => {})
    let online = false
    const calls = { publish: 0, mirror: 0 }
    const p = new Publisher({
      publish: async (j) => {
        calls.publish++
        if (!online) throw new Error('hors ligne')
        j.eventId = 'e1'
        j.state = 'published'
      },
      mirror: async () => {
        calls.mirror++
      },
    })
    const j = job('f07-a')
    await putJob(j)
    p.enqueue(j)
    await until(() => p.getSnapshot()[0]?.progress.stage === 'error')
    online = true
    await p.resumeAll() // événement « online »
    await until(() => calls.mirror === 1)
    expect(calls.publish).toBe(2)
  })

  it('« online » répété pendant une tentative active : une seule exécution par tâche', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let running = 0
    let maxRunning = 0
    let publishCalls = 0
    const p = new Publisher({
      publish: async (j) => {
        publishCalls++
        running++
        maxRunning = Math.max(maxRunning, running)
        await gate
        running--
        j.eventId = 'e2'
        j.state = 'published'
      },
      mirror: async () => {},
    })
    const j = job('f07-b')
    await putJob(j)
    p.enqueue(j)
    await until(() => publishCalls === 1)
    await Promise.all([p.resumeAll(), p.resumeAll(), p.resumeAll()])
    release()
    await until(() => p.getSnapshot().every((v) => v.id !== 'f07-b' || v.state === 'done'))
    expect(publishCalls).toBe(1)
    expect(maxRunning).toBe(1)
  })
})
