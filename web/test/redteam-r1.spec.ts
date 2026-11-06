// bp-web-upload red team round 1 (redteam-opus.md, redteam-astra.md), on useUpload against the fake worker and an
// in-memory sessionStorage (tests-commit 11). Both are Removes pressed while a Send is going, which the page cannot
// reach (FilePicker hides Remove while the phase is uploading), so they are pressed through the hook, as
// queue-races.spec.ts does. 1 (Opus, queue.ts:396): a file removed while its create is out, then the page closed, is
// never asked for again on the next visit, the rest of the upload still reaches done, and an attachment the create got
// on the server is DELETEd. 2 (Astra, queue.ts:316): a Remove stops that file's upload at once, even while another
// file's DELETE is out, so a video the player removed is never completed into the report. A reload is an unmount
// followed by a new mount: nothing survives it but sessionStorage and the server.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSession } from '../src/upload/session'
import { useUpload } from '../src/upload/useUpload'
import {
  CONTRACT_PART_SIZE as PART,
  FakeServer,
  MiB,
  deferred,
  drive,
  file,
  flush,
  installStorage,
  useFakeClock,
  type Fault,
} from './helpers'

const CODE = 'LUM-482193'
let server: FakeServer
let store: Storage

beforeEach(() => {
  useFakeClock()
  store = installStorage()
  server = new FakeServer().install()
})
afterEach(() => {
  vi.useRealTimers()
})

type Hook = ReturnType<typeof mount>
function mount() {
  return renderHook(() => useUpload())
}
const never = () => new Promise<void>(() => {})
const deletesOf = (id: string) => server.log.filter((r) => r.method === 'DELETE' && r.path.endsWith(`/attachments/${id}`))
const completesOf = (id: string) => server.requests('POST', `/attachments/${id}/complete`)
const creates = () => server.requests('POST', `/reports/${CODE}/attachments`)
const attOf = (name: string) => server.attsOf(CODE).find((a) => a.filename === name)
const live = () => server.attsOf(CODE).filter((a) => a.status !== 'aborted').map((a) => [a.filename, a.status])
const line = (name: string) => loadSession()?.files.find((f) => f.name === name)
const names = (h: Hook) => h.result.current.files.map((f) => f.name)
const keyOf = (h: Hook, name: string) => h.result.current.files.find((f) => f.name === name)!.key
const missing = (h: Hook) => h.result.current.resume?.missing.map((m) => m.name)
const small = (name: string) => file(name, 2 * MiB, 'video/mp4')
// Two parts each, other bytes: part 1 can be stored on a first visit and part 2 held.
const vidA = () => file('a.mp4', 2 * PART, 'video/mp4', 1000, { seed: 41 })
const vidB = () => file('b.mp4', 2 * PART, 'video/mp4', 1000, { seed: 42 })

// Lets every pending chain run without moving the clock, the hashing of a pick included.
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await flush()
      await new Promise<void>((r) => setImmediate(r))
    }
  })
}
async function pick(h: Hook, files: File[]): Promise<void> {
  await act(async () => {
    await Promise.resolve(h.result.current.addFiles(files))
  })
  await settle()
}
// Moves the clock (a minute by default), so every retry, backoff and late answer the last action set going has its turn.
async function letRun(ms = 60_000): Promise<void> {
  await act(async () => {
    await drive(new Promise<void>((r) => setTimeout(r, ms)))
  })
  await settle()
}
function startOn(h: Hook, token: string): Promise<boolean> {
  let p!: Promise<boolean>
  act(() => {
    p = h.result.current.start({ code: CODE, reportToken: token })
  })
  return p
}
function removeOn(h: Hook, name: string): Promise<void> {
  let p!: Promise<void>
  act(() => {
    p = h.result.current.removeFile(keyOf(h, name))
  })
  return p
}
function abortError(): Error {
  const e = new Error('The operation was aborted.')
  e.name = 'AbortError'
  return e
}

// The create of `name` reaches the server and the attachment is made there, but its answer is held on the way back
// until `gate` opens, as on a slow phone network: a request aborted meanwhile loses the answer, never the attachment.
function holdCreateAnswer(name: string, gate: Promise<void>): void {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const isCreate =
      (init.method ?? 'GET').toUpperCase() === 'POST' &&
      /\/reports\/[^/]+\/attachments$/.test(url) &&
      (JSON.parse(String(init.body)) as { filename?: string }).filename === name
    if (!isCreate) return server.fetch(input, init)
    const { signal, ...rest } = init
    const answer = await server.fetch(input, rest)
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(abortError())
      signal?.addEventListener('abort', () => reject(abortError()), { once: true })
      void gate.then(() => (signal?.aborted ? reject(abortError()) : resolve()))
    })
    return answer
  })
}

