// bp-integration stage 3e: the findings of audit-3-r1 on useUpload and the pages, against the fake worker and an
// in-memory sessionStorage, as queue-reload.spec.ts (a reload is an unmount and a new mount; saved state comes from an
// earlier visit, never from storage written by hand, but for finding 8, which needs the gap between two reads, and
// finding 10, which is about values no build wrote).
// Findings 1 and 2 are the two STATE ones. Finding 1: a late create's `adopt` never makes a new session over a report's
// saved upload; a mounted page whose session is null because `only` filtered it does not take the line, it goes the
// no-owner way. Finding 2: `resume` on the very first render already excludes what a saved `pending` strikes.
// Findings 4 to 10 are builder additions and design sections that had no spec that could fail.
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, strings } from '../src/i18n'
import AddVideo from '../src/pages/AddVideo'
import Report from '../src/pages/Report'
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
  type Content,
  type Fault,
} from './helpers'
import { holdDigest, normalDigest } from './setup'

const CODE = 'LUM-482193'
const OTHER = 'LUM-482194'
const THIRD = 'LUM-482195'
const VIDEO: Content = { seed: 31 }
const KEY = 'lumina-bug-upload'
const t = strings.en
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
const deletedIds = (from = 0) => deletes().slice(from).map((r) => r.path.replace(/^.*\/attachments\//, ''))
const putsAfter = (mark: number) => server.log.slice(mark).filter((r) => r.method === 'PUT')
const createsAfter = (mark: number) => server.log.slice(mark).filter((r) => r.method === 'POST' && r.path.endsWith('/attachments'))
const line = (name: string) => saved()?.files.find((f) => f.name === name)
const marked = (name: string) => line(name)?.removing
const savedNames = () => saved()?.files.map((f) => f.name)
const names = (h: Hook) => h.result.current.files.map((f) => f.name)
const keyOf = (h: Hook, name: string) => h.result.current.files.find((f) => f.name === name)!.key
const big = (name: string) => file(name, 4 * PART, 'video/mp4', 1000, VIDEO)
const clip = () => big('clip.mp4')
const small = (name: string) => file(name, 2 * MiB, 'video/mp4')
const createPath = `/reports/${CODE}/attachments`
const made = (name: string) => server.attsOf(CODE).find((a) => a.filename === name)!
const failDeletes = () => {
  server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
}

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
async function sendAndFinish(h: Hook, token: string): Promise<boolean> {
  const sent = send(h, token)
  let ok = false
  await act(async () => {
    ok = await drive(sent)
  })
  await letRun()
  return ok
}
// What a page that stays open has to live through: `resume` of every render, the first one included.
function recording(only?: string) {
  const seen: ReturnType<typeof useUpload>['resume'][] = []
  const h = renderHook(() => {
    const up = useUpload(only)
    seen.push(up.resume)
    return up
  })
  return { h, seen }
}

// A first visit that sent part 1 of `big` (4 parts) and of `more` nothing, then was left: the attachment of `big` and
// every saved line exist, the lines of `more` without an attachment.
async function savedHalfWay(more: File[] = [], first: File = clip()) {
  const token = server.addReport(CODE)
  server.holdPart = (_id, n) => (n > 1 ? never() : null)
  const h = mount()
  await pick(h, [first, ...more])
  const p = send(h, token)
  for (let i = 0; i < 20 && server.attsOf(CODE)[0]?.parts.size !== 1; i++) await settle()
  h.unmount()
  await act(async () => {
    await drive(p)
  })
  server.holdPart = () => null
  const att = server.attsOf(CODE)[0]!
  expect([...att.parts.keys()]).toEqual([1])
  return { token, att }
}

// Row 10's first half: a second visit picks the file again and presses Remove while its hash is held; the page is left
// and the hash never answers there (the tab is dead). Hashes from now on answer as usual.
async function removedWhileHashing(f: File = clip()) {
  const h = mount()
  holdDigest()
  act(() => h.result.current.addFiles([f]))
  await settle()
  expect(names(h)).toEqual([f.name])
  remove(h, f.name)
  await settle()
  expect(deletes()).toEqual([])
  h.unmount()
  normalDigest()
}

// A visit whose a.mp4 was Removed while its create was out (held by the server), the other files saved with it.
async function removedWhileCreating(files: File[] = [small('a.mp4')], token = server.addReport(CODE)) {
  const create = deferred()
  let first = true
  server.holdRoute = (m, p) => {
    if (m !== 'POST' || p !== createPath || !first) return null
    first = false
    return create.promise
  }
  const h = mount()
  await pick(h, files)
  const asked = server.requests('POST', createPath).length
  void send(h, token)
  await settle()
  expect(server.requests('POST', createPath)).toHaveLength(asked + 1)
  expect(made('a.mp4')).toBeUndefined()
  remove(h, 'a.mp4')
  await settle()
  expect(line('a.mp4')).toMatchObject({ attachmentId: null, removing: true })
  return { token, h, answer: () => create.resolve() }
}

// A visit to `code` that had one file of 2 parts going, then was left: storage holds that upload.
async function uploadOf(code: string, token: string, name: string) {
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
  return structuredClone(saved())
}

describe('audit-3 finding 1: a late create never makes a new session over a report\'s saved upload', () => {
  it('finding 1: a.mp4 Removed while its create is out, b.mp4 saved, /add?code=OTHER open (its session filtered by `only`), the create answers and its DELETE 200: storage still holds b.mp4 of CODE, one DELETE went, and reopening CODE resumes b.mp4', async () => {
    const { token, h, answer } = await removedWhileCreating([small('a.mp4'), small('b.mp4')])
    h.unmount()
    const page = mount(OTHER)
    await settle()
    expect(page.result.current.resume).toBeNull()

    answer()
    await letRun()
    const a = made('a.mp4')
    expect(deletedIds()).toEqual([a.id])
    expect(a.status).toBe('aborted')
    expect(saved()?.code).toBe(CODE)
    expect(savedNames()).toContain('b.mp4')
    expect(line('b.mp4')).toMatchObject({ attachmentId: null, done: false })
    page.unmount()

    const h3 = mount(CODE)
    await letRun()
    expect(h3.result.current.resume).toEqual({ code: CODE, missing: [{ name: 'b.mp4', size: 2 * MiB }] })
    await pick(h3, [small('b.mp4')])
    expect(await sendAndFinish(h3, token)).toBe(true)
    expect(h3.result.current.phase).toBe('done')
    expect(made('b.mp4').status).toBe('complete')
    expect(deletedIds()).toEqual([a.id])
    expect(loadSession()).toBeNull()
  })

  it('finding 1: the same with b.mp4 half uploaded (its attachment saved): the line keeps its attachment and picking b.mp4 again sends only the parts it lacks, no second create', async () => {
    const { token, att } = await savedHalfWay([], big('b.mp4'))
    const { h, answer } = await removedWhileCreating([small('a.mp4'), big('b.mp4')], token)
    h.unmount()
    const page = mount(OTHER)
    await settle()
    answer()
    await letRun()
    expect(deletedIds()).toEqual([made('a.mp4').id])
    expect(line('b.mp4')).toMatchObject({ attachmentId: att.id, done: false })
    page.unmount()

    const h3 = mount(CODE)
    await letRun()
    expect(h3.result.current.resume).toEqual({ code: CODE, missing: [{ name: 'b.mp4', size: 4 * PART }] })
    await pick(h3, [big('b.mp4')])
    const mark = server.log.length
    expect(await sendAndFinish(h3, token)).toBe(true)
    expect(createsAfter(mark)).toEqual([])
    expect(putsAfter(mark).map((r) => r.n).sort()).toEqual([2, 3, 4])
    expect(att.status).toBe('complete')
  })

  const moments: [string, boolean][] = [
    ['already open when the create answers', true],
    ['opened while its DELETE is out', false],
  ]
  it.each(moments)(
    'finding 1, the no-owner way: the DELETE answers 503, the filtered page %s: the id goes into CODE\'s saved session beside b.mp4, the filtered page stays empty, and the next CODE load sends the DELETE again and offers b.mp4',
    async (_label, openFirst) => {
      const { h, answer } = await removedWhileCreating([small('a.mp4'), small('b.mp4')])
      h.unmount()
      failDeletes()
      const gate = deferred()
      let page: Hook | undefined
      if (openFirst) {
        page = mount(OTHER)
        await settle()
      } else {
        server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
      }
      answer()
      await letRun(1_000)
      if (!page) {
        page = mount(OTHER)
        await settle()
        gate.resolve()
      }
      await letRun()
      const a = made('a.mp4')
      expect(deletedIds()).toEqual([a.id])
      expect(a.status).toBe('uploading')
      expect(saved()?.code).toBe(CODE)
      expect(line('a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })
      expect(line('b.mp4')).toMatchObject({ attachmentId: null, done: false })
      expect(page.result.current.resume).toBeNull()
      page.unmount()

      server.routeFault = () => null
      server.holdRoute = () => null
      const h3 = mount(CODE)
      await letRun()
      expect(deletedIds()).toEqual([a.id, a.id])
      expect(a.status).toBe('aborted')
      expect(line('a.mp4')).toBeUndefined()
      expect(h3.result.current.resume).toEqual({ code: CODE, missing: [{ name: 'b.mp4', size: 2 * MiB }] })
    },
  )

  const others: [string, (token: string) => Promise<Saved | null>][] = [
    [
      'another report\'s upload',
      async () => uploadOf(THIRD, server.addReport(THIRD), 'third.mp4'),
    ],
    [
      'the same report under a newer token',
      async () => {
        const newer = 'tok-newer'
        server.reports.get(CODE)!.tokens.add(newer)
        return uploadOf(CODE, newer, 'newer.mp4')
      },
    ],
  ]
  it.each(others)(
    'finding 1, otherwise untracked: storage holds %s when the create answers (filtered page, DELETE 503): the DELETE goes with the old token and storage is left exactly as it was',
    async (_label, visit) => {
      const { token, h, answer } = await removedWhileCreating()
      h.unmount()
      const before = await visit(token)
      expect(before?.files.map((f) => f.name)).not.toContain('a.mp4')
      failDeletes()
      const page = mount(OTHER)
      await settle()

      answer()
      await letRun()
      const a = made('a.mp4')
      expect(deletedIds()).toEqual([a.id])
      expect(deletes()[0]?.token).toBe(token)
      expect(saved()).toEqual(before)
      expect(page.result.current.resume).toBeNull()
    },
  )

  it('finding 1, the other side: a page whose session is null for another reason (reset, nothing saved) still takes the line: 503 leaves it marked with its id for the next load', async () => {
    const { h, answer } = await removedWhileCreating()
    act(() => h.result.current.reset())
    await settle()
    expect(loadSession()).toBeNull()
    failDeletes()

    answer()
    await letRun()
    const a = made('a.mp4')
    expect(deletedIds()).toEqual([a.id])
    expect(saved()?.code).toBe(CODE)
    expect(line('a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })

    // The storage above is the same whether the page took the line or the no-page way wrote it: only the pick tells them
    // apart. A page that took it holds the place, sends the DELETE again first and refuses the file that does not fit.
    await pick(h, [small('b.mp4'), small('c.mp4'), small('d.mp4')])
    expect(names(h)).toEqual(['b.mp4', 'c.mp4'])
    expect(h.result.current.rejection).toBe('count')
    expect(deletedIds()).toEqual([a.id, a.id])
  })
})

describe('audit-3 finding 2: `resume` is right on the very first render', () => {
  it('finding 2: row 10 with the video as the only open file, reload: `resume` is null on render 0 and every render after', async () => {
    await savedHalfWay()
    await removedWhileHashing()
    const { h, seen } = recording()
    expect(seen[0]).toBeNull()
    await letRun()
    expect(seen.every((r) => r === null)).toBe(true)
    expect(h.result.current.resume).toBeNull()
  })

  it('finding 2: the struck video and another open file: render 0 asks only for the other file, never the struck one', async () => {
    await savedHalfWay([small('a.mp4')])
    await removedWhileHashing()
    const { seen } = recording()
    expect(seen[0]).toEqual({ code: CODE, missing: [{ name: 'a.mp4', size: 2 * MiB }] })
  })

  it('finding 2, control: a file of the same name but another size Removed while hashing strikes nothing: render 0 still asks for clip.mp4', async () => {
    await savedHalfWay()
    await removedWhileHashing(file('clip.mp4', 3 * PART, 'video/mp4', 1000, VIDEO))
    const { seen } = recording()
    expect(seen[0]).toEqual({ code: CODE, missing: [{ name: 'clip.mp4', size: 4 * PART }] })
  })

  it('finding 2, control: a Remove saved as a mark (DELETE never answered): render 0 is null', async () => {
    await markedByALeftPage()
    const { seen } = recording()
    expect(seen[0]).toBeNull()
  })

  it('finding 2: nothing is written or sent before the mount: render 0 alone leaves storage as the last visit did, and the mount sends the one DELETE', async () => {
    const { att } = await savedHalfWay()
    await removedWhileHashing()
    const stored = storage.getItem(KEY)
    const seenAtRender: (string | null)[] = []
    const sentAtRender: number[] = []
    renderHook(() => {
      const up = useUpload()
      seenAtRender.push(storage.getItem(KEY))
      sentAtRender.push(deletes().length)
      return up
    })
    expect(seenAtRender[0]).toBe(stored)
    expect(sentAtRender[0]).toBe(0)
    await letRun()
    expect(deletedIds()).toEqual([att.id])
  })
})

// A visit that picked clip.mp4 again and Removed it, its DELETE never answered, then left: the line stays marked.
async function markedByALeftPage() {
  const halfWay = await savedHalfWay()
  const h = mount()
  await pick(h, [clip()])
  server.holdRoute = (m) => (m === 'DELETE' ? never() : null)
  remove(h, 'clip.mp4')
  await settle()
  expect(marked('clip.mp4')).toBe(true)
  h.unmount()
  server.holdRoute = () => null
  return halfWay
}

describe('audit-3 finding 2, on the pages', () => {
  beforeEach(() => {
    localStorage.clear()
    // jsdom has no scrolling; the pages scroll to the top on every step.
    vi.stubGlobal('scrollTo', () => {})
    window.turnstile = {
      render: (_el, o) => {
        o.callback('turnstile-pass')
        return 'w1'
      },
      reset: () => {},
      remove: () => {},
    }
  })
  afterEach(() => {
    delete window.turnstile
  })

  const page = (c: () => ReturnType<typeof AddVideo>) => render(createElement(I18nProvider, null, createElement(c)))
  const choose = (...files: File[]) =>
    fireEvent.change(document.querySelector('input[type=file]') as HTMLInputElement, { target: { files } })
  const newReports = () => server.log.filter((r) => r.method === 'POST' && /\/reports$/.test(r.path))
  const attachSessions = () => server.requests('POST', `/reports/${CODE}/attach-session`)
  async function press(name: string): Promise<void> {
    const b = await screen.findByRole('button', { name })
    await waitFor(() => expect(b).toHaveProperty('disabled', false))
    fireEvent.click(b)
  }
  // The earlier visits run on the fake clock (they need it for their backoffs); the page, as the page specs, on the real one.
  const realClock = () => vi.useRealTimers()
  const fresh = () => [...server.reports.keys()].find((k) => k !== CODE)

  async function throughSteps(): Promise<void> {
    expect(screen.getByRole('heading', { name: t.h1 })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: t.h3 })).toBeNull()
    fireEvent.change(screen.getByLabelText(t.q1), { target: { value: 'The boss stopped on the bridge.' } })
    fireEvent.click(screen.getByRole('button', { name: t.next }))
    fireEvent.click(await screen.findByRole('button', { name: t.where.match }))
    fireEvent.click(screen.getByRole('button', { name: t.dev.phone }))
    fireEvent.click(screen.getByRole('button', { name: t.next }))
    await screen.findByRole('heading', { name: t.h3 })
  }

  it('finding 2, Report: row 10 with the video as the only open file, reload: the page opens on step 1, and Send of a new file posts a new report, never into the old one', async () => {
    const { att } = await savedHalfWay()
    await removedWhileHashing()
    realClock()
    page(Report)
    await throughSteps()
    choose(file('new.mp4', 2 * MiB))
    await press(t.send)
    await screen.findByText(t.h4, undefined, { timeout: 5000 })
    expect(newReports()).toHaveLength(1)
    const code = fresh()
    expect(code).toBeDefined()
    expect(server.attsOf(code!)).toHaveLength(1)
    expect(server.attsOf(code!)[0]).toMatchObject({ filename: 'new.mp4', status: 'complete' })
    expect(server.attsOf(CODE).map((a) => [a.id, a.status])).toEqual([[att.id, 'aborted']])
  })

  it('finding 2, Report, control: a Remove saved as a mark opens on step 1 too', async () => {
    await markedByALeftPage()
    realClock()
    page(Report)
    await throughSteps()
  })

  it('finding 2, Report, the other side: the struck video and another open file: still step 3 on its report, the hint names only the other file', async () => {
    await savedHalfWay([small('a.mp4')])
    await removedWhileHashing()
    realClock()
    page(Report)
    expect(screen.getByRole('heading', { name: t.h3 })).toBeTruthy()
    const hint = (await screen.findByText(t.resumeHint, { exact: false })).closest('.hint') as HTMLElement
    expect(hint.textContent).toContain('a.mp4')
    expect(hint.textContent).not.toContain('clip.mp4')
    expect(screen.queryByRole('textbox', { name: t.q1 })).toBeNull()
  })

  it('finding 2, AddVideo with the code in the address: the report is not bound on load, so Add to report asks attach-session and the new file goes up', async () => {
    const { att } = await savedHalfWay()
    await removedWhileHashing()
    realClock()
    history.replaceState(null, '', `/add?code=${CODE}`)
    page(AddVideo)
    expect(screen.getByLabelText(t.addCodeL)).toHaveProperty('readOnly', false)
    choose(file('new.mp4', 2 * MiB))
    await press(t.addSend)
    await screen.findByText(t.h4, undefined, { timeout: 5000 })
    expect(attachSessions()).toHaveLength(1)
    expect(server.attsOf(CODE).find((a) => a.filename === 'new.mp4')).toMatchObject({ status: 'complete' })
    expect(att.status).toBe('aborted')
  })

  it('finding 2, AddVideo with no code in the address: the field stays empty and nothing is bound (the code is not read from a removed upload)', async () => {
    await savedHalfWay()
    await removedWhileHashing()
    realClock()
    history.replaceState(null, '', '/add')
    page(AddVideo)
    expect(screen.getByLabelText(t.addCodeL)).toHaveProperty('value', '')
    expect(screen.getByLabelText(t.addCodeL)).toHaveProperty('readOnly', false)
  })
})

describe('audit-3 findings 4 to 10', () => {
  it('finding 4 (queue.ts:307): the load DELETE still out, the page reset (Back): a Send of a new file does not wait for it', async () => {
    const { token } = await markedByALeftPage()
    server.holdRoute = (m) => (m === 'DELETE' ? never() : null)
    const h = mount()
    await settle()
    expect(deletes()).toHaveLength(2)
    act(() => h.result.current.reset())
    await settle()
    await pick(h, [small('new.mp4')])
    const mark = server.log.length
    void send(h, token)
    await letRun()
    expect(createsAfter(mark)).toHaveLength(1)
    expect(made('new.mp4').status).toBe('complete')
    expect(h.result.current.phase).toBe('done')
  })

  it('finding 5 (queue.ts:225): a saved file with no attachment, Removed behind another file\'s held DELETE: its line goes at press, and the reload does not ask for it', async () => {
    const { att } = await savedHalfWay([small('a.mp4')])
    expect(line('a.mp4')).toMatchObject({ attachmentId: null })
    const h = mount()
    await pick(h, [clip(), small('a.mp4')])
    expect(names(h)).toEqual(['clip.mp4', 'a.mp4'])
    server.holdRoute = (m) => (m === 'DELETE' ? never() : null)
    remove(h, 'clip.mp4')
    await settle()
    expect(deletedIds()).toEqual([att.id])
    remove(h, 'a.mp4')
    await settle()
    // Its turn has not come (the DELETE of clip.mp4 is out), and still the line is gone.
    expect(deletedIds()).toEqual([att.id])
    expect(line('a.mp4')).toBeUndefined()
    h.unmount()

    server.holdRoute = () => null
    const h3 = mount()
    await letRun()
    expect(h3.result.current.resume).toBeNull()
    expect(line('a.mp4')).toBeUndefined()
  })

  it('finding 6 (queue.ts:479, :488): clip.mp4 Removed while hashed, waiting behind another file\'s held DELETE: the hash answers and one save marks its line and drops `pending`; a reload in that window still sends its DELETE and never asks for it', async () => {
    // Two saved open files with attachments: the first visit sent part 1 of clip.mp4, the second part 1 of bee.mp4.
    const { token, att } = await savedHalfWay()
    server.holdPart = (_id, n) => (n > 1 ? never() : null)
    const h2 = mount()
    await pick(h2, [big('bee.mp4'), clip()])
    const p = send(h2, token)
    for (let i = 0; i < 20 && made('bee.mp4')?.parts.size !== 1; i++) await settle()
    h2.unmount()
    await act(async () => {
      await drive(p)
    })
    server.holdPart = () => null
    const bee = made('bee.mp4')
    expect(line('bee.mp4')).toMatchObject({ attachmentId: bee.id })
    expect(line('clip.mp4')).toMatchObject({ attachmentId: att.id })

    const h3 = mount()
    await pick(h3, [big('bee.mp4')])
    const release = holdDigest()
    act(() => h3.result.current.addFiles([clip()]))
    await settle()
    expect(names(h3)).toEqual(['bee.mp4', 'clip.mp4'])
    server.holdRoute = (m) => (m === 'DELETE' ? never() : null)
    remove(h3, 'bee.mp4')
    remove(h3, 'clip.mp4')
    await settle()
    expect(saved()?.pending).toEqual([{ name: 'clip.mp4', size: 4 * PART }])
    expect(marked('clip.mp4')).toBeUndefined()

    const setItem = vi.spyOn(storage, 'setItem')
    release()
    await settle()
    // bee.mp4's DELETE is out, clip.mp4 waits behind it: only the bind can have written the mark.
    expect(deletedIds()).toEqual([bee.id])
    expect(marked('clip.mp4')).toBe(true)
    expect(saved()?.pending).toBeUndefined()
    const writes = setItem.mock.calls.filter(([k]) => k === KEY).map(([, v]) => JSON.parse(v) as Saved)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.files.find((f) => f.name === 'clip.mp4')?.removing).toBe(true)
    expect(writes[0]).not.toHaveProperty('pending')
    h3.unmount()

    server.holdRoute = () => null
    const before = deletes().length
    const h4 = mount()
    await letRun()
    expect(deletedIds(before).sort()).toEqual([bee.id, att.id].sort())
    expect(h4.result.current.resume).toBeNull()
  })

  it('finding 7 (useUpload.ts:162): no page when the create answers, one opened while its DELETE is out, the DELETE 503: that page takes the line, sends it again, holds the place and keeps it through its next save', async () => {
    const { h, answer } = await removedWhileCreating()
    h.unmount()
    const gate = deferred()
    server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
    failDeletes()
    answer()
    await letRun(1_000)
    expect(deletes()).toHaveLength(1)

    const h2 = mount()
    await settle()
    gate.resolve()
    await letRun()
    const a = made('a.mp4')
    expect(deletedIds()).toEqual([a.id, a.id])
    expect(line('a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })

    await pick(h2, [small('b.mp4'), small('c.mp4'), small('d.mp4')])
    // Its place is held on this page: the pick that needs it sends the DELETE again first, and refuses one file.
    expect(deletedIds()).toEqual([a.id, a.id, a.id])
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4'])
    expect(h2.result.current.rejection).toBe('count')
    expect(line('a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })
  })

  it('finding 8 (queue.ts:260): a late create writes its marked line to storage between the boot read and the mount: the mount sees it and sends its DELETE', async () => {
    const { h, answer } = await removedWhileCreating()
    h.unmount()
    failDeletes()
    const atBoot = storage.getItem(KEY)
    expect(atBoot).not.toBeNull()
    answer()
    await letRun()
    const a = made('a.mp4')
    expect(line('a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })
    const written = storage.getItem(KEY)!

    // Storage as the boot read found it, then what the late create wrote arrives after that read and before the mount
    // effect: both strings are the code's own saves, only their order is staged, since no answer can land in that gap
    // under React's synchronous test render.
    storage.setItem(KEY, atBoot!)
    const before = deletes().length
    let booted = false
    const h2 = renderHook(() => {
      const up = useUpload()
      if (!booted) {
        booted = true
        storage.setItem(KEY, written)
      }
      return up
    })
    await settle()
    expect(deletedIds(before)).toEqual([a.id])
    expect(line('a.mp4')).toMatchObject({ attachmentId: a.id, removing: true })
    await pick(h2 as unknown as Hook, [small('b.mp4'), small('c.mp4'), small('d.mp4')])
    expect(h2.result.current.files.map((f) => f.name)).toEqual(['b.mp4', 'c.mp4'])
    expect(h2.result.current.rejection).toBe('count')
  })

  const seconds: [string, Fault, boolean][] = [
    ['200: the file leaves and the line goes', 'ok', true],
    ['503: it stays, the line stays', { status: 503 }, false],
  ]
  it.each(seconds)(
    'finding 9 (queue.ts:169): the orange line stays while an unremoved file\'s DELETE is sent again; its answer %s',
    async (_label, second, left) => {
      const token = server.addReport(CODE)
      server.partFault = () => ({ status: 400, error: 'invalid_part' })
      const h = mount()
      await pick(h, [small('a.mp4')])
      void send(h, token)
      await letRun()
      failDeletes()
      remove(h, 'a.mp4')
      await letRun()
      expect(deletes()).toHaveLength(1)
      expect(h.result.current.unremoved).toBe(true)

      const gate = deferred()
      server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
      server.routeFault = (m) => (m === 'DELETE' ? second : null)
      remove(h, 'a.mp4')
      await letRun(5_000)
      expect(deletes()).toHaveLength(2)
      expect(h.result.current.removing).toBe(true)
      expect(h.result.current.unremoved).toBe(true)

      gate.resolve()
      await letRun()
      expect(h.result.current.removing).toBe(false)
      expect(h.result.current.unremoved).toBe(!left)
      expect(names(h)).toEqual(left ? [] : ['a.mp4'])
    },
  )

  describe('finding 10 (session.ts:44): a saved `pending` of the wrong type', () => {
    // A real session, with a real `pending`, taken from an earlier visit; only `pending` is then spoiled.
    async function savedWithPending(): Promise<Record<string, unknown>> {
      await savedHalfWay()
      const h = mount()
      holdDigest()
      act(() => h.result.current.addFiles([clip()]))
      await settle()
      remove(h, 'clip.mp4')
      await settle()
      h.unmount()
      normalDigest()
      return JSON.parse(storage.getItem(KEY)!) as Record<string, unknown>
    }

    const bad: [string, unknown][] = [
      ['a string', 'clip.mp4'],
      ['a number', 1],
      ['null', null],
      ['an object', { name: 'clip.mp4', size: 1 }],
      ['an array of null', [null]],
      ['an entry with no size', [{ name: 'clip.mp4' }]],
      ['an entry with a negative size', [{ name: 'clip.mp4', size: -1 }]],
      ['an entry with a fractional size', [{ name: 'clip.mp4', size: 1.5 }]],
      ['an entry with a name that is not text', [{ name: 7, size: 1 }]],
    ]
    it.each(bad)('finding 10: %s drops the whole session as untrusted, and the next mount neither throws nor asks for it', async (_label, value) => {
      const s = await savedWithPending()
      storage.setItem(KEY, JSON.stringify({ ...s, pending: value }))
      expect(loadSession()).toBeNull()
      expect(storage.getItem(KEY)).toBeNull()
      storage.setItem(KEY, JSON.stringify({ ...s, pending: value }))
      const h = mount()
      await settle()
      expect(h.result.current.resume).toBeNull()
      expect(deletes()).toEqual([])
    })

    it('finding 10, the other side: a `pending` the saved shape allows (none, or an empty list) is not untrusted', async () => {
      const s = await savedWithPending()
      expect(loadSession()).toMatchObject({ pending: s.pending })
      storage.setItem(KEY, JSON.stringify({ ...s, pending: undefined }))
      expect(loadSession()).not.toBeNull()
      storage.setItem(KEY, JSON.stringify({ ...s, pending: [] }))
      expect(loadSession()).not.toBeNull()
    })
  })
})
