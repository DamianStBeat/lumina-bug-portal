// The site's end-to-end rows, driven in real Chromium against the real worker (run by e2e/run.sh, which sets E2E_*).
// Every expected value here is the contract's or the row's, never something the code under test answered: a count is
// what this file seeded through the real APIs, a word is the page's copy (web/src/i18n/en.ts, as the preview has it).
import { createHash, randomFillSync } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { chromium } from '../web/node_modules/playwright-core/index.mjs'
import { makeAgentRows } from './agent-rows.mjs'

const env = process.env
const WORKER = env.E2E_WORKER_ORIGIN
const API = `${WORKER}/api/v1`
const SITE = env.E2E_PREVIEW_ORIGIN
const STATE = env.E2E_STATE
const LOGS = env.E2E_LOGS
const GAME_KEY = env.E2E_GAME_KEY
const AGENT_KEY = env.E2E_AGENT_KEY
const ROWS = env.E2E_ROWS.split(',').map(Number)
const KNOWN = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
for (const r of ROWS) if (!KNOWN.includes(r)) throw new Error(`no row ${r} in this harness`)
const FAKE_TURNSTILE = await fs.readFile(new URL('./fake-turnstile.js', import.meta.url), 'utf8')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until(fn, ms, what) {
  const end = Date.now() + ms
  for (;;) {
    const got = await fn()
    if (got) return got
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms: ${what}`)
    await sleep(200)
  }
}
const fail = (msg) => {
  throw new Error(msg)
}
const eq = (got, want, what) => {
  if (got !== want) fail(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
}

// ---- fixtures --------------------------------------------------------------------------------------------------

const MB = 1_000_000
const PART = 16_777_216

// Random bytes, not a sparse file: a part sent to the wrong place, or two parts swapped, must change the hash.
async function makeFile(name, bytes) {
  const file = path.join(STATE, name)
  const hash = createHash('sha256')
  const fh = await fs.open(file, 'w')
  // One buffer, refilled: 300 MB of garbage buffers would be the harness's own peak.
  const buf = Buffer.alloc(1024 * 1024)
  for (let done = 0; done < bytes; ) {
    randomFillSync(buf)
    const chunk = buf.subarray(0, Math.min(buf.length, bytes - done))
    hash.update(chunk)
    await fh.write(chunk)
    done += chunk.length
  }
  await fh.close()
  return { path: file, name, size: bytes, sha256: hash.digest('hex') }
}

// The row's 300 MB, in the contract's megabytes (the desk rounds bytes / 1 000 000), so the expected line is its name.
let big300
const big = async () => (big300 ??= await makeFile('boss-300mb.mp4', 300 * MB))
let mid160
const mid = async () => (mid160 ??= await makeFile('wave-160mb.mp4', 160 * MB)) // 10 parts, so 4 of them is 40 %.

async function sha256OfBody(res) {
  const hash = createHash('sha256')
  let size = 0
  for await (const chunk of res.body) {
    hash.update(chunk)
    size += chunk.length
  }
  return { sha256: hash.digest('hex'), size }
}

// ---- APIs ------------------------------------------------------------------------------------------------------

async function call(method, url, { headers = {}, json, body } = {}) {
  const init = { method, headers: { ...headers } }
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(json)
  } else if (body !== undefined) {
    init.body = body
  }
  const res = await fetch(url, init)
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // A body that is not JSON stays null; the caller's check on the status says what went wrong.
  }
  return { status: res.status, json: parsed, text }
}
async function must(method, url, opts, wantStatus) {
  const r = await call(method, url, opts)
  if (r.status !== wantStatus) fail(`${method} ${url} answered ${r.status}, want ${wantStatus}: ${r.text.slice(0, 200)}`)
  return r.json
}

const game = { 'X-Game-Key': GAME_KEY }
const agent = { Authorization: `Bearer ${AGENT_KEY}` }

let nextUser = 9000
const gameReport = (title, what) =>
  must('POST', `${API}/game/reports`, { headers: game, json: { userId: nextUser++, userName: 'e2e', title, what, lang: 'en', context: { map: 'e2e' } } }, 201).then((r) => r.code)
const triage = (code, verdict) => must('POST', `${API}/agent/reports/${code}/triage`, { headers: agent, json: { verdict, triage: { notes: ['e2e'] } } }, 200)
const agentStatus = (code, body) => must('POST', `${API}/agent/reports/${code}/status`, { headers: agent, json: body }, 200)
const deskStatus = (code, body) => must('POST', `${API}/desk/reports/${code}/status`, { json: body }, 200)
const agentReport = (code) => must('GET', `${API}/agent/reports/${code}`, { headers: agent }, 200)
const partsOf = (id, token) => must('GET', `${API}/attachments/${id}/parts`, { headers: { 'X-Report-Token': token } }, 200).then((r) => r.uploaded.map((p) => p.n).sort((a, b) => a - b))

async function archiveHash(attachmentId) {
  const res = await fetch(`${API}/agent/attachments/${attachmentId}/download`, { headers: agent })
  if (res.status !== 200) fail(`download of ${attachmentId} answered ${res.status}`)
  return sha256OfBody(res)
}

// ---- browser ---------------------------------------------------------------------------------------------------

const browser = await chromium.launch({ headless: true })
let outside = 0
const outsideUrls = []
let pagesOpen = 0

const isLocal = (url) => ['127.0.0.1', 'localhost'].includes(new URL(url).hostname)

// One context per row, so one row's saved upload (sessionStorage) can never be another row's.
async function openPage(pathname, { width = 390, height = 844 } = {}) {
  if (pagesOpen >= 2) fail('the harness tried to open more than 2 tabs at once')
  const context = await browser.newContext({ viewport: { width, height }, locale: 'en-US' })
  context.setDefaultTimeout(45_000)
  await context.route('**/*', async (route) => {
    const url = route.request().url()
    if (isLocal(url)) return route.continue()
    if (new URL(url).hostname === 'challenges.cloudflare.com') {
      return route.fulfill({ status: 200, contentType: 'text/javascript', body: FAKE_TURNSTILE })
    }
    outside++
    outsideUrls.push(url)
    return route.abort('blockedbyclient')
  })
  const page = await context.newPage()
  pagesOpen++
  const seen = { posts: [], deletes: [] }
  page.on('request', (r) => {
    const u = new URL(r.url())
    if (r.method() === 'POST') seen.posts.push(u.pathname)
    if (r.method() === 'DELETE') seen.deletes.push(u.pathname)
  })
  await page.goto(SITE + pathname)
  let closed = false
  return {
    page,
    context,
    seen,
    close: async () => {
      if (closed) return
      closed = true
      await context.close()
      pagesOpen--
    },
  }
}

// The desk is same-site in production (worker/src/index.ts gives only the public routes CORS, and the desk's client
// sends the Access cookie of its own origin), and vite preview has no same-site route to the worker. Only the headers
// are added here: the answers are the real worker's.
async function deskSameSite(page) {
  await page.route(/\/api\/v1\/desk\//, async (route) => {
    // A row can close its page with a desk answer still in flight (the detail refetches after a filter click); a
    // rejection here would be unhandled and would kill the whole run, so it is the browser's failure to see instead.
    try {
      const res = await route.fetch()
      await route.fulfill({
        response: res,
        headers: { ...res.headers(), 'access-control-allow-origin': SITE, 'access-control-allow-credentials': 'true' },
      })
    } catch {
      await route.abort().catch(() => {})
    }
  })
}

const gold = (page) => page.locator('.card .btn.gold-btn').first()
const SESSION_KEY = 'lumina-bug-upload'
const savedSession = (page) => page.evaluate((k) => JSON.parse(sessionStorage.getItem(k) ?? 'null'), SESSION_KEY)

// A real player's path: the two form steps, then the file step (where the safety check lives).
async function reportForm(page, what) {
  await page.locator('textarea').fill(what)
  await gold(page).click()
  await page.locator('.chips').nth(0).locator('button').nth(0).click()
  await page.locator('.chips').nth(1).getByRole('button', { name: 'Phone' }).click()
  await gold(page).click()
  await page.locator('.drop').waitFor()
}
async function waitSendable(page) {
  await page.waitForFunction(() => document.querySelector('.card .btn.gold-btn')?.disabled === false, null, { timeout: 45_000 })
}
const barValues = (page) =>
  page.evaluate(() => [...document.querySelectorAll('[role=progressbar]')].map((b) => Number(b.getAttribute('aria-valuenow'))))
const doneCode = async (page, ms) => {
  await page.locator('.code .val').waitFor({ timeout: ms })
  return (await page.locator('.code .val').textContent()).trim()
}
const heading = (page) => page.locator('h1.gold').textContent()

// Holds the file's fingerprint (crypto.subtle.digest, which the page calls once per picked file) until released, so
// Remove is pressed while it is hashing every time; a slow file only works if the timing happens to line up.
const holdDigestScript = () => {
  const real = SubtleCrypto.prototype.digest
  window.__digest = { asked: 0, hold: false, release: null }
  SubtleCrypto.prototype.digest = async function (...args) {
    const d = window.__digest
    d.asked++
    if (d.hold) await new Promise((r) => (d.release = r))
    return real.apply(this, args)
  }
}

// ---- the rows --------------------------------------------------------------------------------------------------

// Row 1: Sito, telefono 390 px | segnalo con un video di 300 MB | barra, "We have it" col codice; il video è
// nell'archivio intero (hash uguale).
async function row1() {
  const file = await big()
  const { page, close } = await openPage('/')
  try {
    await reportForm(page, 'The boss stopped on the bridge and the wave never ended.')
    await page.setInputFiles('input[type=file]', file.path)
    await waitSendable(page)
    await gold(page).click()

    const bar = []
    const end = Date.now() + 240_000
    for (;;) {
      if (await page.locator('.code .val').count()) break
      if (Date.now() > end) fail(`no "We have it" in 240 s; bar values ${[...new Set(bar)].join(',')}`)
      const vs = await barValues(page)
      if (vs.length > 0) bar.push(vs[0])
      await sleep(150)
    }
    const during = [...new Set(bar)].filter((v) => v > 0 && v < 100)
    if (during.length < 2) fail(`the bar was not seen moving: distinct values ${[...new Set(bar)].join(',')}`)
    for (let i = 1; i < bar.length; i++) if (bar[i] < bar[i - 1]) fail(`the bar went back: ${bar.slice(0, i + 1).join(',')}`)

    const code = await doneCode(page, 5000)
    if (!/^LUM-\d{6}$/.test(code)) fail(`code on the screen: ${code}`)
    eq((await heading(page)).trim(), 'We have it', 'heading')

    const report = await agentReport(code)
    const videos = report.attachments.filter((a) => a.kind === 'video')
    eq(videos.length, 1, 'video attachments on the report')
    eq(videos[0].status, 'complete', 'video status')
    eq(videos[0].size_bytes, file.size, 'declared size')
    eq(videos[0].mime, 'video/mp4', 'mime')
    const got = await archiveHash(videos[0].id)
    eq(got.size, file.size, 'archived size')
    eq(got.sha256, file.sha256, 'sha256 of the archived object')
    return `bar ${during.length} distinct values under 100, ${code}, ${videos[0].id}, sha256 ${got.sha256.slice(0, 12)}…`
  } finally {
    await close()
  }
}

// Row 2: Caricamento al 40 %, ricarico la pagina | riscelgo lo stesso file | riparte dalle parti mancanti, arriva alla fine.
async function row2() {
  const file = await mid()
  const { page, close, seen } = await openPage('/')
  try {
    const puts = []
    let phase = 'first'
    let allow = 4
    const held = []
    await page.route(/\/attachments\/[^/]+\/parts\/\d+$/, (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      const n = Number(new URL(route.request().url()).pathname.split('/').pop())
      puts.push({ phase, n })
      if (phase === 'first' && allow > 0) {
        allow--
        return route.continue()
      }
      if (phase === 'first') {
        held.push(route)
        return undefined
      }
      return route.continue()
    })

    await reportForm(page, 'Row 2: the upload stops at 40 % and the page is reloaded.')
    await page.setInputFiles('input[type=file]', file.path)
    await waitSendable(page)
    await gold(page).click()

    // Four parts in, the next three held in flight: the upload cannot pass 40 % of its parts until the reload.
    await until(() => held.length === 3, 60_000, 'three PUTs held after four parts')
    const saved = await until(() => savedSession(page), 10_000, 'the saved session')
    const line = saved.files[0]
    if (typeof line?.attachmentId !== 'string') fail('no attachment id saved after four parts')
    const attachmentId = line.attachmentId
    eq(line.partCount, 10, 'part count of the 160 MB file')
    const before = await until(async () => {
      const n = await partsOf(attachmentId, saved.reportToken)
      return n.length === 4 ? n : null
    }, 60_000, 'four parts on the worker')
    eq(before.join(), '1,2,3,4', 'parts on the worker before the reload')
    const pct = await until(async () => {
      const [v] = await barValues(page)
      return v >= 40 ? v : null
    }, 15_000, 'the bar at 40 % or more')

    phase = 'resume'
    const postsBefore = seen.posts.length
    await page.reload()
    for (const r of held) await r.abort().catch(() => {})
    await page.locator('.hint').filter({ hasText: file.name }).waitFor({ timeout: 15_000 })
    eq((await heading(page)).trim(), 'Add a video', 'heading after the reload')

    // Worker side, after the reload and before the re-pick: still only the four parts.
    eq((await partsOf(attachmentId, saved.reportToken)).join(), '1,2,3,4', 'parts on the worker after the reload')

    await page.setInputFiles('input[type=file]', file.path)
    const code = await doneCode(page, 180_000)
    eq(code, saved.code, 'code after the resume')

    const resumed = puts.filter((p) => p.phase === 'resume').map((p) => p.n).sort((a, b) => a - b)
    eq(resumed.join(), '5,6,7,8,9,10', 'parts sent after the reload (each exactly once)')
    const posts = seen.posts.slice(postsBefore)
    if (posts.some((p) => /\/reports$/.test(p) || /\/attachments$/.test(p))) fail(`a second report or attachment was created: ${posts}`)

    const report = await agentReport(code)
    const video = report.attachments.find((a) => a.id === attachmentId)
    if (!video) fail(`attachment ${attachmentId} is not on ${code}`)
    eq(video.status, 'complete', 'attachment status')
    const got = await archiveHash(attachmentId)
    eq(got.sha256, file.sha256, 'sha256 of the archived object')
    return `bar ${pct}% at the reload, then only parts ${resumed.join(',')} sent, ${code}, sha256 ${got.sha256.slice(0, 12)}…`
  } finally {
    await close()
  }
}

// Row 8: /status/LUM-… | apro | uno dei quattro stati, coerente con il desk.
// `public` is CONTRACT.md "Statuses"; `desk` is the word the desk's row shows for that internal status.
const WORDS = {
  received: 'We have it. Nobody has looked at it yet.',
  looking: "We're looking at it.",
  fixed: 'It is fixed in the game.',
  checked: 'We checked it. There is nothing to fix.',
}
async function row8() {
  const cases = [
    { name: 'received', set: null, public: 'received', desk: 'Received' },
    { name: 'looking', set: { status: 'looking' }, public: 'looking', desk: 'Looking into it' },
    { name: 'fixed', set: { status: 'fixed' }, public: 'fixed', desk: 'Fixed' },
    { name: 'not_bug', set: { status: 'not_bug' }, public: 'checked', desk: 'Closed' },
    { name: 'closed', set: { status: 'closed' }, public: 'checked', desk: 'Closed' },
  ]
  for (const c of cases) {
    c.code = await gameReport(`Row 8 ${c.name}`, `Row 8 ${c.name}`)
    if (c.set) await deskStatus(c.code, c.set)
  }
  // A duplicate shows its original's public status, whichever that is: one of each, so a fixed answer cannot pass.
  for (const [name, ofName, pub] of [
    ['duplicate of fixed', 'fixed', 'fixed'],
    ['duplicate of looking', 'looking', 'looking'],
  ]) {
    const code = await gameReport(`Row 8 ${name}`, `Row 8 ${name}`)
    await deskStatus(code, { status: 'duplicate', duplicateOf: cases.find((c) => c.name === ofName).code })
    cases.push({ name, code, public: pub, desk: 'Linked' })
  }

  const desk = await openPage('/desk', { width: 1440, height: 900 })
  try {
    await deskSameSite(desk.page)
    await desk.page.reload()
    await desk.page.locator('.desk-row').first().waitFor()
    const status = await openPage('/', { width: 390 })
    const shown = []
    try {
      for (const c of cases) {
        const api = await must('GET', `${API}/status/${c.code}`, {}, 200)
        eq(api.status, c.public, `${c.name}: GET /status`)
        await status.page.goto(`${SITE}/status/${c.code}`)
        await status.page.locator('p.state').waitFor()
        const text = (await status.page.locator('p.state').textContent()).trim()
        eq(text, WORDS[c.public], `${c.name}: the status page`)

        const row = desk.page.locator('.desk-row').filter({ has: desk.page.locator('.c-code b', { hasText: c.code }) })
        await row.waitFor()
        const word = await row.locator('.c-status').evaluate((el) => el.childNodes[0].textContent.trim())
        eq(word, c.desk, `${c.name}: the desk's status word`)
        shown.push(`${c.name}=${c.public}`)
      }
      // Missing is not a state: no tracker, no state line, the page says the code is unknown.
      await status.page.goto(`${SITE}/status/LUM-000000`)
      await status.page.locator('.err').waitFor()
      eq(await status.page.locator('p.state').count(), 0, 'state line for an unknown code')
      eq(await status.page.locator('.track').count(), 0, 'tracker for an unknown code')
    } finally {
      await status.close()
    }
    return `${shown.join(', ')}; unknown code shows the error line`
  } finally {
    await desk.close()
  }
}

