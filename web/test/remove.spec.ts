// Decided behaviour B1 (lead, final critical round) on useUpload, against the fake worker: Remove of a file whose
// attachment exists. The saved line is marked `removing: true` before the DELETE; 200 or 404 drops the file and its
// line; any other failure keeps both (still marked) and Remove again retries; a page left while the DELETE is out is
// finished by the next load in the background: the removed file is never asked for again and never holds one of the
// 3 places. A reload is an unmount followed by a new mount: nothing survives it but sessionStorage and the server.
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
const line = (name: string) => loadSession()?.files.find((f) => f.name === name)
// The flag is the decided shape of the saved line (B1); read without the type, which does not carry it yet.
const marked = (name: string) => (line(name) as { removing?: unknown } | undefined)?.removing
const names = (h: Hook) => h.result.current.files.map((f) => f.name)

// A reload in the middle of an upload of a.mp4: its attachment exists on the server and in the saved session.
async function savedHalfWay() {
  const token = server.addReport(CODE)
  server.holdPart = (_id, n) => (n > 1 ? never() : null)
  const h = mount()
  act(() => h.result.current.addFiles([file('a.mp4', 4 * PART)]))
  let p!: Promise<boolean>
  act(() => {
    p = h.result.current.start({ code: CODE, reportToken: token })
  })
  await act(() => flush())
  h.unmount()
  await act(async () => {
    await drive(p)
  })
  server.holdPart = () => null
  const att = server.attsOf(CODE)[0]!
  expect(line('a.mp4')).toMatchObject({ attachmentId: att.id, done: false })
  return { token, att }
}

// The next visit with the same file picked again (not sent yet), ready to be removed.
function repicked(): Hook {
  const h = mount()
  act(() => h.result.current.addFiles([file('a.mp4', 4 * PART)]))
  expect(names(h)).toEqual(['a.mp4'])
  return h
}

async function removeFirst(h: Hook): Promise<void> {
  const key = h.result.current.files[0]!.key
  await act(async () => {
    await drive(h.result.current.removeFile(key))
  })
}

// Starts a Remove whose DELETE the server holds, and leaves it pending.
async function removeHeld(h: Hook): Promise<{ p: Promise<void>; answer(): void }> {
  const gate = deferred()
  server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
  const key = h.result.current.files[0]!.key
  let p!: Promise<void>
  act(() => {
    p = h.result.current.removeFile(key)
  })
  await act(() => flush())
  return { p, answer: () => gate.resolve() }
}

describe('decided B1: Remove of a file whose attachment exists', () => {
  it('B1: the saved line is marked removing before the DELETE is answered, and a 200 drops the file and its line', async () => {
    const { token, att } = await savedHalfWay()
    const h = repicked()
    const del = await removeHeld(h)
    // Not yet answered: the request is out, the line is marked, the file is still listed and nothing failed.
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0]).toMatchObject({ path: expect.stringContaining(`/attachments/${att.id}`), token })
    expect(marked('a.mp4')).toBe(true)
    expect(names(h)).toEqual(['a.mp4'])
    expect(h.result.current.removing).toBe(true)
    expect(h.result.current.unremoved).toBe(false)

    del.answer()
    await act(async () => {
      await drive(del.p)
    })
    expect(att.status).toBe('aborted')
    expect(names(h)).toEqual([])
    expect(line('a.mp4')).toBeUndefined()
    expect(h.result.current.removing).toBe(false)
    expect(h.result.current.unremoved).toBe(false)
    expect(h.result.current.resume).toBeNull()
  })

  it('B1: a 404 (the attachment is already gone) drops the file and its line like a 200', async () => {
    await savedHalfWay()
    server.routeFault = (m) => (m === 'DELETE' ? { status: 404, error: 'not_found' } : null)
    const h = repicked()
    await removeFirst(h)
    expect(deletes()).toHaveLength(1)
    expect(names(h)).toEqual([])
    expect(line('a.mp4')).toBeUndefined()
    expect(h.result.current.unremoved).toBe(false)
  })

  const failures: [string, Fault][] = [
    ['a 503', { status: 503 }],
    ['no network', 'network'],
    ['a 401', { status: 401, error: 'invalid_token' }],
  ]
  it.each(failures)(
    'B1: %s on the DELETE keeps the file and its marked line, shows the failure, and Remove again retries',
    async (_label, fault) => {
      const { att } = await savedHalfWay()
      server.routeFault = (m, _p, k) => (m === 'DELETE' && k === 1 ? fault : null)
      const h = repicked()
      await removeFirst(h)
      expect(deletes()).toHaveLength(1)
      expect(names(h)).toEqual(['a.mp4'])
      expect(h.result.current.unremoved).toBe(true)
      expect(h.result.current.removing).toBe(false)
      expect(line('a.mp4')).toMatchObject({ attachmentId: att.id })
      expect(marked('a.mp4')).toBe(true)
      expect(att.status).toBe('uploading')

      await removeFirst(h)
      expect(deletes()).toHaveLength(2)
      expect(names(h)).toEqual([])
      expect(line('a.mp4')).toBeUndefined()
      expect(h.result.current.unremoved).toBe(false)
      expect(att.status).toBe('aborted')
    },
  )

  it('B1 edge: a file with no attachment yet (picked, never sent) goes at once, with no DELETE', async () => {
    const h = mount()
    act(() => h.result.current.addFiles([file('a.mp4', 2 * MiB)]))
    await removeFirst(h)
    expect(names(h)).toEqual([])
    expect(deletes()).toEqual([])
    expect(server.log).toEqual([])
  })
})

