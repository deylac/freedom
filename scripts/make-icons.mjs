// Génère les icônes PNG de la PWA à partir de public/icons/icon.svg (Chromium/Playwright).
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const root = fileURLToPath(new URL('..', import.meta.url))
const svg = readFileSync(`${root}/public/icons/icon.svg`, 'utf8')

const targets = [
  { file: 'icon-192.png', size: 192, padding: 0 },
  { file: 'icon-512.png', size: 512, padding: 0 },
  { file: 'apple-touch-icon.png', size: 180, padding: 0 },
  // Zone de sécurité « maskable » : 80 % central.
  { file: 'maskable-512.png', size: 512, padding: 0.1, background: '#0A0F1D' },
]

const browser = await chromium.launch()
const page = await browser.newPage()
for (const t of targets) {
  const inner = Math.round(t.size * (1 - 2 * t.padding))
  await page.setViewportSize({ width: t.size, height: t.size })
  await page.setContent(
    `<html><body style="margin:0;background:${t.background ?? 'transparent'};display:grid;place-items:center;width:${t.size}px;height:${t.size}px">
      <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div>
    </body></html>`,
  )
  await page.screenshot({ path: `${root}/public/icons/${t.file}`, omitBackground: !t.background })
  console.log('écrit', t.file)
}
await browser.close()