// Row 9: Desk | apro | conteggi delle schede e "Video N MB · Device" come l'anteprima.
// Runs first in the run (ORDER below), so the tabs count exactly what is seeded here. A real report for each tab:
//   all 9 · fix_ready 1 · needs_person 2 · duplicate 1 · not_bug 1 · waiting 2 (the fixed and closed ones are in `all` only).
async function row9() {
  const file = await big()
  const webReport = await must('POST', `${API}/reports`, {
    json: { what: 'Row 9: the 300 MB video.', where: 'match', device: 'phone', lang: 'en', turnstileToken: 'e2e-turnstile-token-row9' },
  }, 201)
  const att = await must('POST', `${API}/reports/${webReport.code}/attachments`, {
    headers: { 'X-Report-Token': webReport.reportToken },
    json: { filename: file.name, size: file.size, mime: 'video/mp4' },
  }, 201)
  const fh = await fs.open(file.path, 'r')
  const buf = Buffer.alloc(att.partSize)
  try {
    for (let n = 1; n <= att.partCount; n++) {
      const size = n < att.partCount ? att.partSize : file.size - att.partSize * (att.partCount - 1)
      await fh.read(buf, 0, size, (n - 1) * att.partSize)
      await must('PUT', `${API}/attachments/${att.attachmentId}/parts/${n}`, { headers: { 'X-Report-Token': webReport.reportToken }, body: buf.subarray(0, size) }, 200)
    }
  } finally {
    await fh.close()
  }
  await must('POST', `${API}/attachments/${att.attachmentId}/complete`, { headers: { 'X-Report-Token': webReport.reportToken } }, 200)

  const waiting = await gameReport('Row 9 waiting', 'Waiting for the AI')

  const fixReady = await gameReport('Row 9 fix ready', 'A simple fix with a PR')
  await triage(fixReady, 'simple_fix')
  await agentStatus(fixReady, { status: 'looking', prUrl: 'https://github.com/DamianStBeat/Lumina2/pull/1' })

  const byVerdict = await gameReport('Row 9 person, verdict', 'needs_person by verdict')
  await triage(byVerdict, 'needs_person')

  const byNote = await gameReport('Row 9 person, note', 'needs_person by the agent note')
  await triage(byNote, 'simple_fix')
  await agentStatus(byNote, { status: 'looking', note: 'needs_person: the simple fix did not work' })

  const dup = await gameReport('Row 9 duplicate', 'same as the waiting one')
  await deskStatus(dup, { status: 'duplicate', duplicateOf: waiting })

  const notBug = await gameReport('Row 9 not a bug', 'works as made')
  await deskStatus(notBug, { status: 'not_bug' })

  const fixed = await gameReport('Row 9 fixed', 'already fixed')
  await deskStatus(fixed, { status: 'fixed' })

  const closed = await gameReport('Row 9 closed', 'spam')
  await deskStatus(closed, { status: 'closed' })

  const want = { 'All': 9, 'Fix ready': 1, 'Needs a person': 2, 'Duplicates': 1, 'Not a bug': 1, 'Waiting for AI': 2 }

  const { page, close } = await openPage('/desk', { width: 1440, height: 900 })
  try {
    await deskSameSite(page)
    await page.reload()
    await page.locator('.desk-row').first().waitFor()

    const labels = async () =>
      Object.fromEntries((await page.locator('.filters button').allTextContents()).map((t) => {
        const m = /^(.*) · (\d+)$/.exec(t.trim())
        return [m ? m[1] : t.trim(), m ? Number(m[2]) : null]
      }))
    const got = await labels()
    for (const [label, n] of Object.entries(want)) eq(got[label], n, `tab "${label}"`)

    const line = async (code) => {
      const row = page.locator('.desk-row').filter({ has: page.locator('.c-code b', { hasText: code }) })
      return (await row.locator('.c-what .sub').textContent()).trim()
    }
    eq(await line(webReport.code), 'Video 300 MB · Phone', 'the 300 MB report’s line')
    eq(await line(waiting), 'No video', 'a report with no file')
    eq(await page.locator('.desk-row').count(), 9, 'rows on the All tab')

    await page.screenshot({ path: path.join(LOGS, 'row9-desk-1440.png'), fullPage: true })

    await page.locator('.filters button', { hasText: 'Fix ready' }).click()
    await page.waitForFunction(() => document.querySelectorAll('.desk-row').length === 1)
    eq(await page.locator('.desk-row .c-code b').textContent(), fixReady, 'the Fix ready tab')
    const after = await labels()
    for (const [label, n] of Object.entries(want)) eq(after[label], n, `tab "${label}" after a filter click`)
    return `tabs ${JSON.stringify(got)}, row "Video 300 MB · Phone", screenshot row9-desk-1440.png`
  } finally {
    await close()
  }
}