// Sends a.mp4 then b.mp4 (one at a time, so a.mp4's create is the one out), Removes a.mp4 while that create is held
// unless `remove` is false, and closes the page before the create answers. `hold` holds the create: before the
// server sees it ('request') or after the server made the attachment ('answer'). `writes`: sessionStorage writes from
// the close until the next visit (lead's decision, tests-commit 12: the late create answer writes nothing).
async function closedWhileCreating(hold: 'request' | 'answer', remove = true) {
  const token = server.addReport(CODE)
  const gate = deferred()
  if (hold === 'request') server.holdCreate = gate.promise
  else holdCreateAnswer('a.mp4', gate.promise)
  const h = mount()
  await pick(h, [small('a.mp4'), small('b.mp4')])
  expect(names(h)).toEqual(['a.mp4', 'b.mp4'])
  const sent = startOn(h, token)
  await settle()
  expect(creates()).toHaveLength(1)
  expect(attOf('a.mp4')?.status).toBe(hold === 'answer' ? 'uploading' : undefined)
  expect(h.result.current.phase).toBe('uploading')
  if (remove) {
    void removeOn(h, 'a.mp4')
    await settle()
  }
  const saved = structuredClone(loadSession())
  const setItem = vi.spyOn(store, 'setItem')
  const removeItem = vi.spyOn(store, 'removeItem')
  h.unmount()
  gate.resolve()
  server.holdCreate = null
  await act(async () => {
    await drive(sent)
  })
  await letRun()
  const writes = setItem.mock.calls.length + removeItem.mock.calls.length
  setItem.mockRestore()
  removeItem.mockRestore()
  expect(loadSession()).toEqual(saved)
  // Back to the plain fake for the next visit.
  server.install()
  return { token, a: attOf('a.mp4'), writes }
}

// The next visit (any DELETE it sends again answered), and the rest sent from it: b.mp4 picked again and sent, which
// must end on "We have it" (phase done).
async function reopen(): Promise<Hook> {
  const h2 = mount()
  await settle()
  await letRun()
  return h2
}
async function sendTheRest(h2: Hook, token: string): Promise<boolean> {
  await pick(h2, [small('b.mp4')])
  const sent = startOn(h2, token)
  let ok = false
  await act(async () => {
    ok = await drive(sent)
  })
  await letRun()
  return ok
}

describe('red team r1, finding 1 (Opus, queue.ts:396): Remove while the create is out, then the page closed', () => {
  // Lead's decision (tests-commit 12): after the close a removed file's create is not aborted; when it answers, its
  // attachment gets exactly one DELETE and nothing else is written.
  it('finding 1: the create held before the server, the page closed: it is not aborted, its attachment reaches the server and gets exactly one DELETE, nothing is written to storage after the close, on reopen a.mp4 is not asked for again, and sending b.mp4 reaches done', async () => {
    const { token, a, writes } = await closedWhileCreating('request')
    expect(creates()[0]!.reached).toBe(true)
    expect(a).toBeDefined()
    expect(deletesOf(a!.id)).toHaveLength(1)
    expect(a!.status).toBe('aborted')
    expect(writes).toBe(0)
    const h2 = await reopen()
    expect(missing(h2)).toEqual(['b.mp4'])
    expect(line('a.mp4')).toBeUndefined()

    expect(await sendTheRest(h2, token)).toBe(true)
    expect(h2.result.current.phase).toBe('done')
    expect(names(h2)).toEqual(['b.mp4'])
    expect(live()).toEqual([['b.mp4', 'complete']])
    expect(deletesOf(a!.id)).toHaveLength(1)
    expect(completesOf(a!.id)).toEqual([])
    expect(server.puts(a!.id)).toEqual([])
    expect(h2.result.current.resume).toBeNull()
    expect(loadSession()).toBeNull()
  })

  it('finding 1: the create reached the server and its answer was lost to the close: that attachment gets a DELETE (on the closed page or on reopen), a.mp4 is not asked for again, and sending b.mp4 reaches done', async () => {
    const { token, a, writes } = await closedWhileCreating('answer')
    expect(a).toBeDefined()
    expect(writes).toBe(0)
    const h2 = await reopen()
    // It would hold one of the 3 places of the report, for a video the player removed.
    expect(deletesOf(a!.id)).toHaveLength(1)
    expect(a!.status).toBe('aborted')
    expect(missing(h2)).toEqual(['b.mp4'])

    expect(await sendTheRest(h2, token)).toBe(true)
    expect(h2.result.current.phase).toBe('done')
    expect(live()).toEqual([['b.mp4', 'complete']])
    expect(completesOf(a!.id)).toEqual([])
    expect(deletesOf(a!.id)).toHaveLength(1)
    expect(h2.result.current.resume).toBeNull()
    expect(loadSession()).toBeNull()
  })

  it('finding 1, the other side: not removed, the page closed while the create is out: that create is aborted (no attachment made), and on reopen both files are asked for again', async () => {
    const { a, writes } = await closedWhileCreating('request', false)
    expect(creates()[0]!.reached).toBe(false)
    expect(a).toBeUndefined()
    expect(writes).toBe(0)
    const h2 = await reopen()
    expect(missing(h2)).toEqual(['a.mp4', 'b.mp4'])
  })
})