describe('decided B1: a page left while the DELETE is out is finished by the next load', () => {
  // The first visit removes a.mp4 and is left before the answer; the server then deletes the attachment.
  async function leftMidDelete() {
    const saved = await savedHalfWay()
    const h1 = repicked()
    const del = await removeHeld(h1)
    h1.unmount()
    del.answer()
    await act(async () => {
      await drive(del.p)
    })
    server.holdRoute = () => null
    expect(saved.att.status).toBe('aborted')
    return saved
  }

  it('B1 reload: the next load is never asked for the removed file, sends the DELETE again and drops the line on 200', async () => {
    const { token, att } = await leftMidDelete()
    const h2 = mount()
    expect(h2.result.current.resume).toBeNull()
    await act(() => flush())
    expect(deletes()).toHaveLength(2)
    expect(deletes()[1]).toMatchObject({ path: expect.stringContaining(`/attachments/${att.id}`), token })
    expect(line('a.mp4')).toBeUndefined()
    expect(h2.result.current.resume).toBeNull()
    expect(names(h2)).toEqual([])
  })

  it('B1 reload: a 404 to the DELETE of the next load drops the line too', async () => {
    await leftMidDelete()
    server.routeFault = (m) => (m === 'DELETE' ? { status: 404, error: 'not_found' } : null)
    const h2 = mount()
    await act(() => flush())
    expect(deletes()).toHaveLength(2)
    expect(line('a.mp4')).toBeUndefined()
    expect(h2.result.current.resume).toBeNull()
  })

  it('B1 reload: offline at the next load the file is still not asked for, the line stays marked, and a later load finishes it', async () => {
    await leftMidDelete()
    server.offline = true
    const h2 = mount()
    await act(() => flush())
    expect(deletes()).toHaveLength(2)
    expect(h2.result.current.resume).toBeNull()
    expect(marked('a.mp4')).toBe(true)
    h2.unmount()

    server.offline = false
    const h3 = mount()
    expect(h3.result.current.resume).toBeNull()
    await act(() => flush())
    expect(deletes()).toHaveLength(3)
    expect(line('a.mp4')).toBeUndefined()
  })

  it('B1 reload: while that background DELETE is out the removed file holds none of the 3 places', async () => {
    const { token } = await leftMidDelete()
    const gate = deferred()
    server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
    const h2 = mount()
    await act(() => flush())
    expect(deletes()).toHaveLength(2)
    act(() => h2.result.current.addFiles([file('b.mp4', 2 * MiB), file('c.mp4', 2 * MiB), file('d.mp4', 2 * MiB)]))
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4', 'd.mp4'])
    expect(h2.result.current.rejection).toBeNull()

    gate.resolve()
    server.holdRoute = () => null
    await act(() => flush())
    expect(line('a.mp4')).toBeUndefined()
    let ok = false
    await act(async () => {
      ok = await drive(h2.result.current.start({ code: CODE, reportToken: token }))
    })
    expect(ok).toBe(true)
    expect(h2.result.current.phase).toBe('done')
    expect(server.attsOf(CODE).filter((a) => a.status === 'complete').map((a) => a.filename)).toEqual([
      'b.mp4',
      'c.mp4',
      'd.mp4',
    ])
    expect(loadSession()).toBeNull()
  })
})