// Row 10: Tolgo un file mentre si calcola l'impronta, poi ricarico | riapro | il file resta tolto, il suo DELETE parte
// al caricamento successivo.
async function row10() {
  const file = await mid()

  // 10a: a file with an attachment on the worker, re-picked after a reload, removed while its fingerprint is held.
  const { page, close, seen } = await openPage('/')
  let saved
  try {
    await page.addInitScript(holdDigestScript)
    await page.reload()
    let allow = 2
    const held = []
    let holding = true
    await page.route(/\/attachments\/[^/]+\/parts\/\d+$/, (route) => {
      if (route.request().method() !== 'PUT' || !holding) return route.continue()
      if (allow > 0) {
        allow--
        return route.continue()
      }
      held.push(route)
      return undefined
    })
    await reportForm(page, 'Row 10: removed while its fingerprint is taken.')
    await page.setInputFiles('input[type=file]', file.path)
    await waitSendable(page)
    await gold(page).click()
    await until(() => held.length > 0, 60_000, 'an upload stopped with its attachment created')
    saved = await until(() => savedSession(page), 10_000, 'the saved session')
    const attachmentId = saved.files[0].attachmentId
    if (typeof attachmentId !== 'string') fail('no attachment id saved')
    await until(async () => (await partsOf(attachmentId, saved.reportToken)).length >= 1, 60_000, 'a part on the worker')

    holding = false
    await page.reload()
    for (const r of held) await r.abort().catch(() => {})
    await page.locator('.hint').filter({ hasText: file.name }).waitFor({ timeout: 15_000 })

    // Re-pick the same file, its fingerprint held: the row is there, the file is not yet known to be the saved one.
    await page.evaluate(() => {
      window.__digest.hold = true
    })
    await page.setInputFiles('input[type=file]', file.path)
    await until(() => page.evaluate(() => window.__digest.release !== null), 15_000, 'the fingerprint held')
    const remove = page.getByRole('button', { name: `Remove ${file.name}` })
    await remove.waitFor({ timeout: 15_000 })
    await remove.click()
    eq(seen.deletes.length, 0, 'DELETEs before the reload (the Remove waits for the fingerprint)')

    await page.reload()

    const deleted = await until(async () => (seen.deletes.length > 0 ? seen.deletes : null), 20_000, 'a DELETE after the reload')
    eq(deleted.length, 1, 'DELETE requests after the reload')
    if (!deleted[0].endsWith(`/attachments/${attachmentId}`)) fail(`DELETE went to ${deleted[0]}`)
    const after = await until(async () => {
      const r = await agentReport(saved.code)
      const a = r.attachments.find((x) => x.id === attachmentId)
      return a && a.status !== 'uploading' ? a : null
    }, 20_000, 'the attachment left uploading on the worker')
    if (!['aborted', 'deleted'].includes(after.status)) fail(`attachment status after the DELETE: ${after.status}`)

    eq(await page.locator('.file').count(), 0, 'file rows after the reload')
    eq(await page.locator('.hint').filter({ hasText: file.name }).count(), 0, 'resume hints naming the file after the reload')

    // Stopped, and also finished: another reload sends nothing more for it.
    await page.reload()
    await sleep(800)
    eq(seen.deletes.length, 1, 'DELETE requests after a further reload')
    if (seen.posts.some((p) => p.endsWith('/complete'))) fail('the removed file was completed')
  } finally {
    await close()
  }

  // 10b: a file with no attachment yet: first pick, removed while hashed, reload. Nothing may be created for it.
  const b = await openPage('/')
  try {
    await b.page.addInitScript(holdDigestScript)
    await b.page.reload()
    await reportForm(b.page, 'Row 10b.')
    await b.page.evaluate(() => {
      window.__digest.hold = true
    })
    await b.page.setInputFiles('input[type=file]', file.path)
    await until(() => b.page.evaluate(() => window.__digest.release !== null), 15_000, 'the fingerprint held (10b)')
    const remove = b.page.getByRole('button', { name: `Remove ${file.name}` })
    await remove.waitFor({ timeout: 15_000 })
    await remove.click()
    // Pressed while hashing, the row leaves when the hash answers (web/src/upload/DESIGN.md, the state table).
    await b.page.evaluate(() => window.__digest.release())
    await b.page.locator('.file').waitFor({ state: 'detached', timeout: 10_000 })
    await sleep(500)
    await b.page.reload()
    await b.page.locator('textarea').waitFor()
    eq(await b.page.locator('.file').count(), 0, 'file rows after the reload (10b)')
    eq(await savedSession(b.page), null, 'a saved session for a file that was removed before Send (10b)')
    if (b.seen.posts.some((p) => /\/attachments$|\/complete$|\/reports$/.test(p))) fail(`something was created for the removed file: ${b.seen.posts}`)
    return `DELETE ${saved.code} sent once after the reload, attachment gone, nothing resumed; 10b nothing created`
  } finally {
    await b.close()
  }
}

