// Rows 4, 5 and 7: the real bot classes (bot/src: EventPoller, handleBugModalSubmit, PortalApi), pointed at the real
// local worker, driven by the fake Discord of bot/test/fakes. One row per process (`node bot-rows.mjs <row>`), started by
// harness.mjs: a row's forum, cursor and limiter state cannot leak into another row, and its memory is its own line in
// the RSS table. It prints one line, `ok <note>`, or exits 1 with the reason.
// bot/src/main.ts itself is not imported: it logs in to Discord when it loads. The two lines of its Discord seam
// (createForumPost, sendToThread) are redone here against the fake forum.
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { handleBugModalSubmit } from '../bot/src/bugCommand.ts'
import { CursorStore, EventPoller } from '../bot/src/events.ts'
import { PortalApi } from '../bot/src/portal.ts'
import { fakeCdn } from '../bot/test/fakes/cdn.ts'
import { cdnUrl, FakeForum, makeUser, modalInteraction, readMessage, visibleText } from '../bot/test/fakes/discord.ts'
import { makeConfig, makeLogger, makeTempDir, removeDir } from '../bot/test/fakes/common.ts'

const env = process.env
const WORKER = env.E2E_WORKER_ORIGIN
const API = `${WORKER}/api/v1`
const GAME_KEY = env.E2E_GAME_KEY
const AGENT_KEY = env.E2E_AGENT_KEY
const row = Number(process.argv[2])

async function call(method, url, opts = {}) {
  const init = { method, headers: { ...(opts.headers ?? {}) } }
  if (opts.json !== undefined) {
    init.headers['Content-Type'] = 'application/json'
    init.body = JSON.stringify(opts.json)
  }
  const res = await fetch(url, init)
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON: the status check of the caller reports it.
  }
  return { status: res.status, body, text }
}
async function must(method, url, opts, want) {
  const r = await call(method, url, opts)
  assert.equal(r.status, want, `${method} ${url}: ${r.text.slice(0, 200)}`)
  return r.body
}

const agent = { Authorization: `Bearer ${AGENT_KEY}` }
const game = { 'X-Game-Key': GAME_KEY }
let nextUser = 880000 + row * 1000 // Their own ids: game create is rate limited per user.
const gameReport = async (title, what, context = { map: 'Bridge', wave: 12 }) =>
  (await must('POST', `${API}/game/reports`, { headers: game, json: { userId: nextUser++, userName: 'e2e', title, what, lang: 'en', context } }, 201)).code
const deskStatus = (code, body) => must('POST', `${API}/desk/reports/${code}/status`, { json: body }, 200)
const report = (code) => must('GET', `${API}/agent/reports/${code}`, { headers: agent }, 200)
async function head() {
  // The stream's end now: walked, as a page is capped at 500 and earlier rows left events behind.
  let after = 0
  for (;;) {
    const page = await must('GET', `${API}/agent/events?after=${after}&limit=500`, { headers: agent }, 200)
    if (page.events.length === 0) return after
    after = page.last
  }
}
async function eventsSince(after) {
  const out = []
  for (let a = after; ; ) {
    const page = await must('GET', `${API}/agent/events?after=${a}&limit=500`, { headers: agent }, 200)
    if (page.events.length === 0) return out
    out.push(...page.events)
    a = page.last
  }
}

const api = new PortalApi({ base: API, agentKey: AGENT_KEY, timeoutMs: 15_000 })
const stateDir = await makeTempDir('lumina-bot-e2e-') // run.sh's TMPDIR is inside the run's temp folder
const config = makeConfig(API, stateDir)
const log = makeLogger()

/** A poller already running (its cursor at the stream's end now): earlier rows' events are history, not this row's. */
async function runningPoller(forum) {
  const store = new CursorStore(path.join(stateDir, `cursor-${row}`))
  await store.write(await head())
  const discord = {
    sendToThread: async (threadId, message) => {
      const t = forum.created.find((x) => x.id === threadId)
      if (!t) throw new Error(`no thread ${threadId} in the fake forum`)
      return t.send(message)
    },
    createForumPost: async (forumId, post) => {
      assert.equal(forumId, forum.id, 'the forum configured for the bot')
      return (await forum.threads.create(post)).id
    },
  }
  return new EventPoller({ api, store, discord, config, log })
}

// Row 4: Report dal gioco (POST /game/reports con X-Game-Key) | giro del bot | nuovo post "Bug report: …" nel forum
// finto, link registrato.
async function row4() {
  const forum = new FakeForum()
  const poller = await runningPoller(forum)
  const title = 'Boss stops on the bridge'
  const what = 'The boss stopped on the bridge and the wave never ended.'
  const code = await gameReport(title, what)
  // The report is there and not linked yet: "no thread" is what the row starts from.
  assert.equal((await report(code)).discord_thread_id, null, 'link before the bot')
  await poller.tick()
  assert.equal(forum.createCalls.length, 1, 'posts in the forum after one round')
  assert.equal(forum.createCalls[0].name, `Bug report: ${title}`, 'post title')
  const body = readMessage(forum.createCalls[0].message).content ?? ''
  assert.ok(body.includes(what), `post text: ${body.slice(0, 120)}`)
  assert.ok(body.includes('"map": "Bridge"'), `the game context is in the post: ${body.slice(0, 200)}`)
  const threadId = forum.created[0].id
  assert.equal((await report(code)).discord_thread_id, threadId, 'link on the worker')
  await poller.tick()
  assert.equal(forum.createCalls.length, 1, 'posts after a second round')
  return `${code} posted as "${forum.createCalls[0].name}", thread ${threadId} linked on the worker, one post after two rounds`
}

