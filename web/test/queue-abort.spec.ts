// bp-web-upload rows 1-2 on useUpload, the requests the hook stops and the answer it waits for (tests-commit 8): what
// the reducer drops is in queue.spec.ts, and the fake worker refuses a late part or complete on a DELETEd attachment,
// so neither shows whether the hook stopped anything. Here the fake worker's log does: a part cancelled in flight never
// reaches the server (`reached` false) and none is stored, so a phone stops spending data on a video the player left,
// and nothing of it is completed into the report. Remove mid-upload aborts that file's requests (the queue's `abort`);
// leaving the page or starting over aborts every create and upload (`stop`); removeFile() settles only once its DELETE
// is answered. A reload is an unmount followed by a new mount: nothing survives it but sessionStorage and the server.
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

const CODE = 'LUM-482193'
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
function mount() {
  return renderHook(() => useUpload())
}
const never = () => new Promise<void>(() => {})
const deletes = () => server.log.filter((r) => r.method === 'DELETE')
const putsAfter = (mark: number) => server.log.slice(mark).filter((r) => r.method === 'PUT')
const completesOf = (id: string) => server.requests('POST', `/attachments/${id}/complete`)
const names = (h: Hook) => h.result.current.files.map((f) => f.name)
const keyOf = (h: Hook, name: string) => h.result.current.files.find((f) => f.name === name)!.key
const clip = () => file('clip.mp4', 4 * PART, 'video/mp4', 1000, VIDEO)
const small = (name: string) => file(name, 2 * MiB, 'video/mp4')
const video = () => server.attsOf(CODE).find((a) => a.filename === 'clip.mp4')

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
// Tells whether a promise settled, without waiting for it.
function watch<T>(p: Promise<T>): () => boolean {
  let done = false
  p.then(
    () => (done = true),
    () => (done = true),
  )
  return () => done
}

// clip.mp4 (4 parts, then the small files) sent, its parts held by the server once they are out: the three in flight
// are on the network and unanswered when this returns. Releasing the gate lets every held part be answered.
async function clipInFlight(others: File[] = []) {
  const token = server.addReport(CODE)
  const gate = deferred()
  server.holdPart = (id) => (server.atts.get(id)?.filename === 'clip.mp4' ? gate.promise : null)
  const h = mount()
  await pick(h, [clip(), ...others])
  let sent!: Promise<boolean>
  act(() => {
    sent = h.result.current.start({ code: CODE, reportToken: token })
  })
  for (let i = 0; i < 20 && !(video() && server.puts(video()!.id).length >= 3); i++) await settle()
  const vid = video()!
  const held = server.puts(vid.id)
  expect(held.map((r) => r.n)).toEqual([1, 2, 3])
  expect(vid.parts.size).toBe(0)
  return { token, h, vid, held, gate, sent }
}

describe('row 1: Remove on a video mid-upload stops its requests at once', () => {
  it('row 1: Remove while 3 parts of the video are in flight and its DELETE is slow: those parts are cancelled before the server stores them, no further part nor a complete goes out, and the report then goes with the other file', async () => {
    const { h, vid, held, gate, sent } = await clipInFlight([small('b.mp4')])
    const slow = deferred()
    server.holdRoute = (m) => (m === 'DELETE' ? slow.promise : null)
    const mark = server.log.length
    let removed!: Promise<void>
    act(() => {
      removed = h.result.current.removeFile(keyOf(h, 'clip.mp4'))
    })
    await settle()
    expect(deletes().map((r) => r.path)).toEqual([expect.stringMatching(new RegExp(`/attachments/${vid.id}$`))])

    // The parts the server was holding are answered now, while the DELETE is still out: the attachment is open, so
    // a part that was not cancelled would be stored, and the video sent on and completed into the report.
    gate.resolve()
    await letRun(5_000)
    expect(held.map((r) => r.reached)).toEqual([false, false, false])
    expect(vid.parts.size).toBe(0)
    expect(putsAfter(mark).filter((r) => r.id === vid.id)).toEqual([])
    expect(completesOf(vid.id)).toEqual([])
    expect(vid.status).toBe('uploading')
    expect(h.result.current.removing).toBe(true)

    slow.resolve()
    server.holdRoute = () => null
    await act(async () => {
      await drive(Promise.all([removed, sent]))
    })
    await letRun()
    expect(vid.status).toBe('aborted')
    expect(vid.parts.size).toBe(0)
    expect(completesOf(vid.id)).toEqual([])
    expect(names(h)).toEqual(['b.mp4'])
    expect(server.attsOf(CODE).map((a) => [a.filename, a.status])).toEqual([
      ['clip.mp4', 'aborted'],
      ['b.mp4', 'complete'],
    ])
    expect(h.result.current.phase).toBe('done')
  })

  it('row 1, the other side: a video not Removed whose held parts are answered is stored and completed (the gate itself stops nothing)', async () => {
    const { vid, held, gate, sent } = await clipInFlight()
    gate.resolve()
    let ok = false
    await act(async () => {
      ok = await drive(sent)
    })
    expect(ok).toBe(true)
    expect(held.map((r) => r.reached)).toEqual([true, true, true])
    expect(vid.parts.size).toBe(4)
    expect(vid.status).toBe('complete')
  })
})