// ---- run -------------------------------------------------------------------------------------------------------

// Rows 4, 5 and 7: bot-rows.mjs, one process per row, against the same worker.
const execFileP = promisify(execFile)
const botRow = (n) => async () => {
  const script = fileURLToPath(new URL('./bot-rows.mjs', import.meta.url))
  try {
    const { stdout } = await execFileP(process.execPath, [script, String(n)], { env: process.env, maxBuffer: 4 * 1024 * 1024 })
    const m = /^ok (.*)$/m.exec(stdout)
    if (!m) fail(`bot-rows.mjs gave no result: ${stdout.slice(-300)}`)
    return m[1]
  } catch (e) {
    fail((e.stderr || e.message || String(e)).trim().split('\n')[0])
  }
}
const { row3, row6 } = makeAgentRows({
  API, STATE, LOGS, AGENT_KEY, must, eq, fail, until, gameReport, deskStatus, agentReport, openPage, deskSameSite,
})
const RUNNERS = { 1: row1, 2: row2, 3: row3, 4: botRow(4), 5: botRow(5), 6: row6, 7: botRow(7), 8: row8, 9: row9, 10: row10 }
// Row 9 first: its tabs count what it seeded, so reports from other rows must not be there yet (the D1 of a run starts
// empty). The agent and bot rows last: rows 3 and 6 close what is still `received` before each round.
const ORDER = [9, 1, 2, 8, 10, 3, 6, 4, 5, 7].filter((r) => ROWS.includes(r))

