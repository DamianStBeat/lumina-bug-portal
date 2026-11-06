// bp-integration row 10 on useUpload, against the fake worker and an in-memory sessionStorage: a Remove survives a
// reload (web/src/upload/DESIGN.md, the 10 specs of its section 7). Row 10: «Tolgo un file mentre si calcola
// l'impronta, poi ricarico · riapro · il file resta tolto, il suo DELETE parte al caricamento successivo». The rule
// under test: a Remove is written to the session when it is pressed, before any request it causes, and leaves the
// session only once the server says the attachment is gone (200 { ok: true } or 404). Also the two STATE findings of
// redteam-astra-2.md (queue.ts:202/:227, a queued Remove forgotten when the page is left; queue.ts:309, a failed
// cleanup of a late create loses the attachment) and the Opus rule of redteam-opus-2.md (a failed or refused row
// keeps its colour and refusal line while its DELETE is out). A reload is an unmount followed by a new mount: nothing
// survives it but sessionStorage and the server, so every saved state here comes from an earlier visit, never from
// storage written by hand. What is asserted is what the server received, what storage holds after a real reload, and
// what the hook returns; the saved shape is read only where DESIGN.md names it (`removing`, `pending`, the id-less
// removing line).
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
  type Content,
  type Fault,
} from './helpers'
import { holdDigest, normalDigest } from './setup'

const CODE = 'LUM-482193'
const OTHER = 'LUM-482194'
const VIDEO: Content = { seed: 31 }
const KEY = 'lumina-bug-upload'
let server: FakeServer
let storage: Storage

beforeEach(() => {
  useFakeClock()
  storage = installStorage()
  server = new FakeServer().install()
})
afterEach(() => {
  vi.useRealTimers()
})

