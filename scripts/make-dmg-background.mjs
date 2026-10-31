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

function page(scale) {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; background: #ffffff; overflow: hidden; }
  #scaled {
    width: ${WIDTH}px;
    height: ${HEIGHT}px;
    transform: scale(${scale});
    transform-origin: 0 0;
  }
</style>
</head>
<body>
<div id="scaled">
<svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#fbfcfd"/>
      <stop offset="1" stop-color="#e9ecf1"/>
    </linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <text x="330" y="118" text-anchor="middle"
        font-family="-apple-system, 'Helvetica Neue', Arial, sans-serif"
        font-size="14" fill="#5d6675">Geser ke folder Applications</text>
  <g fill="none" stroke="#b3521f" stroke-opacity="0.6" stroke-width="9"
     stroke-linecap="round" stroke-linejoin="round">
    <path d="M288 200 H372"/>
    <path d="M352 181 L375 200 L352 219"/>
  </g>
</svg>
</div>
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