describe('red team r1, finding 2 (Astra, queue.ts:316): a Remove stops the upload at once, never behind another DELETE', () => {
  // Leaves a first upload of `f` at part 1 (part 2 held for ever) and closes the page: its attachment and saved line
  // exist on the next visit, open, with one part stored.
  async function leaveHalfWay(token: string, f: () => File) {
    server.holdPart = (_id, n) => (n > 1 ? never() : null)
    const h = mount()
    await pick(h, [f()])
    const sent = startOn(h, token)
    const att = () => attOf(f().name)
    for (let i = 0; i < 20 && att()?.parts.size !== 1; i++) await settle()
    h.unmount()
    await act(async () => {
      await drive(sent)
    })
    server.holdPart = () => null
    expect([...att()!.parts.keys()]).toEqual([1])
    return att()!
  }

  // Two visits that each left a video half way (b.mp4 first, then a.mp4 on the same report), then a third that picks
  // both again: each binds to its own attachment. a.mp4's part 2 is held in flight when this returns, B's DELETE is
  // held until released, and A's DELETE answers `faultA`.
  async function resumedBoth(faultA: Fault) {
    const token = server.addReport(CODE)
    const B = await leaveHalfWay(token, vidB)
    const A = await leaveHalfWay(token, vidA)
    expect(loadSession()?.files.map((f) => [f.name, f.attachmentId])).toEqual([
      ['b.mp4', B.id],
      ['a.mp4', A.id],
    ])
    const h = mount()
    await pick(h, [vidA(), vidB()])
    expect(names(h)).toEqual(['a.mp4', 'b.mp4'])
    expect(missing(h)).toEqual([])

    const parts = deferred()
    server.holdPart = (id) => (id === A.id ? parts.promise : null)
    const slowB = deferred()
    server.holdRoute = (m, p) => (m === 'DELETE' && p === `/attachments/${B.id}` ? slowB.promise : null)
    server.routeFault = (m, p) => (m === 'DELETE' && p === `/attachments/${A.id}` ? faultA : null)
    const mark = server.log.length
    const sent = startOn(h, token)
    const held = () => server.puts(A.id).filter((r) => server.log.indexOf(r) >= mark)
    for (let i = 0; i < 20 && held().length === 0; i++) await settle()
    expect(held().map((r) => r.n)).toEqual([2])
    expect(h.result.current.phase).toBe('uploading')
    return { h, A, B, held: held(), parts, slowB, sent }
  }

  const answers: [string, Fault][] = [
    ['200 { ok: true }', 'ok'],
    ['503', { status: 503 }],
  ]
  it.each(answers)(
    'finding 2: uploading A, Remove B with its DELETE held, then Remove A (its DELETE answers %s): A part in flight is cancelled and A is never completed, then both end removed or A marked holding its place',
    async (_label, faultA) => {
      const { h, A, B, held, parts, slowB, sent } = await resumedBoth(faultA)
      const removedB = removeOn(h, 'b.mp4')
      await settle()
      expect(deletesOf(B.id)).toHaveLength(1)
      const removedA = removeOn(h, 'a.mp4')
      await settle()

      // A's part is answered now, B's DELETE still out: had A's Remove waited behind it, A would be completed.
      parts.resolve()
      await letRun(5_000)
      expect(held.map((r) => r.reached)).toEqual([false])
      expect([...A.parts.keys()]).toEqual([1])
      expect(completesOf(A.id)).toEqual([])
      expect(A.status).not.toBe('complete')

      slowB.resolve()
      server.holdRoute = () => null
      await act(async () => {
        await drive(Promise.all([removedB, removedA, sent]))
      })
      await letRun()
      expect(B.status).toBe('aborted')
      expect(completesOf(A.id)).toEqual([])
      expect(completesOf(B.id)).toEqual([])
      expect(deletesOf(A.id).length).toBeGreaterThan(0)
      expect(line('b.mp4')).toBeUndefined()
      if (faultA === 'ok') {
        expect(A.status).toBe('aborted')
        expect(names(h)).toEqual([])
        expect(h.result.current.unremoved).toBe(false)
        expect(line('a.mp4')).toBeUndefined()
      } else {
        // Not let go by the server: A holds its place, the orange line, its line marked for the next load.
        expect(A.status).toBe('uploading')
        expect(names(h)).toEqual(['a.mp4'])
        expect(h.result.current.unremoved).toBe(true)
        expect(line('a.mp4')).toMatchObject({ attachmentId: A.id, removing: true })
        expect(missing(h) ?? []).not.toContain('a.mp4')
      }
    },
  )

  it('finding 2, the other side: uploading A, Remove B with its DELETE held, A not removed: A is stored and completed into the report', async () => {
    const { h, A, B, held, parts, slowB, sent } = await resumedBoth('ok')
    const removedB = removeOn(h, 'b.mp4')
    await settle()
    parts.resolve()
    slowB.resolve()
    server.holdRoute = () => null
    let ok = false
    await act(async () => {
      ;[, ok] = await drive(Promise.all([removedB, sent]))
    })
    await letRun()
    expect(held.map((r) => r.reached)).toEqual([true])
    expect(A.status).toBe('complete')
    expect(B.status).toBe('aborted')
    expect(ok).toBe(true)
    expect(names(h)).toEqual(['a.mp4'])
  })
})
