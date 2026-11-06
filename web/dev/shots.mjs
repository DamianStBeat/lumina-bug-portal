// Dev tool, never imported by src/: screenshots of every screen, the width checks and the acceptance rows of the
// web slice, driven through the real UI against the dev mock (dev/mock-api.ts) and its /__mock/* switches.
//   node dev/shots.mjs <dev-server-url> <out-dir>
// Exits 1 when a width check or a row fails. The big test files are sparse (no disk used), made in a temp folder
// that is removed on exit.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright-core'

const [base = 'http://localhost:5173', out = 'shots'] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const tmp = mkdtempSync(path.join(tmpdir(), 'lumina-shots-'))
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(130))

const MiB = 1024 ** 2
function sparse(name, bytes) {
  const p = path.join(tmp, name)
  writeFileSync(p, '')
  truncateSync(p, bytes)
  return p
}
const FILES = {
  big: sparse('boss-300mb.mp4', 300 * MiB),
  mid: sparse('wave-100mb.mp4', 100 * MiB),
  small: sparse('clip-20mb.mp4', 20 * MiB),
  huge: sparse('long-3gb.mp4', 3 * 1024 ** 3),
  zip: sparse('logs.zip', 2048),
}
// A real 3-second clip for the desk player (row 10), served by the mock for video attachments. VP9 in MP4: a
// royalty-free codec every Chromium build decodes (open-source builds have no H.264).
const CLIP = path.join(tmp, 'clip-3s.mp4')
execFileSync('/usr/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i',
  'testsrc=size=640x360:rate=24:duration=3', '-c:v', 'libvpx-vp9', '-b:v', '300k', '-pix_fmt', 'yuv420p',
  '-movflags', '+faststart', CLIP])
// 360 is not in the brief's list: it is the most common Android width, and step 2 overflowed there by 2 px.
const WIDTHS = [320, 360, 390, 820, 1024, 1440, 1920]
const SHOT_WIDTHS = [390, 820, 1440]
const ORANGE = 'rgba(255, 159, 67, 0.45)'
const WARM_GOLD = 'rgb(242, 196, 109)'
const WHAT = 'The boss stopped on the bridge and the wave never ended.'
// The preview's Italian (plan/preview/index.html, const T.it): row 7 compares the page with these, not with it.ts.
const PREVIEW_IT = {
  sub: 'Segnala un problema', h1: 'Segnala un bug', lead: 'Dicci cosa non ha funzionato. Un video ci aiuta più di tutto.',
  q1: 'Cosa è successo?', ph1: "Il boss si è fermato sul ponte e l'ondata non è più finita.",
  hint1: "Di' cosa stavi facendo appena prima.", next: 'Avanti', h4: 'Ricevuta',
  lead4: 'Grazie di avercelo detto. Tieni questo codice per vedere come va.',
  codeL: 'Il codice della tua segnalazione', track: 'Ricevuta|La stiamo guardando|Sistemata',
  again: 'Segnala un altro bug',
}

async function call(p, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
  const r = await fetch(base + p, init)
  if (!r.ok) throw new Error(`${p} answered ${r.status}`)
  return r.json()
}
const faults = (f = {}) => call('/__mock/faults', { failParts: 0, offline: false, slowMs: 0, ...f })
const reset = () => call('/__mock/reset', {})
const stats = async (id) => (await call('/__mock/stats'))[id] ?? {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return
  throw new Error(`timed out: ${what}`)
}

const browser = await chromium.launch()
await fetch(base + '/__mock/video', { method: 'POST', body: readFileSync(CLIP) }).then((r) => {
  if (!r.ok) throw new Error(`/__mock/video answered ${r.status}`)
})
const contexts = new Set()