const results = new Map()
const ROW_MS = 480_000
for (const r of ORDER) {
  let line
  try {
    const note = await Promise.race([
      RUNNERS[r](),
      sleep(ROW_MS).then(() => fail(`row ${r} ran longer than ${ROW_MS / 1000} s`)),
    ])
    line = `row ${r} PASS ${note}`
    results.set(r, true)
  } catch (e) {
    const first = String(e?.message ?? e).split('\n')[0]
    line = `row ${r} FAIL ${first}`
    results.set(r, false)
    await fs.writeFile(path.join(LOGS, `row${r}-error.txt`), String(e?.stack ?? e)).catch(() => {})
  }
  console.log(line)
}

await browser.close().catch(() => {})

const passed = [...results.values()].filter(Boolean).length
const verify = await must('GET', `${env.E2E_SITEVERIFY}/hits`, {}, 200).catch((e) => ({ hits: -1, refused: `unknown (${e.message})` }))
const orderLine = ROWS.toSorted((a, b) => a - b).map((r) => `${r} ${results.get(r) ? 'PASS' : 'FAIL'}`).join(', ')
console.log(`summary: ${passed}/${results.size} rows passed: ${orderLine}`)
console.log(`browser requests outside localhost (aborted): ${outside}${outside ? ` — ${outsideUrls.slice(0, 20).join(', ')}` : ''}`)
console.log(`fake siteverify: ${JSON.stringify(verify)}`)

process.exit(passed === results.size && results.size === ROWS.length && outside === 0 ? 0 : 1)
