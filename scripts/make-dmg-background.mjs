// Builds the DMG window background.
//
// Run with: ./node_modules/.bin/electron scripts/make-dmg-background.mjs
//
// The page is rendered offscreen by Chromium, so the arrow and the text use the
// same rasterizer the app uses. Two scales are written and combined into one
// hidpi TIFF with tiffutil, which is what Finder expects for a sharp 1x/2x
// background on a Retina display.
import { app, BrowserWindow } from 'electron'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const WIDTH = 660
const HEIGHT = 400

// Database-tool glyphs for the faded pattern. Each path is drawn in a -40..40
// box, so the placement list only carries a position, a rotation, and a scale.
const DOODLES = {
  database: `
    <ellipse cx="0" cy="-22" rx="28" ry="9"/>
    <path d="M-28 -22 V22 a28 9 0 0 0 56 0 V-22"/>
    <path d="M-28 0 a28 9 0 0 0 56 0"/>`,
  table: `
    <rect x="-30" y="-24" width="60" height="48" rx="5"/>
    <path d="M-30 -6 H30 M-10 -24 V24 M10 -24 V24"/>`,
  terminal: `
    <rect x="-30" y="-22" width="60" height="44" rx="5"/>
    <path d="M-18 -7 l9 7 -9 7"/>
    <path d="M0 14 H16"/>`,
  key: `
    <circle cx="-16" cy="0" r="10"/>
    <path d="M-6 0 H26 M18 0 V8 M10 0 V6"/>`,
  document: `
    <path d="M-18 -26 h24 l12 12 v40 h-36 z"/>
    <path d="M6 -26 v12 h12"/>
    <path d="M-10 -4 H12 M-10 6 H12 M-10 16 H4"/>`,
  search: `
    <circle cx="-6" cy="-6" r="16"/>
    <path d="M6 6 L22 22"/>`,
  plug: `
    <path d="M-18 -18 v12 a18 18 0 0 0 36 0 v-12"/>
    <path d="M-24 -18 h12 M12 -18 h12"/>
    <path d="M0 12 v12"/>`,
  funnel: `
    <path d="M-28 -20 H28 L8 4 V26 L-8 18 V4 Z"/>`
}

// Kept to the edges so the wordmark, arrow, and both icons sit on plain
// background. Sizes are close to the icon grid so the pattern reads as texture,
// not as a second row of controls.
const PATTERN = [
  { icon: 'database', x: 52, y: 66, rotate: -14, scale: 1 },
  { icon: 'funnel', x: 150, y: 34, rotate: -8, scale: 0.7 },
  { icon: 'plug', x: 516, y: 34, rotate: 10, scale: 0.7 },
  { icon: 'terminal', x: 616, y: 64, rotate: 14, scale: 1 },
  { icon: 'key', x: 36, y: 214, rotate: 10, scale: 0.8 },
  { icon: 'search', x: 596, y: 206, rotate: 4, scale: 0.75 },
  { icon: 'table', x: 140, y: 348, rotate: 8, scale: 0.85 },
  { icon: 'document', x: 632, y: 344, rotate: -8, scale: 0.9 }
]

function page(scale) {
  const width = WIDTH * scale
  const height = HEIGHT * scale
  const pattern = PATTERN.map(
    (item) =>
      `<g transform="translate(${item.x} ${item.y}) rotate(${item.rotate}) scale(${item.scale})">${DOODLES[item.icon]}</g>`
  ).join('\n    ')
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #ffffff; overflow: hidden; }
</style>
</head>
<body>
<svg width="${width}" height="${height}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fbfcfd"/>
      <stop offset="1" stop-color="#eef1f4"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>

  <g fill="none" stroke="#1b1f24" stroke-opacity="0.055" stroke-width="3"
     stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${pattern}
  </g>

  <text x="330" y="120" text-anchor="middle"
        font-family="-apple-system, 'SF Pro Display', 'Helvetica Neue', Arial, sans-serif"
        font-size="60" font-weight="700" letter-spacing="-2"
        fill="#1b1f24">Tupai</text>

  <g fill="none" stroke="#b3521f" stroke-opacity="0.7" stroke-width="8"
     stroke-linecap="round" stroke-linejoin="round">
    <path d="M262 246 C 300 226, 360 226, 396 242"/>
    <path d="M376 224 L400 242 L374 258"/>
  </g>
</svg>
</body>
</html>`
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function capture(scale, htmlFile) {
  const win = new BrowserWindow({
    width: WIDTH * scale,
    height: HEIGHT * scale,
    useContentSize: true,
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { offscreen: true }
  })
  let latest = null
  win.webContents.on('paint', (_event, _dirty, image) => {
    latest = image
  })
  await win.loadFile(htmlFile)
  // The first frame can arrive before the text is laid out; wait, then ask for
  // one more frame so the capture is the finished page.
  await delay(400)
  win.webContents.invalidate()
  await delay(200)
  if (!latest) {
    throw new Error(`No paint event for scale ${scale}`)
  }
  // The window stays alive until both scales are captured: destroying the first
  // one while the second is loading cancelled that load on macOS.
  return latest.toPNG()
}

app.disableHardwareAcceleration()

app
  .whenReady()
  .then(async () => {
    const out = resolve('build')
    const temp = mkdtempSync(join(tmpdir(), 'tupai-dmg-'))
    const one = join(temp, 'background.png')
    const two = join(temp, 'background@2x.png')
    const pageOne = join(temp, 'page-1x.html')
    const pageTwo = join(temp, 'page-2x.html')
    writeFileSync(pageOne, page(1))
    writeFileSync(pageTwo, page(2))
    writeFileSync(one, await capture(1, pageOne))
    writeFileSync(two, await capture(2, pageTwo))
    execFileSync('tiffutil', [
      '-cathidpicheck',
      one,
      two,
      '-out',
      join(out, 'dmg-background.tiff')
    ])
    console.log(`Wrote ${join(out, 'dmg-background.tiff')}`)
    app.quit()
  })
  .catch((error) => {
    console.error(error)
    app.exit(1)
  })