// Row 5: `/bug` dal Discord finto con un'immagine | invio | report creato, immagine nell'archivio, risposta effimera col
// codice.
async function row5() {
  const forum = new FakeForum()
  const pngFile = path.join(stateDir, 'row5.png')
  execFileSync('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=200x120', '-frames:v', '1', pngFile])
  // A real PNG, padded past one 16 MiB part (the trailer is ignored by every image reader), so the copy goes through
  // the worker's multipart path with a full part and a short last part, as a real large screenshot does.
  const png = Buffer.concat([await fs.readFile(pngFile), randomBytes(17 * 1024 * 1024)])
  const hash = (b) => createHash('sha256').update(b).digest('hex')
  const file = { id: '1450000000000000001', name: 'boss-stuck.png', size: png.length, contentType: 'image/png' } // over 10 MiB: not re-posted, archive only
  const url = cdnUrl(file)
  const deps = { api, config, log, fetchImpl: fakeCdn({ [url]: new Uint8Array(png) }).fetchImpl }

  const what = 'The boss stopped on the bridge, here is a picture.'
  const i = modalInteraction({ user: makeUser('450000000000000011', 'skyler_77'), forum, what, where: 'Match', file })
  await handleBugModalSubmit(i, deps)
  const answer = i.finalAnswer()
  assert.ok(answer, 'the player got an answer')
  assert.equal(answer.ephemeral, true, 'the answer is ephemeral')
  const shown = visibleText(answer.options)
  const code = /LUM-\d{6}/.exec(shown)?.[0]
  assert.ok(code, `no code in the answer: ${shown.slice(0, 160)}`)

  const r = await report(code)
  assert.equal(r.source, 'discord', 'report source')
  assert.equal(r.what, what, 'report text')
  assert.equal(r.where_area, 'match', 'the typed place, mapped')
  assert.equal(r.discord_thread_id, forum.created[0]?.id, 'the post made for the report is linked')
  const image = r.attachments.filter((a) => a.kind === 'image')
  assert.equal(image.length, 1, 'images in the archive')
  assert.equal(image[0].status, 'complete', 'image status')
  assert.equal(image[0].mime, 'image/png', 'image mime')
  assert.equal(image[0].size_bytes, png.length, 'image size')
  const res = await fetch(`${API}/agent/attachments/${image[0].id}/download`, { headers: agent })
  assert.equal(res.status, 200, 'download of the archived image')
  const archived = Buffer.from(await res.arrayBuffer())
  assert.equal(hash(archived), hash(png), 'sha256 of the archived image')

  // Nothing attached is not a failed attachment: the report and the code, no file on the worker.
  const none = modalInteraction({ user: makeUser('450000000000000012', 'skyler_78'), forum, what: 'No picture this time.', where: '' })
  await handleBugModalSubmit(none, deps)
  const noneAnswer = none.finalAnswer()
  assert.equal(noneAnswer?.ephemeral, true, 'no file: the answer is ephemeral')
  const noneCode = /LUM-\d{6}/.exec(visibleText(noneAnswer.options))?.[0]
  assert.ok(noneCode, 'no file: the code')
  assert.equal((await report(noneCode)).attachments.length, 0, 'no file: nothing in the archive')
  return `${code}: image sha256 ${hash(archived).slice(0, 12)}… in the archive, answer ephemeral with the code; no-file report ${noneCode} has no attachment`
}

// Row 7: Report segnato `fixed` | giro eventi del bot | embed verde nel thread giusto, una volta sola.
async function row7() {
  const forum = new FakeForum()
  const poller = await runningPoller(forum)
  const a = await gameReport('Row 7 the fixed one', 'The one that gets fixed.')
  const b = await gameReport('Row 7 another', 'Another thread, which must stay quiet.')
  await poller.tick()
  assert.equal(forum.created.length, 2, 'two forum posts first')
  const ra = await report(a)
  const rb = await report(b)
  const tA = forum.created.find((t) => t.id === ra.discord_thread_id)
  const tB = forum.created.find((t) => t.id === rb.discord_thread_id)
  assert.ok(tA && tB && tA !== tB, 'each report has its own thread')

  const before = await head()
  await deskStatus(a, { status: 'fixed' })
  await poller.tick()
  assert.equal(tA.sent.length, 1, 'messages in the right thread after the round')
  const msg = readMessage(tA.sent[0])
  assert.equal(msg.embeds[0]?.color, 0x5be08e, 'the embed is green')
  assert.ok((msg.embeds[0]?.title ?? '').startsWith(`Fixed · ${a}`), `embed title: ${msg.embeds[0]?.title}`)
  assert.equal(tB.sent.length, 0, 'the other thread stays quiet')

  await poller.tick()
  assert.equal(tA.sent.length, 1, 'a second round adds no message')

  // A person presses Fixed again: the worker writes the event (from = to), and the bot must not tell the player twice.
  await deskStatus(a, { status: 'fixed' })
  const resend = (await eventsSince(before)).filter((e) => e.code === a && e.type === 'status_changed').at(-1)
  assert.equal(resend?.data?.from, 'fixed', 'the resend is on the event list (from)')
  assert.equal(resend?.data?.to, 'fixed', 'the resend is on the event list (to)')
  await poller.tick()
  assert.equal(tA.sent.length, 1, 'a fixed→fixed resend adds no message')
  assert.equal(tB.sent.length, 0, 'the other thread still quiet')
  return `${a}: one green embed in thread ${tA.id} after three rounds; ${b}: nothing in thread ${tB.id}; fixed→fixed added none`
}

const ROWS = { 4: row4, 5: row5, 7: row7 }

try {
  const note = await ROWS[row]()
  console.log(`ok ${note}`)
} catch (e) {
  const first = String(e?.message ?? e).split('\n')[0]
  console.error(first)
  process.exitCode = 1
} finally {
  await removeDir(stateDir)
}
