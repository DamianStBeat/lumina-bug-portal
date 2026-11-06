// bp-web-upload rows 1-3 on useUpload, against the fake worker and an in-memory sessionStorage: the races of the
// upload queue that two red team rounds found (bp-web-fix redteam-astra-2.md, redteam-opus-2.md). Row 1: a file
// Removed just before Send is never uploaded nor completed, and the report goes with the other files. Row 2: a Remove
// still going when the page is left never writes over the session of the upload made since. Row 3: the fake worker
// refuses to complete an aborted attachment, as the worker on main does. A reload is an unmount followed by a new
// mount: nothing survives it but sessionStorage and the server, so every saved state here comes from a first visit.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSession } from '../src/upload/session'
import { useUpload } from '../src/upload/useUpload'
import {
  CONTRACT_PART_SIZE as PART,
  FakeServer,
  MiB,
  SparseBlob,
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
let server: FakeServer

beforeEach(() => {
  useFakeClock()
  installStorage()
  server = new FakeServer().install()
})
afterEach(() => {
  vi.useRealTimers()
})

type Hook = ReturnType<typeof mount>
function mount(only?: string) {
  return renderHook(() => useUpload(only))
}
const never = () => new Promise<void>(() => {})
const deletes = () => server.log.filter((r) => r.method === 'DELETE')
const putsAfter = (mark: number) => server.log.slice(mark).filter((r) => r.method === 'PUT')
const completesOf = (id: string) => server.requests('POST', `/attachments/${id}/complete`)
const line = (name: string) => loadSession()?.files.find((f) => f.name === name)
const marked = (name: string) => (line(name) as { removing?: unknown } | undefined)?.removing
const names = (h: Hook) => h.result.current.files.map((f) => f.name)
const keyOf = (h: Hook, name: string) => h.result.current.files.find((f) => f.name === name)!.key
const stateOf = (h: Hook, name: string) => h.result.current.files.find((f) => f.name === name)?.state
const clip = () => file('clip.mp4', 4 * PART, 'video/mp4', 1000, VIDEO)
const small = (name: string) => file(name, 2 * MiB, 'video/mp4')
const others = () => server.attsOf(CODE).filter((a) => a.filename !== 'clip.mp4')

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

// A first visit that sent part 1 of clip.mp4 (4 parts) and was left: its attachment and its saved line exist.
async function savedHalfWay() {
  const token = server.addReport(CODE)
  server.holdPart = (_id, n) => (n > 1 ? never() : null)
  const h = mount()
  await pick(h, [clip()])
  let p!: Promise<boolean>
  act(() => {
    p = h.result.current.start({ code: CODE, reportToken: token })
  })
  for (let i = 0; i < 20 && server.attsOf(CODE)[0]?.parts.size !== 1; i++) await settle()
  h.unmount()
  await act(async () => {
    await drive(p)
  })
  server.holdPart = () => null
  const att = server.attsOf(CODE)[0]!
  expect([...att.parts.keys()]).toEqual([1])
  expect(line('clip.mp4')).toMatchObject({ attachmentId: att.id })
  return { token, att }
}

describe('row 3: an aborted attachment cannot be completed, as the worker on main answers', () => {
  // Straight at the fake's HTTP surface, as the client would call it.
  const api = (path: string, token: string, init: RequestInit = {}) =>
    server.fetch(`/api/v1${path}`, { ...init, headers: { 'X-Report-Token': token, 'Content-Type': 'application/json' } })
  async function created(token: string, size: number): Promise<{ id: string; partCount: number }> {
    const r = await api(`/reports/${CODE}/attachments`, token, {
      method: 'POST',
      body: JSON.stringify({ filename: 'clip.mp4', size, mime: 'video/mp4' }),
    })
    expect(r.status).toBe(201)
    const b = (await r.json()) as { attachmentId: string; partCount: number }
    return { id: b.attachmentId, partCount: b.partCount }
  }
  const putPart = (token: string, id: string, n: number, size: number) =>
    api(`/attachments/${id}/parts/${n}`, token, { method: 'PUT', body: new SparseBlob(size) as unknown as BodyInit })
  const answer = async (r: Response) => ({ status: r.status, body: (await r.json()) as unknown })

  it('row 3: every part uploaded, DELETE, then complete: refused 409 not_uploading and the attachment stays aborted', async () => {
    const token = server.addReport(CODE)
    const { id } = await created(token, 2 * PART)
    expect((await putPart(token, id, 1, PART)).status).toBe(200)
    expect((await putPart(token, id, 2, PART)).status).toBe(200)
    expect(await answer(await api(`/attachments/${id}`, token, { method: 'DELETE' }))).toEqual({ status: 200, body: { ok: true } })
    expect(await answer(await api(`/attachments/${id}/complete`, token, { method: 'POST' }))).toEqual({
      status: 409,
      body: { error: 'not_uploading' },
    })
    expect(server.atts.get(id)!.status).toBe('aborted')
    // Nor can it get parts any more.
    expect(await answer(await putPart(token, id, 2, PART))).toEqual({ status: 409, body: { error: 'not_uploading' } })
  })

  it('row 3 edge: aborted with parts still missing is refused as not_uploading, not missing_parts (the status is read first)', async () => {
    const token = server.addReport(CODE)
    const { id } = await created(token, 2 * PART)
    expect((await putPart(token, id, 1, PART)).status).toBe(200)
    await api(`/attachments/${id}`, token, { method: 'DELETE' })
    expect(await answer(await api(`/attachments/${id}/complete`, token, { method: 'POST' }))).toEqual({
      status: 409,
      body: { error: 'not_uploading' },
    })
  })

  it('row 3 edge: a completed attachment DELETEd and then completed again is refused, never brought back', async () => {
    const token = server.addReport(CODE)
    const { id } = await created(token, PART)
    await putPart(token, id, 1, PART)
    expect(await answer(await api(`/attachments/${id}/complete`, token, { method: 'POST' }))).toEqual({ status: 200, body: { ok: true } })
    await api(`/attachments/${id}`, token, { method: 'DELETE' })
    expect(await answer(await api(`/attachments/${id}/complete`, token, { method: 'POST' }))).toEqual({
      status: 409,
      body: { error: 'not_uploading' },
    })
    expect(server.atts.get(id)!.status).not.toBe('complete')
  })

  it('row 3, the other side of the edge: an attachment never DELETEd completes, and a second complete is the same ok', async () => {
    const token = server.addReport(CODE)
    const { id } = await created(token, 2 * PART)
    await putPart(token, id, 1, PART)
    await putPart(token, id, 2, PART)
    for (let i = 0; i < 2; i++) {
      expect(await answer(await api(`/attachments/${id}/complete`, token, { method: 'POST' }))).toEqual({ status: 200, body: { ok: true } })
    }
    expect(server.atts.get(id)!.status).toBe('complete')
  })
})

describe('row 1: Remove pressed on a video, then Send at once', () => {
  it('row 1 (a): the video mid-upload (parts in flight) is Removed and Send pressed: none of it is sent again nor completed, the others reach done', async () => {
    const token = server.addReport(CODE)
    const gate = deferred()
    server.holdPart = (id) => (server.atts.get(id)?.filename === 'clip.mp4' ? gate.promise : null)
    const h = mount()
    await pick(h, [clip(), small('b.mp4'), small('c.mp4')])
    let p0!: Promise<boolean>
    act(() => {
      p0 = h.result.current.start({ code: CODE, reportToken: token })
    })
    const video = () => server.attsOf(CODE).find((a) => a.filename === 'clip.mp4')
    for (let i = 0; i < 20 && !(video() && server.puts(video()!.id).length > 0); i++) await settle()
    const vid = video()!
    expect(server.puts(vid.id).length).toBeGreaterThan(0)
    expect(vid.parts.size).toBe(0)

    const mark = server.log.length
    let removed!: Promise<void>
    let sent!: Promise<boolean>
    act(() => {
      removed = h.result.current.removeFile(keyOf(h, 'clip.mp4'))
      sent = h.result.current.start({ code: CODE, reportToken: token })
    })
    await settle()
    gate.resolve()
    await act(async () => {
      await drive(Promise.all([removed, sent, p0]))
    })
    await letRun()

    expect(putsAfter(mark).filter((r) => r.id === vid.id)).toEqual([])
    expect(completesOf(vid.id)).toEqual([])
    expect(vid.status).toBe('aborted')
    expect(others().map((a) => [a.filename, a.status])).toEqual([
      ['b.mp4', 'complete'],
      ['c.mp4', 'complete'],
    ])
    expect(names(h)).not.toContain('clip.mp4')
    expect(h.result.current.phase).toBe('done')
  })

  it('row 1 (b): after a reload the saved video is picked again, Removed while its hash is pending, Send; the DELETE answers 503: the video is never uploaded nor completed, keeps its place and its orange line, the others go', async () => {
    const { token, att } = await savedHalfWay()
    server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
    const h2 = mount()
    await pick(h2, [small('b.mp4')])
    const release = holdDigest()
    act(() => h2.result.current.addFiles([clip()]))
    await settle()
    expect(names(h2)).toEqual(['b.mp4', 'clip.mp4'])

    const mark = server.log.length
    let removed!: Promise<void>
    let sent!: Promise<boolean>
    act(() => {
      removed = h2.result.current.removeFile(keyOf(h2, 'clip.mp4'))
      sent = h2.result.current.start({ code: CODE, reportToken: token })
    })
    await settle()
    release()
    await act(async () => {
      await drive(Promise.all([removed, sent]))
    })
    await letRun()

    // The DELETE was sent and failed: the attachment is still open, with only the part of the first visit.
    expect(deletes().length).toBeGreaterThan(0)
    expect(deletes().every((r) => r.path.endsWith(`/attachments/${att.id}`))).toBe(true)
    expect(putsAfter(mark).filter((r) => r.id === att.id)).toEqual([])
    expect(completesOf(att.id)).toEqual([])
    expect(att.status).toBe('uploading')
    expect([...att.parts.keys()]).toEqual([1])
    // Never sent as a new file either.
    expect(server.attsOf(CODE).filter((a) => a.filename === 'clip.mp4')).toEqual([att])
    // The orange remove line, the file in its place, Remove again offered (not busy, not done).
    expect(h2.result.current.unremoved).toBe(true)
    expect(marked('clip.mp4')).toBe(true)
    expect(names(h2)).toEqual(['b.mp4', 'clip.mp4'])
    expect(stateOf(h2, 'clip.mp4')).not.toBe('done')
    expect(h2.result.current.removing).toBe(false)
    expect(h2.result.current.phase).not.toBe('uploading')
    expect(h2.result.current.phase).not.toBe('done')
    // The others went.
    expect(others().map((a) => [a.filename, a.status])).toEqual([['b.mp4', 'complete']])
    expect(stateOf(h2, 'b.mp4')).toBe('done')

    // Remove again, answered 200 { ok: true }: the video goes, still never uploaded.
    server.routeFault = () => null
    await act(async () => {
      await drive(h2.result.current.removeFile(keyOf(h2, 'clip.mp4')))
    })
    await settle()
    expect(h2.result.current.unremoved).toBe(false)
    expect(names(h2)).toEqual(['b.mp4'])
    expect(att.status).toBe('aborted')
    expect(putsAfter(mark).filter((r) => r.id === att.id)).toEqual([])
    expect(completesOf(att.id)).toEqual([])
  })

  it('row 1 (c): Send pressed while the DELETE of a removed video is out: nothing is sent nor completed until it is answered, then the others reach done', async () => {
    const { token, att } = await savedHalfWay()
    const h2 = mount()
    await pick(h2, [clip(), small('b.mp4'), small('c.mp4')])
    expect(names(h2)).toEqual(['clip.mp4', 'b.mp4', 'c.mp4'])
    const gate = deferred()
    server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
    const mark = server.log.length
    let removed!: Promise<void>
    act(() => {
      removed = h2.result.current.removeFile(keyOf(h2, 'clip.mp4'))
    })
    await settle()
    expect(deletes()).toHaveLength(1)
    let sent!: Promise<boolean>
    act(() => {
      sent = h2.result.current.start({ code: CODE, reportToken: token })
    })
    // Long enough for a first part to go out, short of any timeout a slow DELETE might meet.
    await letRun(5_000)
    // The DELETE is still unanswered: no part and no complete of any file has started.
    const started = server.log.slice(mark).filter((r) => r.method === 'PUT' || r.path.endsWith('/complete'))
    expect(started).toEqual([])

    gate.resolve()
    server.holdRoute = () => null
    await act(async () => {
      await drive(Promise.all([removed, sent]))
    })
    await letRun()

    expect(att.status).toBe('aborted')
    expect(putsAfter(mark).filter((r) => r.id === att.id)).toEqual([])
    expect(completesOf(att.id)).toEqual([])
    expect(others().map((a) => [a.filename, a.status])).toEqual([
      ['b.mp4', 'complete'],
      ['c.mp4', 'complete'],
    ])
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4'])
    expect(h2.result.current.phase).toBe('done')
    expect(loadSession()).toBeNull()
  })
})

describe('row 2: a Remove still going when the page is left never overwrites the session made since', () => {
  const answers: [string, Fault][] = [
    ['200 { ok: true }', 'ok'],
    ['503', { status: 503 }],
  ]

  // Another report's upload started on the page navigated to, held after its first part, so its session is the one
  // a reload must find. Answers with that session as saved, and a way to let the upload finish.
  async function otherUpload() {
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
    const saved = loadSession()
    expect(saved).toMatchObject({ code: OTHER, reportToken: tokenB, files: [{ name: 'b.mp4', attachmentId: attB.id }] })
    const finish = async () => {
      server.holdPart = () => null
      parts.resolve()
      let ok = false
      await act(async () => {
        ok = await drive(p)
      })
      await settle()
      return ok
    }
    return { h3, attB, saved: structuredClone(saved), finish }
  }
  // Holds the first DELETE (the old page's) until released; any later one answers as usual.
  function holdFirstDelete() {
    const gate = deferred()
    let first = true
    server.holdRoute = (m) => {
      if (m !== 'DELETE' || !first) return null
      first = false
      return gate.promise
    }
    return gate
  }

  it.each(answers)(
    'row 2 (Astra): Remove while the re-pick is hashing, page left, another report uploading, then the hash and the old DELETE (%s) answer: the new session is unchanged and its upload finishes',
    async (_label, fault) => {
      await savedHalfWay()
      server.routeFault = (m) => (m === 'DELETE' ? fault : null)
      const h2 = mount()
      const release = holdDigest()
      act(() => h2.result.current.addFiles([clip()]))
      await settle()
      expect(names(h2)).toEqual(['clip.mp4'])
      const gate = holdFirstDelete()
      act(() => {
        void h2.result.current.removeFile(keyOf(h2, 'clip.mp4'))
      })
      await settle()
      h2.unmount()

      // The old hash stays held (it awaits the knob it read); hashes from now on answer as usual.
      normalDigest()
      const { h3, attB, saved, finish } = await otherUpload()

      release()
      await settle()
      gate.resolve()
      await letRun()
      expect(loadSession()).toEqual(saved)

      expect(await finish()).toBe(true)
      expect(h3.result.current.phase).toBe('done')
      expect(attB.status).toBe('complete')
      expect(loadSession()).toBeNull()
    },
  )

  it.each(answers)(
    'row 2: Remove whose DELETE is out when the page is left (no hash pending), the old DELETE answers %s after another report started: the new session is unchanged and its upload finishes',
    async (_label, fault) => {
      await savedHalfWay()
      server.routeFault = (m) => (m === 'DELETE' ? fault : null)
      const h2 = mount()
      await pick(h2, [clip()])
      const gate = holdFirstDelete()
      act(() => {
        void h2.result.current.removeFile(keyOf(h2, 'clip.mp4'))
      })
      await settle()
      expect(deletes()).toHaveLength(1)
      h2.unmount()

      const { h3, attB, saved, finish } = await otherUpload()

      gate.resolve()
      await letRun()
      expect(loadSession()).toEqual(saved)

      expect(await finish()).toBe(true)
      expect(h3.result.current.phase).toBe('done')
      expect(attB.status).toBe('complete')
      expect(loadSession()).toBeNull()
    },
  )
})
