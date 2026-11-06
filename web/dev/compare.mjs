// Dev tool, never imported by src/: the approved preview beside the built page, one row per screen, for Damian's eyes.
//   node dev/compare.mjs <built shots dir> <preview dir> <out dir>
// <built shots dir> is the out dir of dev/shots.mjs (<screen>-<width>.png); <preview dir> is plan/preview/ (its
// index.html and its shots/). Writes compare-390.png and compare-1440.png; a sheet taller than MAX_TALL is split into
// compare-<width>.png, compare-<width>-2.png, … and the split is printed.
// Both sides are shown at the same scale: CSS width 390 or 1440, device scale 1 (the scale of both sets of shots),
// top-aligned, each at its full height. Where no approved shot exists at that width, the preview source itself is
// rendered at that width (index.html?s=…) and labelled so. One Chromium tab does all of it.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'

const [built, preview, out] = process.argv.slice(2)
if (!built || !preview || !out) {
  console.error('usage: node dev/compare.mjs <built shots dir> <preview dir> <out dir>')
  process.exit(2)
}
mkdirSync(out, { recursive: true })

// A screenshot taller than about 16 000 px goes past what Chromium paints in one piece.
const MAX_TALL = 16_000
const GAP = 48
const LABEL = 64

// Each row: the built screen, and what it is compared with. shot: an approved file in <preview>/shots/; src: the
// preview's query string, rendered at that width; none: the preview has no such screen, said on the left side.
// The preview has no status page: its screen c is "Add a video" (shot phone-addvideo), so status is set against
// nothing rather than against a different screen.
const NO_STATUS = 'The approved preview has no status page (preview screen c is "Add a video", compared on the add row).'
const SHEETS = {
  390: [
    { built: 'step1', shot: 'phone-1.png' },
    { built: 'it-step1', shot: 'phone-1-it.png' },
    { built: 'step2', shot: 'phone-2.png' },
    { built: 'step3-uploading', shot: 'phone-3.png' },
    { built: 'step3e', shot: 'phone-3err.png' },
    { built: 'we-have-it', shot: 'phone-4.png' },
    { built: 'it-we-have-it', shot: 'phone-4-it.png' },
    { built: 'add', shot: 'phone-addvideo.png' },
    { built: 'status', none: NO_STATUS },
  ],
  1440: [
    { built: 'step1', shot: 'pc-1.png' },
    { built: 'it-step1', src: 's=1&lang=it' },
    { built: 'step2', src: 's=2' },
    { built: 'step3-uploading', shot: 'pc-3.png' },
    { built: 'step3e', src: 's=3e' },
    { built: 'we-have-it', src: 's=4' },
    { built: 'it-we-have-it', src: 's=4&lang=it' },
    { built: 'add', src: 's=c' },
    { built: 'status', none: NO_STATUS },
    { built: 'desk', shot: 'desk.png' },
  ],
}

// Width and height from the PNG header (IHDR), so rows can be measured before the sheet is laid out.
function pngSize(buf) {
  if (buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('not a PNG')
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }
}
const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

const browser = await chromium.launch()
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })
const page = await context.newPage()

// The preview source at one width, full page, as the approved shots were taken (fonts from Google Fonts).
async function renderPreview(query, width) {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(`${pathToFileURL(path.join(preview, 'index.html')).href}?${query}`, { waitUntil: 'networkidle' })
  await page.evaluate(() => document.fonts.ready)
  return page.screenshot({ fullPage: true })
}

// One side of a row: { label (screen · preview|built), from (where the picture comes from), img?: { url, w, h }, note? }.
function side(buf, label, from) {
  const { w, h } = pngSize(buf)
  return { label, from, img: { url: dataUrl(buf), w, h } }
}
async function rowOf(r, width) {
  const file = path.join(built, `${r.built}-${width}.png`)
  const right = existsSync(file)
    ? side(readFileSync(file), `${r.built} · built`, path.basename(file))
    : { label: `${r.built} · built`, from: 'missing', note: `No built shot: ${file} is missing.` }
  let left
  if (r.shot) left = side(readFileSync(path.join(preview, 'shots', r.shot)), `${r.built} · preview`, `approved ${r.shot}`)
  else if (r.src) left = side(await renderPreview(r.src, width), `${r.built} · preview`, `rendered from source ?${r.src}`)
  else left = { label: `${r.built} · preview`, from: 'none', note: r.none }
  const tall = Math.max(left.img?.h ?? 200, right.img?.h ?? 200)
  return { left, right, tall: LABEL + tall + GAP }
}

function html(rows, width) {
  const cell = (s) => `<div class="cell"><div class="label">${esc(s.label)}<small>${esc(s.from)}</small></div>${
    s.img
      ? `<img src="${s.img.url}" width="${s.img.w}" height="${s.img.h}">`
      : `<div class="note">${esc(s.note)}</div>`
  }</div>`
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;background:#11131a;color:#f2f4f8;font:600 22px/1.3 system-ui,sans-serif}
  .grid{display:grid;grid-template-columns:${width}px ${width}px;column-gap:${GAP}px;row-gap:${GAP}px;padding:${GAP}px;
    align-items:start;width:max-content}
  .label{height:${LABEL}px;box-sizing:border-box;padding-bottom:10px;white-space:nowrap}
  .label small{display:block;font:500 16px/1.3 system-ui,sans-serif;color:#aab0bf}
  img{display:block;outline:1px solid #3a3f4d}
  .note{height:200px;box-sizing:border-box;padding:24px;border:2px dashed #6b7184;color:#c9cdd8;font-weight:500}
  </style></head><body><div class="grid">${rows.map((r) => cell(r.left) + cell(r.right)).join('')}</div></body></html>`
}

for (const [width, list] of Object.entries(SHEETS)) {
  const w = Number(width)
  const rows = []
  for (const r of list) rows.push(await rowOf(r, w))
  // Rows go to a sheet until the next one would pass MAX_TALL; a row is never cut.
  const sheets = [[]]
  let tall = GAP
  for (const r of rows) {
    if (sheets.at(-1).length && tall + r.tall > MAX_TALL) {
      sheets.push([])
      tall = GAP
    }
    sheets.at(-1).push(r)
    tall += r.tall
  }
  for (const [i, sheet] of sheets.entries()) {
    const file = path.join(out, `compare-${w}${i ? `-${i + 1}` : ''}.png`)
    await page.setViewportSize({ width: 2 * w + 3 * GAP, height: 900 })
    await page.setContent(html(sheet, w), { waitUntil: 'load' })
    writeFileSync(file, await page.screenshot({ fullPage: true }))
    console.log(`${file}: ${sheet.length} rows${sheets.length > 1 ? ` (sheet ${i + 1} of ${sheets.length}, split at ${MAX_TALL} px)` : ''}`)
  }
}
await browser.close()
