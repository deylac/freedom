#!/usr/bin/env node
// Publie la liste SIGNÉE des adresses de secours (kind 30078, d = "hashwall-mirrors").
//
// Usage (sur un ordinateur de confiance, jamais dans l'application) :
//   HASHWALL_PROJECT_NSEC=nsec1… node scripts/publish-mirrors.mjs \
//     "https://hashwall.example/|Domaine principal" "https://xxxx.ipfs.dweb.link/|IPFS" \
//     "http://abcdef….onion/|Tor"
//
// La clé publique correspondante doit être celle du build (VITE_PROJECT_NPUB). Une nouvelle liste
// remplace la précédente (événement adressable) : toujours republier la liste COMPLÈTE.
// Relais : ceux de src/config.ts, ou HASHWALL_RELAYS="wss://a wss://b".
import { readFileSync } from 'node:fs'
import { finalizeEvent, getPublicKey } from 'nostr-tools/pure'
import { SimplePool } from 'nostr-tools/pool'
import * as nip19 from 'nostr-tools/nip19'

const raw = process.env.HASHWALL_PROJECT_NSEC ?? ''
if (!raw.startsWith('nsec1')) {
  console.error('HASHWALL_PROJECT_NSEC (nsec1…) manquant')
  process.exit(1)
}
const decoded = nip19.decode(raw)
if (decoded.type !== 'nsec') throw new Error('clé invalide')
const sk = decoded.data

const valid = (url) => {
  try {
    const u = new URL(url)
    if (u.username || u.password || u.hash || u.search) return false
    return u.protocol === 'https:' || (u.protocol === 'http:' && u.hostname.endsWith('.onion'))
  } catch {
    return false
  }
}

const mirrors = process.argv.slice(2).map((arg) => {
  const [url, label] = arg.split('|')
  const normalized = url.endsWith('/') ? url : `${url}/`
  if (!valid(normalized)) throw new Error(`adresse refusée : ${url} (https, ou http pour .onion ; ni identifiants, ni ? ni #)`)
  return ['r', normalized, ...(label ? [label] : [])]
})
if (mirrors.length === 0) {
  console.error('Aucune adresse fournie.')
  process.exit(1)
}

const configSource = readFileSync(new URL('../src/config.ts', import.meta.url), 'utf8')
const defaults = [...(configSource.match(/DEFAULT_RELAYS = list\([^[]*\[([^\]]*)\]/)?.[1] ?? '').matchAll(/'(wss:[^']+)'/g)].map((m) => m[1])
const relays = (process.env.HASHWALL_RELAYS ?? '').split(/\s+/).filter(Boolean)
const targets = relays.length > 0 ? relays : defaults

const event = finalizeEvent(
  { kind: 30078, created_at: Math.floor(Date.now() / 1000), content: 'Adresses de secours HashWall', tags: [['d', 'hashwall-mirrors'], ...mirrors] },
  sk,
)
console.log(`Clé du projet : ${nip19.npubEncode(getPublicKey(sk))}`)
console.log(`${mirrors.length} adresse(s), publication sur ${targets.length} relais…`)
const pool = new SimplePool()
const results = await Promise.allSettled(pool.publish(targets, event))
results.forEach((r, i) => console.log(`  ${r.status === 'fulfilled' ? 'OK ' : 'KO '} ${targets[i]}${r.status === 'rejected' ? ` (${r.reason})` : ''}`))
pool.close(targets)
const ok = results.filter((r) => r.status === 'fulfilled').length
console.log(`${ok}/${targets.length} relais ont accepté la liste.`)
process.exit(ok > 0 ? 0 : 1)