// One fresh tab per check: the Turnstile size is chosen at render from the width, as on a real device.
async function open(url, { width = 390, locale = 'en-US' } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale })
  contexts.add(context)
  context.setDefaultTimeout(30_000)
  const page = await context.newPage()
  const seen = { reports: 0, attachments: 0, atts: [] }
  page.on('request', (r) => {
    if (r.method() !== 'POST') return
    if (/\/api\/v1\/reports$/.test(r.url())) seen.reports++
    if (/\/attachments$/.test(r.url())) seen.attachments++
  })
  page.on('response', async (r) => {
    if (r.request().method() === 'POST' && /\/attachments$/.test(r.url()) && r.status() === 201) {
      seen.atts.push((await r.json()).attachmentId)
    }
  })
  await page.goto(base + url)
  const close = async () => {
    contexts.delete(context)
    await context.close()
  }
  return { page, seen, close }
}

const gold = (page) => page.locator('.card .btn.gold-btn').first()
async function toStep2(page) {
  await page.locator('textarea').fill(WHAT)
  await gold(page).click()
}
async function chooseChips(page) {
  await page.locator('.chips').nth(0).locator('button').nth(0).click()
  await page.locator('.chips').nth(1).locator('button').nth(0).click()
}
async function toStep3(page) {
  await toStep2(page)
  await chooseChips(page)
  await gold(page).click()
  await page.locator('.drop').waitFor()
}
// The send button turns on only with a Turnstile token: this waits for Cloudflare's widget to pass.
async function waitToken(page) {
  await page.waitForFunction(() => document.querySelector('.card .btn.gold-btn')?.disabled === false, null, {
    timeout: 45_000,
  }).catch(() => {
    throw new Error('no Turnstile token (challenges.cloudflare.com not reachable?)')
  })
}
async function pickAndSend(page, file) {
  await page.locator('input[type=file]').setInputFiles(file)
  await waitToken(page)
  await gold(page).click()
}
const pct = (page) =>
  page.evaluate(() => Number(document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') ?? -1))
const doneCode = async (page, ms = 120_000) => {
  await page.locator('.code .val').waitFor({ timeout: ms })
  return (await page.locator('.code .val').textContent())?.trim()
}
const errOf = (page) =>
  page.locator('.err').first().evaluate((el) => ({ text: el.textContent?.trim(), border: getComputedStyle(el).borderTopColor }))
async function settle(page) {
  await page.evaluate(() => document.fonts.ready)
  if (await page.locator('.turnstile').count()) {
    await page.locator('.turnstile iframe').waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {})
    await sleep(2500)
  }
}

// Width rule for every page; the 56 px rule on the player pages and on the desk's action buttons (the desk's filter
// pills stay at the preview's size). Clipped: content bigger than a box that hides its overflow, or spilling out of
// a control (the ellipsis on file names is meant). Overlap: two controls whose boxes cross.
function measure(page, desk) {
  return page.evaluate((desk) => {
    const vis = (el) => el.checkVisibility({ visibilityProperty: true, opacityProperty: true })
    const name = (el) => `${el.tagName.toLowerCase()}.${String(el.className).trim().replace(/ +/g, '.')}`
    const over = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - window.innerWidth
    const small = []
    for (const el of document.querySelectorAll(desk ? '.actions .btn' : 'button, a[href], input, textarea, select, .chip')) {
      if (!vis(el)) continue
      const r = el.getBoundingClientRect()
      if (r.width > 0 && r.height > 0 && r.height < 56) small.push(`${name(el)}=${Math.round(r.height)}px`)
    }
    const clipped = []
    for (const el of document.querySelectorAll('body *')) {
      if (el.closest('svg') || el.matches('input, textarea, select, iframe, video, img, .visually-hidden, .file .name b')) continue
      if (!vis(el)) continue
      const cs = getComputedStyle(el)
      const flow = cs.overflowX + cs.overflowY
      if (cs.display === 'inline' || /auto|scroll/.test(flow)) continue
      if (!/hidden|clip/.test(flow) && !el.matches('button, a[href], .chip')) continue
      if (el.scrollWidth - el.clientWidth > 1 || el.scrollHeight - el.clientHeight > 1) clipped.push(name(el))
    }
    const boxes = [...document.querySelectorAll('button, a[href], input, textarea, select, iframe, .chip, [role=progressbar]')]
      .filter(vis).map((el) => [el, el.getBoundingClientRect()]).filter(([, r]) => r.width > 0 && r.height > 0)
    const overlap = []
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) {
        const [a, ra] = boxes[i]
        const [b, rb] = boxes[j]
        if (a.contains(b) || b.contains(a)) continue
        const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left)
        const y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top)
        if (x > 1 && y > 1) overlap.push(`${name(a)} x ${name(b)}`)
      }
    }
    return { over, small, clipped, overlap }
  }, desk)
}

