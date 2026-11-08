// bp-integration stage 5a, red team round 1 (redteam-astra.md, useUpload.ts:164), on useUpload against the fake worker
// and an in-memory sessionStorage, as queue-reload.spec.ts (a reload is an unmount and a new mount: nothing survives it
// but sessionStorage and the server, and the old tab's DELETE is never answered there).
// Lead's decision 2 (brief 5a): a late create no page can take writes its marked line (with its id) to storage BEFORE
// its DELETE leaves, only into a stored session of the same code and token, or into empty storage, as `adoptInto` does.
// When the DELETE answers gone the line is taken out again, only from a stored session of the same code and token,
// nothing else in it changed. Another report's session is never touched (row 2 of queue-races).
//
// Run by filter: `cd web && npx vitest run test/queue-reload-3.spec.ts test/redteam-r1.spec.ts`.
//
// Mutations (file|old|new|label), the builder's lines described as in contract.spec.ts until they exist:
// web/src/upload/useUpload.ts (builder)|the line saved before `gone` is called|saved only when the DELETE fails (= 312f690)|Astra, empty storage
// web/src/upload/useUpload.ts (builder)|the line saved before `gone` is called|saved right after `gone` is called|Astra (written before the DELETE leaves)
// web/src/upload/useUpload.ts (builder)|the line taken out when the DELETE is gone|left there|gone, redteam-r1 finding 1
// web/src/upload/useUpload.ts (builder)|gone leaves the line when not gone|taken out on any answer|not gone
// web/src/upload/useUpload.ts (builder)|the same code and token test on the write|any stored session|another report's session
// web/src/upload/useUpload.ts (builder)|the same code and token test on the take-out|any stored session|saved over meanwhile
// web/src/upload/useUpload.ts (builder)|the id-less mark of the close comes back with the take-out|the whole line dropped|redteam-r1 finding 1
// web/src/upload/useUpload.ts (builder)|only that line changes on the take-out|the session as read before the write put back|newer state of the same report
import { act, cleanup, renderHook } from '@testing-library/react'
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
const OTHER = 'LUM-482194'
const THIRD = 'LUM-482195'
const KEY = 'lumina-bug-upload'
let server: FakeServer
let storage: Storage

beforeEach(() => {
  useFakeClock()
  storage = installStorage()
  server = new FakeServer().install()
})
afterEach(() => {
  // Before the clock goes back: a mounted page is the module's owner, and must not outlive its case.
  cleanup()
  vi.useRealTimers()
})

