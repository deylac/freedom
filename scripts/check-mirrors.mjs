#!/usr/bin/env node
// Vérifie quels miroirs répondent réellement (depuis le réseau du lanceur, ex. GitHub Actions) et
// n'imprime que ceux-là, au format attendu par publish-mirrors.mjs (« url|libellé », une par ligne).
//
//   node scripts/check-mirrors.mjs "https://a.example/|Principal" "https://b.example/|Europe" > ok.txt
//
// Un miroir est retenu s'il sert la page de HashWall (HTTP 200, titre « HashWall »). S'il sert une
// version plus ancienne que dist/sw.js (déploiement en retard), il est retenu avec un avertissement :
// une ancienne version fonctionne toujours.
import { existsSync, readFileSync } from 'node:fs'

const TIMEOUT_MS = Number(process.env.MIRROR_TIMEOUT_MS ?? 15_000)
const localVersion = existsSync('dist/sw.js') ? readFileSync('dist/sw.js', 'utf8').match(/const VERSION = "([0-9a-f]+)"/)?.[1] : undefined

async function get(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': 'HashWall-mirror-check' } })
    return { status: res.status, body: res.ok ? await res.text() : '' }
  } finally {
    clearTimeout(timer)
  }
}

const results = await Promise.all(
  process.argv.slice(2).map(async (arg) => {
    const [raw, label] = arg.split('|')
    const url = raw.endsWith('/') ? raw : `${raw}/`
    try {
      const page = await get(url)
      if (page.status !== 200 || !page.body.includes('<title>HashWall')) return { arg, url, ok: false, why: `HTTP ${page.status}` }
      let note = ''
      if (localVersion) {
        const sw = await get(new URL('sw.js', url).href).catch(() => ({ status: 0, body: '' }))
        const remote = sw.body.match(/const VERSION = "([0-9a-f]+)"/)?.[1]
        if (remote && remote !== localVersion) note = ` (version ${remote}, attendue ${localVersion})`
      }
      return { arg: label ? `${url}|${label}` : url, url, ok: true, why: `OK${note}` }
    } catch (err) {
      return { arg, url, ok: false, why: err instanceof Error ? err.name : String(err) }
    }
  }),
)

for (const r of results) console.error(`${r.ok ? 'OK ' : 'KO '} ${r.url} — ${r.why}`)
for (const r of results) if (r.ok) console.log(r.arg)
process.exit(results.some((r) => r.ok) ? 0 : 1)