const SCREENS = [
  { name: 'step1', url: '/' },
  { name: 'step2', url: '/', go: async (p) => (await toStep2(p), await chooseChips(p)) },
  {
    name: 'step3-uploading', url: '/', faults: { slowMs: 2500 },
    go: async (p) => {
      await toStep3(p)
      await pickAndSend(p, FILES.mid)
      await p.waitForFunction(() => Number(document.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')) > 0)
    },
  },
  {
    name: 'step3e', url: '/', faults: { failParts: 10_000 },
    go: async (p) => (await toStep3(p), await pickAndSend(p, FILES.small), await p.locator('.err').waitFor({ timeout: 90_000 })),
  },
  { name: 'we-have-it', url: '/', go: async (p) => (await toStep3(p), await pickAndSend(p, FILES.small), await doneCode(p)) },
  { name: 'add', url: '/add?code=LUM-482193' },
  { name: 'status', url: '/status/LUM-482193', go: (p) => p.locator('.state').waitFor() },
  { name: 'desk', url: '/desk?code=LUM-482193', desk: true, go: (p) => p.locator('.ai').waitFor() },
  { name: 'it-step1', url: '/', locale: 'it-IT' },
  {
    name: 'it-we-have-it', url: '/', locale: 'it-IT',
    go: async (p) => (await toStep3(p), await pickAndSend(p, FILES.small), await doneCode(p)),
  },
]

const table = []
const shots = []
for (const s of SCREENS) {
  await reset()
  await faults(s.faults)
  // The six widths of a screen run side by side; the mock's faults are global, so screens run one after another.
  const results = await Promise.all(
    WIDTHS.map(async (width) => {
      const tab = await open(s.url, { width, locale: s.locale })
      try {
        await s.go?.(tab.page)
        await settle(tab.page)
        const m = await measure(tab.page, !!s.desk)
        if (SHOT_WIDTHS.includes(width)) {
          const file = path.join(out, `${s.name}-${width}.png`)
          await tab.page.screenshot({ path: file, fullPage: true })
          shots.push(file)
        }
        return { screen: s.name, width, ...m, ok: m.over <= 0 && !m.small.length && !m.clipped.length && !m.overlap.length }
      } catch (e) {
        return { screen: s.name, width, over: NaN, small: [], clipped: [], overlap: [], ok: false, error: e.message }
      } finally {
        await tab.close()
      }
    }),
  )
  table.push(...results)
}
await faults()

console.log('\nscreen            width  scroll  small (<56 px) / clipped / overlap  result')
for (const r of table) {
  const small = r.error ?? ([...r.small, ...r.clipped.map((c) => `clipped ${c}`), ...r.overlap].join(', ') || '-')
  console.log(`${r.screen.padEnd(17)} ${String(r.width).padStart(5)}  ${String(r.over).padStart(6)}  ${small}  ${r.ok ? 'PASS' : 'FAIL'}`)
}

// Row 4, run twice: the server failing every part (HTTP 503), then the browser really offline (setOffline). Each
// time: the orange 3e line, the network back, Try again, the upload completes and no confirmed part is sent again.
async function cutAndResume(cut, restore) {
  await reset()
  await faults({ slowMs: 700 })
  const { page, seen, close } = await open('/')
  await toStep3(page)
  await pickAndSend(page, FILES.mid)
  await until(async () => seen.atts[0] && Object.values(await stats(seen.atts[0])).some((c) => c.ok > 0), 30_000, 'a part')
  await cut(page)
  await page.locator('.err').waitFor({ timeout: 90_000 })
  const err = await errOf(page)
  const at = await pct(page)
  // A part cut in flight may still land on the server; the counts are read after it has.
  await sleep(1500)
  const before = await stats(seen.atts[0])
  await restore(page)
  await page.getByRole('button', { name: 'Try again' }).click()
  await doneCode(page)
  const after = await stats(seen.atts[0])
  await close()
  const kept = Object.keys(before).filter((n) => before[n].ok > 0)
  const resent = kept.filter((n) => after[n].got !== before[n].got)
  const all = Array.from({ length: 7 }, (_, i) => after[i + 1]?.ok > 0).every(Boolean)
  if (err.border !== ORANGE || resent.length || !all || !kept.length) throw new Error(`${JSON.stringify(err)} resent ${resent}`)
  return `orange at ${at} %, parts ${kept} kept, not sent again, completed`
}

// Each row returns a short note; a thrown error is its FAIL reason.
const ROWS = {
  1: async () => {
    const { page, close } = await open('/')
    const h1 = await page.locator('h1').textContent()
    const box = await gold(page).boundingBox()
    const area = await page.locator('textarea').isVisible()
    // Gold on first load: never disabled, full opacity. An empty press shows the orange hint and focuses the field.
    const look = await gold(page).evaluate((el) => `${el.disabled}:${getComputedStyle(el).opacity}`)
    await gold(page).click()
    const hint = await page.locator('.err').textContent()
    const focus = await page.evaluate(() => document.activeElement?.tagName)
    await close()
    if (h1 !== 'Report a bug' || !area || Math.round(box?.height ?? 0) !== 64) throw new Error(`h1=${h1} gold=${box?.height}`)
    if (look !== 'false:1' || hint !== 'Write what happened first.' || focus !== 'TEXTAREA')
      throw new Error(`look=${look} hint=${hint} focus=${focus}`)
    return 'title, field, gold 64 px enabled at opacity 1, empty press: orange hint + focus'
  },
  2: async () => {
    const { page, close } = await open('/')
    await toStep2(page)
    await chooseChips(page)
    const on = await page.locator('.chip.on').evaluateAll((els) =>
      els.map((el) => `${el.textContent}:${el.getAttribute('aria-pressed')}:${getComputedStyle(el).borderTopColor}`))
    await gold(page).click()
    const h1 = await page.locator('h1').textContent()
    await close()
    const want = [`In a match:true:${WARM_GOLD}`, `Phone:true:${WARM_GOLD}`]
    if (JSON.stringify(on) !== JSON.stringify(want) || h1 !== 'Add a video') throw new Error(`${on} → ${h1}`)
    return 'two gold-bordered chips, Next → step 3'
  },
  3: async () => {
    await faults({ slowMs: 300 })
    const { page, seen, close } = await open('/')
    await toStep3(page)
    await pickAndSend(page, FILES.big)
    const values = []
    while (!(await page.locator('.code .val').isVisible())) {
      values.push(await pct(page))
      await sleep(100)
      if (values.length > 1200) throw new Error('no "We have it" in 120 s')
    }
    const code = await doneCode(page)
    const parts = Object.values(await stats(seen.atts[0])).filter((c) => c.ok > 0).length
    await close()
    const mid = values.filter((v) => v > 0 && v < 100)
    const rising = values.every((v, i) => i === 0 || v >= values[i - 1])
    if (!mid.length || !rising || !/^LUM-\d{6}$/.test(code ?? '') || parts !== 19) {
      throw new Error(`bar ${[...new Set(values)]} code ${code} parts ${parts}`)
    }
    return `bar ${[...new Set(mid)].length} steps (${mid[0]}…${mid.at(-1)} %), ${parts}/19 parts, ${code}`
  },
  4: async () => {
    const http = await cutAndResume(() => faults({ slowMs: 700, failParts: 10_000 }), () => faults())
    const net = await cutAndResume(
      (p) => p.context().setOffline(true),
      async (p) => (await p.context().setOffline(false), await faults()),
    )
    return `HTTP 503: ${http}; browser offline: ${net}`
  },
  5: async () => {
    await faults({ slowMs: 400 })
    const { page, seen, close } = await open('/')
    await toStep3(page)
    await pickAndSend(page, FILES.big)
    const id = await (async () => (await until(() => seen.atts[0], 10_000, 'attachment'), seen.atts[0]))()
    await until(async () => Object.values(await stats(id)).filter((c) => c.ok > 0).length >= 3, 30_000, '3 parts')
    await page.reload()
    const hint = (await page.locator('.hint b').textContent({ timeout: 10_000 }))?.trim()
    // After the reload the old tab's requests have all arrived, so this is what was sent before it.
    const before = await stats(id)
    await faults()
    await page.locator('input[type=file]').setInputFiles(FILES.big)
    await doneCode(page)
    const after = await stats(id)
    await close()
    const twice = []
    for (let n = 1; n <= 19; n++) {
      const b = before[n] ?? { got: 0, ok: 0 }
      const a = after[n] ?? { got: 0, ok: 0 }
      const inFlight = b.got > b.ok
      const allowed = b.ok > 0 ? b.got : inFlight ? b.got + 1 : 1
      if (a.ok < 1 || a.got > allowed) twice.push(n)
    }
    const confirmed = Object.keys(before).filter((n) => before[n].ok > 0)
    if (hint !== 'boss-300mb.mp4' || twice.length || seen.reports !== 1 || seen.attachments !== 1) {
      throw new Error(`hint ${hint} twice ${twice} reports ${seen.reports} atts ${seen.attachments}`)
    }
    return `hint shown, ${confirmed.length} parts kept, none sent twice, same report and attachment`
  },
  6: async () => {
    const { page, seen, close } = await open('/')
    await toStep3(page)
    const input = page.locator('input[type=file]')
    await input.setInputFiles(FILES.zip)
    const zip = await errOf(page)
    await input.setInputFiles(FILES.huge)
    await page.waitForFunction((t) => document.querySelector('.err')?.textContent?.trim() !== t, zip.text)
    const huge = await errOf(page)
    const rows = await page.locator('.file').count()
    await close()
    if (zip.border !== ORANGE || huge.border !== ORANGE || zip.text === huge.text || rows || seen.attachments) {
      throw new Error(`${JSON.stringify([zip, huge])} rows ${rows} posts ${seen.attachments}`)
    }
    return `"${zip.text}" / "${huge.text}", 0 POST attachments`
  },
  7: async () => {
    const { page, close } = await open('/', { locale: 'it-IT' })
    const read = (sel) => page.locator(sel).first().textContent().then((t) => t?.trim())
    const got = {
      sub: await read('header .site small'), h1: await read('h1'), lead: await read('.lead'), q1: await read('label.q'),
      ph1: await page.locator('textarea').getAttribute('placeholder'), hint1: await read('.hint span'),
      next: await read('.card .btn.gold-btn'),
    }
    const lang = await page.evaluate(() => document.documentElement.lang)
    await toStep3(page)
    await pickAndSend(page, FILES.small)
    await doneCode(page)
    Object.assign(got, {
      h4: await read('h1'), lead4: await read('.lead'), codeL: await read('.code .label'),
      track: (await page.locator('.track li').allTextContents()).map((t) => t.trim()).join('|'),
      again: await read('.card > .btn.gold-btn'),
    })
    await close()
    const wrong = Object.keys(PREVIEW_IT).filter((k) => got[k] !== PREVIEW_IT[k])
    if (lang !== 'it' || wrong.length) throw new Error(`lang ${lang}; ${wrong.map((k) => `${k}="${got[k]}"`).join('; ')}`)
    return `lang=it, ${Object.keys(PREVIEW_IT).length} preview strings equal (step 1 and Ricevuta)`
  },
  8: async () => {
    const { page, close } = await open('/add?code=LUM-482193')
    const value = await page.locator('input[type=text]').inputValue()
    await pickAndSend(page, FILES.small)
    const code = await doneCode(page)
    await close()
    if (value !== 'LUM-482193' || code !== 'LUM-482193') throw new Error(`field ${value} done ${code}`)
    return 'code prefilled, 20 MB video added, "We have it" with LUM-482193'
  },
  9: async () => {
    const { page, close } = await open('/status/LUM-482193')
    await page.locator('.state').waitFor()
    const four = await page.evaluate(() => document.querySelector('.state')?.textContent)
    const parts = await page.locator('.card > *').evaluateAll((els) => els.map((el) => el.className || el.tagName))
    const text = await page.locator('.card').textContent()
    await close()
    const known = ["We have it. Nobody has looked at it yet.", "We're looking at it.", 'It is fixed in the game.',
      'We checked it. There is nothing to fix.']
    const extra = parts.filter((c) => !['eyebrow', 'gold', 'lead', 'track', 'state', 'small'].includes(c))
    if (!known.includes(four ?? '') || extra.length || /boss|bridge|phone/i.test(text ?? '')) {
      throw new Error(`${four}; extra ${extra}`)
    }
    return `"${four}", nothing else (${parts.join(', ')})`
  },
  10: async () => {
    const { page, close } = await open('/desk?code=LUM-482193', { width: 1440 })
    await page.locator('.ai').waitFor()
    const n = async (sel) => page.locator(sel).count()
    const got = {
      rows: await n('.desk-row'), filters: await n('.filters button'), video: await n('.video video'),
      frames: await n('.frames img'), pr: await n('.actions a[href^="https://github.com/"]'),
      fixed: await n('.actions button'), cols: await page.locator('.dash').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length),
    }
    const ai = await page.locator('.ai').textContent()
    // The clip really plays: decoded frames (readyState 2 = HAVE_CURRENT_DATA) and the clock moving.
    const play = await page.locator('.video video').evaluate(async (v) => {
      v.muted = true
      await v.play()
      await new Promise((r) => setTimeout(r, 1000))
      return { ready: v.readyState, t: v.currentTime, w: v.videoWidth }
    })
    await close()
    const ok = got.rows === 5 && got.filters === 6 && got.video === 1 && got.frames === 6 && got.pr === 1 && got.fixed === 1
    const plays = play.ready >= 2 && play.t > 0 && play.w > 0
    if (!ok || !plays || got.cols !== 2 || !/Likely cause/.test(ai ?? '')) throw new Error(JSON.stringify({ ...got, ...play }))
    return `two columns, ${got.rows} rows, ${got.filters} filters, video plays (readyState ${play.ready}, ${play.t.toFixed(1)} s, ${play.w} px), ${got.frames} frames, AI triage, PR link`
  },
  11: async () => {
    const bad = table.filter((r) => !r.ok)
    if (bad.length) throw new Error(bad.map((r) => `${r.screen}@${r.width}`).join(', '))
    return `${table.length} screen × width checks: no side scroll, nothing clipped, no controls overlapping, no control under 56 px`
  },
}

console.log('\nrow  result  note')
let failed = table.some((r) => !r.ok)
for (const [row, check] of Object.entries(ROWS)) {
  await reset()
  await faults()
  try {
    console.log(`${row.padStart(3)}  PASS    ${await check()}`)
  } catch (e) {
    failed = true
    console.log(`${row.padStart(3)}  FAIL    ${e.message.split('\n')[0]}`)
  }
  await Promise.all([...contexts].map((c) => c.close()))
  contexts.clear()
}
await faults()
await browser.close()
console.log(`\n${shots.length} screenshots in ${out}`)
process.exit(failed ? 1 : 0)