type Hook = ReturnType<typeof mount>
function mount(only?: string) {
  return renderHook(() => useUpload(only))
}
type Line = { name: string; size: number; attachmentId: string | null; done: boolean; removing?: unknown }
type Saved = { code: string; reportToken: string; files: Line[]; pending?: unknown }
const saved = () => loadSession() as Saved | null
const never = () => new Promise<void>(() => {})
const deletes = () => server.log.filter((r) => r.method === 'DELETE')
const deletedIds = () => deletes().map((r) => r.path.replace(/^.*\/attachments\//, ''))
const line = (name: string) => saved()?.files.find((f) => f.name === name)
const keyOf = (h: Hook, name: string) => h.result.current.files.find((f) => f.name === name)!.key
const small = (name: string) => file(name, 2 * MiB, 'video/mp4')
const createPath = `/reports/${CODE}/attachments`
const made = (name: string) => server.attsOf(CODE).find((a) => a.filename === name)!
// A line of a stored string (what storage held at a given moment); undefined when that string holds no such line.
const lineIn = (raw: string | null | undefined, name: string) =>
  raw ? (JSON.parse(raw) as Saved).files.find((f) => f.name === name) : undefined

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
// Moves the clock (a minute by default), so every retry and late answer the last action set going has its turn.
async function letRun(ms = 60_000): Promise<void> {
  await act(async () => {
    await drive(new Promise<void>((r) => setTimeout(r, ms)))
  })
  await settle()
}
function remove(h: Hook, name: string): void {
  act(() => {
    void h.result.current.removeFile(keyOf(h, name))
  })
}
function send(h: Hook, token: string, code = CODE): Promise<boolean> {
  let p!: Promise<boolean>
  act(() => {
    p = h.result.current.start({ code, reportToken: token })
  })
  return p
}

// A visit whose a.mp4 was Removed while its create was out (held by the server), the other files saved with it.
async function removedWhileCreating(files: File[] = [small('a.mp4'), small('b.mp4')], token = server.addReport(CODE)) {
  const create = deferred()
  let first = true
  server.holdRoute = (m, p) => {
    if (m !== 'POST' || p !== createPath || !first) return null
    first = false
    return create.promise
  }
  const h = mount()
  await pick(h, files)
  void send(h, token)
  await settle()
  expect(server.requests('POST', createPath)).toHaveLength(1)
  expect(made('a.mp4')).toBeUndefined()
  remove(h, 'a.mp4')
  await settle()
  expect(line('a.mp4')).toMatchObject({ attachmentId: null, removing: true })
  return { token, h, answer: () => create.resolve() }
}

// DELETEs wait for `answer`; each records what storage held when it left, so "before the DELETE" is seen, not assumed.
function holdDeletes(answer: Promise<void>): (string | null)[] {
  const atRequest: (string | null)[] = []
  server.holdRoute = (m) => {
    if (m !== 'DELETE') return null
    atRequest.push(storage.getItem(KEY))
    return answer
  }
  return atRequest
}
const answerDeletes = (fault: Fault) => {
  server.routeFault = (m) => (m === 'DELETE' ? fault : null)
}

// A visit to `code` that had one file of 2 parts going, then was left: storage holds that upload.
async function uploadOf(code: string, token: string, name: string): Promise<void> {
  server.holdPart = (id, n) => (server.atts.get(id)?.filename === name && n > 1 ? never() : null)
  const h = mount(code)
  await pick(h, [file(name, 2 * PART)])
  const p = send(h, token, code)
  for (let i = 0; i < 20 && server.attsOf(code).find((a) => a.filename === name)?.parts.size !== 1; i++) await settle()
  h.unmount()
  await act(async () => {
    await drive(p)
  })
  server.holdPart = () => null
}

// Another report's upload runs to the end: its finish clears storage, so a late create answering now finds it empty.
async function storageEmptied(): Promise<void> {
  const h = mount(THIRD)
  await pick(h, [small('third.mp4')])
  const p = send(h, server.addReport(THIRD), THIRD)
  await act(async () => {
    await drive(p)
  })
  await letRun()
  h.unmount()
  expect(loadSession()).toBeNull()
}

// No page able to take the late create: none at all, or one whose `only` hides the report saved in storage.
const noPage: [string, boolean][] = [
  ['no page open', false],
  ['a page open on another report', true],
]

describe('Astra useUpload.ts:164: a late create no page can take is written down before its DELETE', () => {
  it.each(noPage)(
    'Remove during the create, leave (%s), the create answers, reload with the DELETE unanswered: the line with its id was stored before the DELETE left, the next load has it and sends the DELETE, and b.mp4 is still asked for',
    async (_label, open) => {
      const { h, answer } = await removedWhileCreating()
      h.unmount()
      const page = open ? mount(OTHER) : undefined
      await settle()
      const atRequest = holdDeletes(never())

      answer()
      await letRun(1_000)
      const a = made('a.mp4')
      expect(deletedIds()).toEqual([a.id])
      expect(atRequest).toHaveLength(1)
      expect(lineIn(atRequest[0], 'a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })
      expect(line('a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })

      // The reload: the old tab and its unanswered DELETE are gone, only storage is left.
      page?.unmount()
      server.holdRoute = () => null
      const h2 = mount()
      await letRun()
      expect(deletedIds()).toEqual([a.id, a.id])
      expect(a.status).toBe('aborted')
      expect(line('a.mp4')).toBeUndefined()
      expect(h2.result.current.resume).toEqual({ code: CODE, missing: [{ name: 'b.mp4', size: 2 * MiB }] })
    },
  )

  it('empty storage (another report\'s upload finished meanwhile and cleared it): the same reload finds the line, sends the DELETE and asks for nothing', async () => {
    const { h, answer } = await removedWhileCreating([small('a.mp4')])
    h.unmount()
    await storageEmptied()
    const atRequest = holdDeletes(never())

    answer()
    await letRun(1_000)
    const a = made('a.mp4')
    expect(deletedIds()).toEqual([a.id])
    expect(atRequest).toHaveLength(1)
    expect(lineIn(atRequest[0], 'a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })
    expect(saved()?.code).toBe(CODE)

    server.holdRoute = () => null
    const h2 = mount()
    await letRun()
    expect(deletedIds()).toEqual([a.id, a.id])
    expect(a.status).toBe('aborted')
    expect(h2.result.current.resume).toBeNull()
    expect(saved()?.files ?? []).toEqual([])
  })

  const goneAnswers: [string, Fault][] = [
    ['200 { ok: true }', 'ok'],
    ['404, already gone', { status: 404, error: 'not_found' }],
  ]
  it.each(goneAnswers)(
    'the DELETE answers %s: the line with its id is out, and the next load sends nothing again and still asks for b.mp4',
    async (_label, fault) => {
      const { h, answer } = await removedWhileCreating()
      const atClose = saved()!
      h.unmount()
      const gate = deferred()
      holdDeletes(gate.promise)
      answerDeletes(fault)

      answer()
      await letRun(1_000)
      const a = made('a.mp4')
      expect(line('a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })
      gate.resolve()
      await letRun()

      expect(deletedIds()).toEqual([a.id])
      expect(saved()?.files.some((f) => f.attachmentId === a.id)).toBe(false)
      // Nothing else in the session changed: its report, its token and b.mp4's line are those of the close.
      expect({ ...saved(), files: saved()?.files.filter((f) => f.name !== 'a.mp4') }).toEqual({
        ...atClose,
        files: atClose.files.filter((f) => f.name !== 'a.mp4'),
      })

      server.holdRoute = () => null
      server.routeFault = () => null
      const h2 = mount()
      await letRun()
      expect(deletedIds()).toEqual([a.id])
      expect(h2.result.current.resume).toEqual({ code: CODE, missing: [{ name: 'b.mp4', size: 2 * MiB }] })
    },
  )

  it('a page of the same report saved newer state while the DELETE was out (b.mp4 got its attachment), then the DELETE answers gone: b.mp4 keeps what that page saved, the take-out changes nothing else', async () => {
    const big = (name: string) => file(name, 2 * PART, 'video/mp4', 1000, { seed: 31 })
    const { token, h, answer } = await removedWhileCreating([small('a.mp4'), big('b.mp4')])
    h.unmount()
    const gate = deferred()
    let held = 0
    server.holdRoute = (m) => (m === 'DELETE' && ++held === 1 ? gate.promise : null)
    answer()
    await letRun(1_000)
    const a = made('a.mp4')
    expect(line('a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })

    server.holdPart = (_id, n) => (n > 1 ? never() : null)
    const h2 = mount()
    await letRun(1_000)
    expect(deletedIds()).toEqual([a.id, a.id])
    await pick(h2, [big('b.mp4')])
    void send(h2, token)
    for (let i = 0; i < 20 && made('b.mp4')?.parts.size !== 1; i++) await settle()
    const b = made('b.mp4')
    const newer = line('b.mp4')
    expect(newer).toMatchObject({ attachmentId: b.id })

    gate.resolve()
    await letRun(1_000)
    expect(line('b.mp4')).toEqual(newer)
    expect(line('a.mp4')).toBeUndefined()
  })

  it('empty storage, the DELETE gone: nothing of that line is left, the next load sends nothing and asks for nothing', async () => {
    const { h, answer } = await removedWhileCreating([small('a.mp4')])
    h.unmount()
    await storageEmptied()
    answer()
    await letRun()
    const a = made('a.mp4')
    expect(deletedIds()).toEqual([a.id])
    expect(a.status).toBe('aborted')
    // Empty storage or a session with no line: only the line's absence is the decision, not the shape left behind.
    expect(saved()?.files ?? []).toEqual([])

    const h2 = mount()
    await letRun()
    expect(deletedIds()).toEqual([a.id])
    expect(h2.result.current.resume).toBeNull()
  })

  const notGone: [string, Fault][] = [
    ['503', { status: 503 }],
    ['401, a refused token', { status: 401, error: 'invalid_token' }],
    ['no network', 'network'],
  ]
  it.each(notGone)('the DELETE answers %s, not gone: the line stays marked with its id and the next load sends the DELETE again', async (_label, fault) => {
    const { h, answer } = await removedWhileCreating()
    h.unmount()
    answerDeletes(fault)

    answer()
    await letRun()
    const a = made('a.mp4')
    expect(deletedIds()).toEqual([a.id])
    expect(line('a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })

    server.routeFault = () => null
    const h2 = mount()
    await letRun()
    expect(deletedIds()).toEqual([a.id, a.id])
    expect(a.status).toBe('aborted')
    expect(line('a.mp4')).toBeUndefined()
    expect(h2.result.current.resume).toEqual({ code: CODE, missing: [{ name: 'b.mp4', size: 2 * MiB }] })
  })
})

describe('row 2 of queue-races: the late create never touches another session, byte for byte', () => {
  const others: [string, () => Promise<void>][] = [
    ['another report\'s upload', () => uploadOf(THIRD, server.addReport(THIRD), 'third.mp4')],
    [
      'the same report under a newer token',
      () => {
        const newer = 'tok-newer'
        server.reports.get(CODE)!.tokens.add(newer)
        return uploadOf(CODE, newer, 'newer.mp4')
      },
    ],
  ]
  const answers: [string, Fault][] = [
    ['gone', 'ok'],
    ['503', { status: 503 }],
  ]
  const cases = others.flatMap(([who, visit]) => answers.map(([how, fault]) => [who, how, visit, fault] as const))

  it.each(cases)(
    'storage holds %s when the create answers, its DELETE %s: storage is the same string before the DELETE, while it is out and after its answer, with no write at all',
    async (_who, _how, visit, fault) => {
      const { token, h, answer } = await removedWhileCreating()
      h.unmount()
      await visit()
      const before = storage.getItem(KEY)
      expect(before).not.toBeNull()
      expect(lineIn(before, 'a.mp4')).toBeUndefined()
      const setItem = vi.spyOn(storage, 'setItem')
      const removeItem = vi.spyOn(storage, 'removeItem')
      const gate = deferred()
      const atRequest = holdDeletes(gate.promise)
      answerDeletes(fault)

      answer()
      await letRun(1_000)
      expect(atRequest).toEqual([before])
      expect(storage.getItem(KEY)).toBe(before)
      gate.resolve()
      await letRun()

      expect(storage.getItem(KEY)).toBe(before)
      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
      const a = made('a.mp4')
      expect(deletedIds()).toEqual([a.id])
      expect(deletes()[0]?.token).toBe(token)
    },
  )

  it.each(answers)(
    'the line written, its DELETE out, another report\'s upload saved over it meanwhile, then the DELETE answers %s: that upload is the same string, with no write at all',
    async (_how, fault) => {
      const { h, answer } = await removedWhileCreating()
      h.unmount()
      const gate = deferred()
      holdDeletes(gate.promise)
      answerDeletes(fault)
      answer()
      await letRun(1_000)
      expect(deletes()).toHaveLength(1)

      await uploadOf(THIRD, server.addReport(THIRD), 'third.mp4')
      const before = storage.getItem(KEY)
      expect((JSON.parse(before!) as Saved).code).toBe(THIRD)
      const setItem = vi.spyOn(storage, 'setItem')
      const removeItem = vi.spyOn(storage, 'removeItem')

      gate.resolve()
      await letRun()
      expect(storage.getItem(KEY)).toBe(before)
      expect(setItem).not.toHaveBeenCalled()
      expect(removeItem).not.toHaveBeenCalled()
    },
  )
})