describe('row 2: leaving the page or starting over stops every create and upload', () => {
  it('row 2: the page is left while 3 parts are in flight: they are cancelled, no part nor complete follows, and the next visit finds the attachment open with no part, ready to resume', async () => {
    const { h, vid, held, gate, sent } = await clipInFlight()
    const mark = server.log.length
    h.unmount()
    gate.resolve()
    await act(async () => {
      await drive(sent)
    })
    await letRun()
    expect(held.map((r) => r.reached)).toEqual([false, false, false])
    expect(putsAfter(mark)).toEqual([])
    expect(completesOf(vid.id)).toEqual([])
    expect(vid.parts.size).toBe(0)
    expect(vid.status).toBe('uploading')
    // The saved line still names it, so the next visit offers to resume it.
    expect(loadSession()?.files).toEqual([expect.objectContaining({ name: 'clip.mp4', attachmentId: vid.id, done: false })])
    const h2 = mount()
    await settle()
    expect(h2.result.current.resume).not.toBeNull()
  })

  it('row 2: the player starts over (reset) while 3 parts are in flight: they are cancelled and the video never joins the report', async () => {
    const { h, vid, held, gate, sent } = await clipInFlight()
    const mark = server.log.length
    act(() => h.result.current.reset())
    gate.resolve()
    let ok = true
    await act(async () => {
      ok = await drive(sent)
    })
    await letRun()
    expect(ok).toBe(false)
    expect(held.map((r) => r.reached)).toEqual([false, false, false])
    expect(putsAfter(mark)).toEqual([])
    expect(completesOf(vid.id)).toEqual([])
    expect(vid.parts.size).toBe(0)
    expect(vid.status).not.toBe('complete')
    expect(h.result.current.files).toEqual([])
    expect(loadSession()).toBeNull()
  })

  it('row 2: the page is left while the attachment is being created: the create is cancelled and no attachment holds one of the 3 places', async () => {
    const token = server.addReport(CODE)
    const gate = deferred()
    server.holdCreate = gate.promise
    const h = mount()
    await pick(h, [clip()])
    let sent!: Promise<boolean>
    act(() => {
      sent = h.result.current.start({ code: CODE, reportToken: token })
    })
    await settle()
    const creates = server.requests('POST', `/reports/${CODE}/attachments`)
    expect(creates).toHaveLength(1)
    h.unmount()
    gate.resolve()
    server.holdCreate = null
    await act(async () => {
      await drive(sent)
    })
    await letRun()
    expect(creates[0]!.reached).toBe(false)
    expect(server.attsOf(CODE)).toEqual([])
    expect(server.puts()).toEqual([])
  })
})

describe('removeFile() settles when the Remove took effect, not when it was pressed', () => {
  // A first visit that sent part 1 of clip.mp4 and was left, then the same file picked again: its attachment exists.
  async function repickedSaved(): Promise<{ h: Hook; id: string }> {
    const token = server.addReport(CODE)
    server.holdPart = (_id, n) => (n > 1 ? never() : null)
    const h0 = mount()
    await pick(h0, [clip()])
    let p!: Promise<boolean>
    act(() => {
      p = h0.result.current.start({ code: CODE, reportToken: token })
    })
    for (let i = 0; i < 20 && video()?.parts.size !== 1; i++) await settle()
    h0.unmount()
    await act(async () => {
      await drive(p)
    })
    server.holdPart = () => null
    const h = mount()
    await pick(h, [clip()])
    expect(names(h)).toEqual(['clip.mp4'])
    return { h, id: video()!.id }
  }

  const answers: [string, Fault, string[], boolean][] = [
    ['200 { ok: true }: the file has left the list', 'ok', [], false],
    ['503: the file stays, marked as not removed', { status: 503 }, ['clip.mp4'], true],
  ]
  it.each(answers)(
    'removeFile: pending while its DELETE is out (the file still listed as removing), settled once it is answered %s',
    async (_label, fault, left, unremoved) => {
      const { h, id } = await repickedSaved()
      const slow = deferred()
      server.holdRoute = (m) => (m === 'DELETE' ? slow.promise : null)
      server.routeFault = (m) => (m === 'DELETE' ? fault : null)
      let removed!: Promise<void>
      act(() => {
        removed = h.result.current.removeFile(keyOf(h, 'clip.mp4'))
      })
      const settled = watch(removed)
      await letRun(5_000)
      expect(deletes().map((r) => r.path)).toEqual([expect.stringMatching(new RegExp(`/attachments/${id}$`))])
      expect(settled()).toBe(false)
      expect(names(h)).toEqual(['clip.mp4'])
      expect(h.result.current.removing).toBe(true)

      slow.resolve()
      await act(async () => {
        await drive(removed)
      })
      expect(settled()).toBe(true)
      expect(names(h)).toEqual(left)
      expect(h.result.current.removing).toBe(false)
      expect(h.result.current.unremoved).toBe(unremoved)
    },
  )

  it('removeFile, the other side: a file with no attachment yet (never sent) needs no DELETE and settles at once', async () => {
    const h = mount()
    await pick(h, [small('b.mp4')])
    let removed!: Promise<void>
    act(() => {
      removed = h.result.current.removeFile(keyOf(h, 'b.mp4'))
    })
    const settled = watch(removed)
    await settle()
    expect(settled()).toBe(true)
    expect(deletes()).toEqual([])
    expect(names(h)).toEqual([])
  })

  it('removeFile, not yet listed: a key the list does not hold changes nothing and settles at once', async () => {
    const h = mount()
    await pick(h, [small('b.mp4')])
    let removed!: Promise<void>
    act(() => {
      removed = h.result.current.removeFile('no-such-key')
    })
    const settled = watch(removed)
    await settle()
    expect(settled()).toBe(true)
    expect(deletes()).toEqual([])
    expect(names(h)).toEqual(['b.mp4'])
  })
})