type Hook = ReturnType<typeof mount>
function mount(only?: string) {
  return renderHook(() => useUpload(only))
}
// What DESIGN.md section 1 adds to the saved shape, read loosely so the spec compiles before session.ts has it.
type Line = { name: string; size: number; attachmentId: string | null; done: boolean; removing?: unknown }
type Saved = { code: string; files: Line[]; pending?: unknown }
const saved = () => loadSession() as Saved | null
const never = () => new Promise<void>(() => {})
const deletes = () => server.log.filter((r) => r.method === 'DELETE')
const deletedIds = (from = 0) => deletes().slice(from).map((r) => r.path.replace(/^.*\/attachments\//, ''))
const putsAfter = (mark: number) => server.log.slice(mark).filter((r) => r.method === 'PUT')
const createsAfter = (mark: number) => server.log.slice(mark).filter((r) => r.method === 'POST' && r.path.endsWith('/attachments'))
const line = (name: string) => saved()?.files.find((f) => f.name === name)
const marked = (name: string) => line(name)?.removing
const names = (h: Hook) => h.result.current.files.map((f) => f.name)
const keyOf = (h: Hook, name: string) => h.result.current.files.find((f) => f.name === name)!.key
const clip = () => file('clip.mp4', 4 * PART, 'video/mp4', 1000, VIDEO)
const small = (name: string) => file(name, 2 * MiB, 'video/mp4')
const createPath = `/reports/${CODE}/attachments`

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
function remove(h: Hook, name: string): void {
  act(() => {
    void h.result.current.removeFile(keyOf(h, name))
  })
}
function send(h: Hook, token: string): Promise<boolean> {
  let p!: Promise<boolean>
  act(() => {
    p = h.result.current.start({ code: CODE, reportToken: token })
  })
  return p
}

// A first visit that sent part 1 of clip.mp4 (4 parts), and of `more` nothing (they wait behind it), then was left:
// the attachment of clip.mp4 and every saved line exist, the lines of `more` without an attachment.
async function savedHalfWay(more: File[] = []) {
  const token = server.addReport(CODE)
  server.holdPart = (_id, n) => (n > 1 ? never() : null)
  const h = mount()
  await pick(h, [clip(), ...more])
  const p = send(h, token)
  for (let i = 0; i < 20 && server.attsOf(CODE)[0]?.parts.size !== 1; i++) await settle()
  h.unmount()
  await act(async () => {
    await drive(p)
  })
  server.holdPart = () => null
  const att = server.attsOf(CODE)[0]!
  expect([...att.parts.keys()]).toEqual([1])
  expect(line('clip.mp4')).toMatchObject({ attachmentId: att.id, done: false })
  return { token, att }
}

// Row 10's first half: a second visit picks clip.mp4 again and presses Remove while its hash is still being computed
// (held), then the page is left. The hash never answers on that page: the tab is dead.
async function removedWhileHashing(f: File = clip()) {
  const h = mount()
  holdDigest()
  act(() => h.result.current.addFiles([f]))
  await settle()
  expect(names(h)).toEqual([f.name])
  remove(h, f.name)
  await settle()
  // Nothing is known on this page yet: no DELETE can go before the hash says which attachment it is.
  expect(deletes()).toEqual([])
  h.unmount()
  // The old hash stays held (it awaits the knob it read); hashes from now on answer as usual.
  normalDigest()
}

// A first visit whose a.mp4 was Removed while its create was out (held by the server). `answer` lets the create
// through; the caller leaves the page (or not) first.
async function removedWhileCreating() {
  const token = server.addReport(CODE)
  const create = deferred()
  server.holdRoute = (m, p) => (m === 'POST' && p === createPath ? create.promise : null)
  const h = mount()
  await pick(h, [small('a.mp4')])
  void send(h, token)
  await settle()
  expect(server.requests('POST', createPath)).toHaveLength(1)
  expect(server.attsOf(CODE)).toEqual([])
  remove(h, 'a.mp4')
  await settle()
  const answer = () => {
    server.holdRoute = () => null
    create.resolve()
  }
  return { token, h, answer }
}

describe('row 10: Remove while the fingerprint is computed, then reload', () => {
  const gone: [string, boolean][] = [
    ['200 { ok: true }', false],
    // Already gone on the server (a cron, another tab): the fake has no such row and answers 404 not_found.
    ['404 not_found (already gone)', true],
  ]
  it.each(gone)(
    'row 10 (spec 1): the re-picked saved video Removed while hashing, page reloaded: the next load sends exactly one DELETE of its attachment, answered %s: no line of it is saved and nothing asks for it',
    async (_label, alreadyGone) => {
      const { att } = await savedHalfWay()
      await removedWhileHashing()
      if (alreadyGone) server.atts.delete(att.id)
      const mark = server.log.length

      const h3 = mount()
      await letRun()
      expect(deletedIds()).toEqual([att.id])
      expect(line('clip.mp4')).toBeUndefined()
      expect(h3.result.current.resume).toBeNull()
      if (!alreadyGone) expect(att.status).toBe('aborted')
      // Not resumed nor asked for by a later reload either.
      h3.unmount()
      const h4 = mount()
      await letRun()
      expect(deletedIds()).toEqual([att.id])
      expect(h4.result.current.resume).toBeNull()
      expect(putsAfter(mark)).toEqual([])
    },
  )

  it('row 10 (spec 1), the other side: a file of the same name but another size Removed while hashing is not the saved video: the reload sends no DELETE and still asks for clip.mp4', async () => {
    const { att } = await savedHalfWay()
    await removedWhileHashing(file('clip.mp4', 3 * PART, 'video/mp4', 1000, VIDEO))

    const h3 = mount()
    await letRun()
    expect(deletes()).toEqual([])
    expect(att.status).toBe('uploading')
    expect(line('clip.mp4')).toMatchObject({ attachmentId: att.id, done: false })
    expect(marked('clip.mp4')).toBeUndefined()
    expect(h3.result.current.resume).toEqual({ code: CODE, missing: [{ name: 'clip.mp4', size: 4 * PART }] })
  })

  it('row 10 (spec 2), transient: the load DELETE answers 503: the line stays marked and holds its place (3 new files: 2 listed, refused as count); the load after sends it again and the line goes', async () => {
    const { att } = await savedHalfWay()
    await removedWhileHashing()

    server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
    const h3 = mount()
    await settle()
    expect(deletedIds()).toEqual([att.id])
    expect(att.status).toBe('uploading')
    expect(marked('clip.mp4')).toBe(true)
    expect(h3.result.current.resume).toBeNull()
    await pick(h3, [small('a.mp4'), small('b.mp4'), small('c.mp4')])
    expect(names(h3)).toEqual(['a.mp4', 'b.mp4'])
    expect(h3.result.current.rejection).toBe('count')
    expect(marked('clip.mp4')).toBe(true)
    h3.unmount()

    server.routeFault = () => null
    const before = deletes().length
    const h4 = mount()
    await letRun()
    expect(deletedIds(before)).toEqual([att.id])
    expect(att.status).toBe('aborted')
    expect(line('clip.mp4')).toBeUndefined()
    expect(h4.result.current.resume).toBeNull()
  })

  it('row 10 (spec 3): the hash answers on this page: `pending` is saved at press, then one save marks the line and drops it before the one DELETE goes; the reload sends none', async () => {
    const { att } = await savedHalfWay()
    const h2 = mount()
    const release = holdDigest()
    act(() => h2.result.current.addFiles([clip()]))
    await settle()
    // What storage holds when each DELETE reaches the server, so "saved before the request" is read, not guessed.
    const atDelete: (Saved | null)[] = []
    const gate = deferred()
    server.holdRoute = (m) => {
      if (m !== 'DELETE') return null
      atDelete.push(saved())
      return gate.promise
    }
    remove(h2, 'clip.mp4')
    await settle()
    // Saved at press, by the only name the file has before its hash: a reload now strikes the line (spec 1).
    expect(saved()?.pending).toEqual([{ name: 'clip.mp4', size: 4 * PART }])
    expect(marked('clip.mp4')).toBeUndefined()
    expect(deletes()).toEqual([])

    const setItem = vi.spyOn(storage, 'setItem')
    release()
    await settle()
    expect(deletedIds()).toEqual([att.id])
    expect(atDelete).toHaveLength(1)
    expect(atDelete[0]?.files.find((f) => f.name === 'clip.mp4')).toMatchObject({ attachmentId: att.id, removing: true })
    expect(atDelete[0]).not.toHaveProperty('pending')
    // One save: never a moment with `pending` gone and the line not marked yet (a reload there would resume it), nor
    // the line marked with `pending` still waiting to strike it again.
    const writes = setItem.mock.calls.filter(([k]) => k === KEY).map(([, v]) => JSON.parse(v) as Saved)
    expect(writes).toHaveLength(1)
    expect(writes[0]?.files.find((f) => f.name === 'clip.mp4')?.removing).toBe(true)
    expect(writes[0]).not.toHaveProperty('pending')

    gate.resolve()
    await letRun()
    expect(att.status).toBe('aborted')
    expect(line('clip.mp4')).toBeUndefined()
    h2.unmount()
    server.holdRoute = () => null
    const h3 = mount()
    await letRun()
    expect(deletedIds()).toEqual([att.id])
    expect(saved()?.pending).toBeUndefined()
    expect(h3.result.current.resume).toBeNull()
  })
})

describe('Astra queue.ts:202/:227: a Remove waiting for its turn when the page is left', () => {
  it('spec 4: clip.mp4 (with an attachment) Removed behind the held DELETE of another file: storage marks it before any answer; the next load DELETEs it and picking it again does not resume it (no PUT to its attachment)', async () => {
    const { token, att } = await savedHalfWay()
    // A second visit: a.mp4 is new and goes first, clip.mp4 binds again to its saved attachment.
    const h2 = mount()
    await pick(h2, [small('a.mp4'), clip()])
    server.holdPart = (id) => (server.atts.get(id)?.filename === 'a.mp4' ? never() : null)
    void send(h2, token)
    await settle()
    const a = server.attsOf(CODE).find((x) => x.filename === 'a.mp4')!
    expect(server.puts(a.id).length).toBeGreaterThan(0)
    server.holdRoute = (m) => (m === 'DELETE' ? never() : null)
    remove(h2, 'a.mp4')
    await settle()
    expect(deletedIds()).toEqual([a.id])
    remove(h2, 'clip.mp4')
    await settle()
    // Its turn has not come (a.mp4's DELETE is out), and still the Remove is saved.
    expect(deletedIds()).toEqual([a.id])
    expect(line('clip.mp4')).toMatchObject({ attachmentId: att.id })
    expect(marked('clip.mp4')).toBe(true)
    h2.unmount()

    server.holdRoute = () => null
    server.holdPart = () => null
    const before = deletes().length
    const h3 = mount()
    await settle()
    expect(deletedIds(before)).toContain(att.id)
    expect(att.status).toBe('aborted')
    expect(h3.result.current.resume).toBeNull()
    const mark = server.log.length
    await pick(h3, [clip()])
    const sent = send(h3, token)
    await act(async () => {
      await drive(sent)
    })
    await letRun()
    expect(putsAfter(mark).filter((r) => r.id === att.id)).toEqual([])
    expect(server.requests('POST', `/attachments/${att.id}/complete`)).toEqual([])
    expect(att.status).toBe('aborted')
  })
})

describe('Astra queue.ts:309: the create of a removed file answers after the page was left', () => {
  it('spec 5: no page open when the create answers and its DELETE answers 503: storage holds the marked line with that id; reopened, the DELETE goes again and 3 picks list 2 until it answers 200', async () => {
    const { h, answer } = await removedWhileCreating()
    h.unmount()
    server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
    answer()
    await letRun()
    const made = server.attsOf(CODE)[0]!
    expect(made.status).toBe('uploading')
    expect(deletedIds()).toEqual([made.id])
    expect(line('a.mp4')).toMatchObject({ attachmentId: made.id, removing: true })

    const before = deletes().length
    const h2 = mount()
    await settle()
    expect(deletedIds(before)).toEqual([made.id])
    await pick(h2, [small('b.mp4'), small('c.mp4'), small('d.mp4')])
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4'])
    expect(h2.result.current.rejection).toBe('count')

    server.routeFault = () => null
    await pick(h2, [small('d.mp4')])
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4', 'd.mp4'])
    expect(made.status).toBe('aborted')
    expect(line('a.mp4')).toBeUndefined()
  })

  it('spec 6: a page of the same report is open when the create answers: its session gets the marked line, it sends the DELETE, and a 503 keeps it failed and its place counted (a pick sends it again, 2 of 3 listed)', async () => {
    const { h, answer } = await removedWhileCreating()
    h.unmount()
    server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
    const h2 = mount()
    await settle()
    expect(deletes()).toEqual([])
    answer()
    await letRun()
    const made = server.attsOf(CODE)[0]!
    expect(deletedIds()).toEqual([made.id])
    expect(made.status).toBe('uploading')
    expect(line('a.mp4')).toMatchObject({ attachmentId: made.id, removing: true })

    await pick(h2, [small('b.mp4'), small('c.mp4'), small('d.mp4')])
    // Kept as failed on this page: the pick that needs its place sends the DELETE again first.
    expect(deletedIds()).toEqual([made.id, made.id])
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4'])
    expect(h2.result.current.rejection).toBe('count')
    expect(line('a.mp4')).toMatchObject({ attachmentId: made.id, removing: true })
  })

  it('spec 7: Remove while the create is out, then a reload and the create never answers: the id-less line is saved at press, and the next load sends no DELETE, keeps no such line and does not ask for the file', async () => {
    const { h } = await removedWhileCreating()
    // Saved at press: the open line flipped, not dropped, so a create answering later finds where to write its id.
    expect(line('a.mp4')).toMatchObject({ attachmentId: null, done: false, removing: true })
    h.unmount()

    const h2 = mount()
    await letRun()
    expect(deletes()).toEqual([])
    expect(line('a.mp4')).toBeUndefined()
    expect(h2.result.current.resume).toBeNull()
  })
})

describe('Opus queue.ts:153/:463: a failed row keeps its look while its DELETE is out', () => {
  const kinds: [string, Fault, 'refused' | 'error'][] = [
    ['refused (PUT part 400 invalid_part)', { status: 400, error: 'invalid_part' }, 'refused'],
    ['failed, Try again can pass (PUT part 503 on every try)', { status: 503 }, 'error'],
  ]
  const ends: [string, Fault, boolean][] = [
    ['200 { ok: true }: it leaves', 'ok', true],
    ['503: unremoved, the orange line', { status: 503 }, false],
  ]
  const cases = kinds.flatMap(([k, put, state]) => ends.map(([e, del, left]) => [k, e, put, state, del, left] as const))
  it.each(cases)(
    'spec 8: a file %s, Removed while its DELETE is held: the row keeps its state and refusal line; the DELETE answers %s',
    async (_k, _e, put, state, del, left) => {
      const token = server.addReport(CODE)
      server.partFault = () => put
      const h = mount()
      await pick(h, [small('a.mp4')])
      void send(h, token)
      await letRun()
      expect(server.attsOf(CODE)).toHaveLength(1)
      expect(h.result.current.files.map((f) => [f.name, f.state])).toEqual([['a.mp4', state]])
      const why = h.result.current.refused
      if (state === 'refused') expect(why).not.toBeNull()
      else expect(why).toBeNull()

      const gate = deferred()
      server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
      server.routeFault = (m) => (m === 'DELETE' ? del : null)
      remove(h, 'a.mp4')
      await letRun(5_000)
      expect(deletes()).toHaveLength(1)
      expect(h.result.current.removing).toBe(true)
      expect(h.result.current.files.map((f) => [f.name, f.state])).toEqual([['a.mp4', state]])
      expect(h.result.current.refused).toBe(why)

      gate.resolve()
      await letRun()
      expect(h.result.current.removing).toBe(false)
      if (left) {
        expect(names(h)).toEqual([])
        expect(h.result.current.refused).toBeNull()
        expect(h.result.current.unremoved).toBe(false)
      } else {
        expect(names(h)).toEqual(['a.mp4'])
        expect(h.result.current.unremoved).toBe(true)
      }
    },
  )
})

describe('row 2 still holds with adopt: a late create of one report never writes into another report', () => {
  it('spec 9: the create of a CODE file Removed while out answers while an OTHER upload is mounted: storage stays OTHER\'s, the attachment is still deleted, and the OTHER upload finishes', async () => {
    const { h, answer } = await removedWhileCreating()
    h.unmount()

    const tokenB = server.addReport(OTHER)
    const parts = deferred()
    server.holdPart = (id, n) => (server.atts.get(id)?.code === OTHER && n > 1 ? parts.promise : null)
    const h3 = mount(OTHER)
    await pick(h3, [file('b.mp4', 2 * PART)])
    let p!: Promise<boolean>
    act(() => {
      p = h3.result.current.start({ code: OTHER, reportToken: tokenB })
    })
    for (let i = 0; i < 20 && server.attsOf(OTHER)[0]?.parts.size !== 1; i++) await settle()
    const attB = server.attsOf(OTHER)[0]!
    const before = structuredClone(loadSession())
    expect(before).toMatchObject({ code: OTHER, reportToken: tokenB, files: [{ name: 'b.mp4', attachmentId: attB.id }] })

    answer()
    await letRun()
    const made = server.attsOf(CODE)[0]!
    expect(deletedIds()).toEqual([made.id])
    expect(made.status).toBe('aborted')
    expect(loadSession()).toEqual(before)

    server.holdPart = () => null
    parts.resolve()
    let ok = false
    await act(async () => {
      ok = await drive(p)
    })
    await settle()
    expect(ok).toBe(true)
    expect(h3.result.current.phase).toBe('done')
    expect(attB.status).toBe('complete')
    expect(loadSession()).toBeNull()
  })
})

describe('the Send waits for the load DELETE', () => {
  it('spec 10: a marked line and a re-picked saved file; the mount DELETE held, Send pressed: no create and no PUT until it answers, then the file goes up', async () => {
    // Visit 1: clip.mp4 has an attachment with part 1, a.mp4 is saved without one yet.
    const { token, att } = await savedHalfWay([small('a.mp4')])
    expect(line('a.mp4')).toMatchObject({ attachmentId: null })
    // Visit 2: clip.mp4 picked again and Removed, its DELETE still out when the page is left: its line stays marked.
    const h1 = mount()
    await pick(h1, [clip()])
    server.holdRoute = (m) => (m === 'DELETE' ? never() : null)
    remove(h1, 'clip.mp4')
    await settle()
    expect(deletedIds()).toEqual([att.id])
    expect(marked('clip.mp4')).toBe(true)
    h1.unmount()

    // Visit 3: the load DELETE is slow.
    const gate = deferred()
    server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
    const h2 = mount()
    await settle()
    expect(deletedIds()).toEqual([att.id, att.id])
    await pick(h2, [small('a.mp4')])
    expect(names(h2)).toEqual(['a.mp4'])
    const mark = server.log.length
    const sent = send(h2, token)
    // Long enough for a create and a first part to go out, short of any timeout a slow DELETE might meet.
    await letRun(5_000)
    expect(createsAfter(mark)).toEqual([])
    expect(putsAfter(mark)).toEqual([])

    gate.resolve()
    server.holdRoute = () => null
    await act(async () => {
      await drive(sent)
    })
    await letRun()
    expect(att.status).toBe('aborted')
    expect(createsAfter(mark)).toHaveLength(1)
    expect(server.attsOf(CODE).find((x) => x.filename === 'a.mp4')?.status).toBe('complete')
    expect(putsAfter(mark).filter((r) => r.id === att.id)).toEqual([])
    expect(h2.result.current.phase).toBe('done')
  })
})
