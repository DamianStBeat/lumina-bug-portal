// web-fix rows 3 and 4 on useUpload, against the fake worker: a removed file frees its place among the report's 3 only
// once the server's DELETE answered 2xx with `{ ok: true }` (or 404, already gone). Until then it counts against the 3,
// in the visit where Remove failed and after a reload, as the server still counts its attachment. A DELETE answered
// 200 with anything but `{ ok: true }` is a failed remove. A reload is an unmount followed by a new mount.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSession } from '../src/upload/session'
import { useUpload } from '../src/upload/useUpload'
import {
  CONTRACT_PART_SIZE as PART,
  FakeServer,
  MiB,
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
// The flag is the decided shape of a removed saved line (B1); read without the type, which may not carry it.
const marked = (name: string) => (line(name) as { removing?: unknown } | undefined)?.removing
const names = (h: Hook) => h.result.current.files.map((f) => f.name)
const isDelete = (m: string) => m === 'DELETE'

// Lets every pending chain run without moving the clock, the hashing of a pick included (crypto.subtle answers from
// Node's thread pool, so the loop also yields to the real event loop).
async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await flush()
      await new Promise<void>((r) => setImmediate(r))
    }
  })
}
// A pick as the page makes it; addFiles may answer at once or once the files are hashed.
async function pick(h: Hook, files: File[]): Promise<void> {
  await act(async () => {
    await Promise.resolve(h.result.current.addFiles(files))
  })
  await settle()
}
async function remove(h: Hook, name: string): Promise<void> {
  const key = h.result.current.files.find((f) => f.name === name)!.key
  await act(async () => {
    await drive(h.result.current.removeFile(key))
  })
  await settle()
}

// A first visit that sent part 1 of a.mp4 and was left: its attachment holds one of the report's places.
async function savedHalfWay() {
  const token = server.addReport(CODE)
  server.holdPart = (_id, n) => (n > 1 ? never() : null)
  const h = mount()
  await pick(h, [file('a.mp4', 4 * PART)])
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
  return { token, att }
}

// The saved a.mp4 picked again and Removed in a visit whose DELETE fails; the page is then left.
async function removeFailedThenLeft(fault: Fault = { status: 503 }) {
  const saved = await savedHalfWay()
  server.routeFault = (m) => (isDelete(m) ? fault : null)
  const h1 = mount()
  await pick(h1, [file('a.mp4', 4 * PART)])
  await remove(h1, 'a.mp4')
  expect(h1.result.current.unremoved).toBe(true)
  expect(marked('a.mp4')).toBe(true)
  h1.unmount()
  return saved
}

describe('web-fix row 3: Remove fails, then another file is picked', () => {
  it('row 3: in the visit the place stays taken: the orange remove line, Remove again possible, a fourth file refused as count', async () => {
    const { att } = await savedHalfWay()
    server.routeFault = (m, _p, k) => (isDelete(m) && k === 1 ? { status: 503 } : null)
    const h = mount()
    await pick(h, [file('a.mp4', 4 * PART), file('b.mp4', 2 * MiB), file('c.mp4', 2 * MiB)])
    expect(names(h)).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
    await remove(h, 'a.mp4')
    expect(deletes()).toHaveLength(1)
    expect(h.result.current.unremoved).toBe(true)
    expect(h.result.current.removing).toBe(false)
    expect(names(h)).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
    expect(att.status).toBe('uploading')

    await pick(h, [file('d.mp4', 2 * MiB)])
    expect(h.result.current.rejection).toBe('count')
    expect(names(h)).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])

    // Try again (Remove again): the server answers 200 { ok: true } and the place frees.
    await remove(h, 'a.mp4')
    expect(deletes()).toHaveLength(2)
    expect(h.result.current.unremoved).toBe(false)
    expect(names(h)).toEqual(['b.mp4', 'c.mp4'])
    expect(line('a.mp4')).toBeUndefined()
    expect(att.status).toBe('aborted')
    await pick(h, [file('d.mp4', 2 * MiB)])
    expect(h.result.current.rejection).toBeNull()
    expect(names(h)).toEqual(['b.mp4', 'c.mp4', 'd.mp4'])
  })

  it('row 3: after a reload whose background DELETE fails the removed file still holds its place, so the third new file is refused at pick, never by the server', async () => {
    const { token, att } = await removeFailedThenLeft()
    const h2 = mount()
    await settle()
    expect(deletes()).toHaveLength(2)
    // Never asked for again, but its attachment is still open on the server.
    expect(h2.result.current.resume).toBeNull()
    expect(marked('a.mp4')).toBe(true)
    expect(att.status).toBe('uploading')

    await pick(h2, [file('b.mp4', 2 * MiB), file('c.mp4', 2 * MiB), file('d.mp4', 2 * MiB)])
    expect(h2.result.current.rejection).toBe('count')
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4'])

    // What was accepted goes up: the server refuses nothing.
    let ok = false
    await act(async () => {
      ok = await drive(h2.result.current.start({ code: CODE, reportToken: token }))
    })
    expect(ok).toBe(true)
    expect(h2.result.current.refused).toBeNull()
    expect(h2.result.current.files.map((f) => f.state)).toEqual(['done', 'done'])
    expect(server.requests('POST', `/reports/${CODE}/attachments`)).toHaveLength(3)
    h2.unmount()

    // The next load's DELETE succeeds: the line goes and the place frees.
    server.routeFault = () => null
    const h3 = mount()
    await settle()
    expect(deletes()).toHaveLength(3)
    expect(att.status).toBe('aborted')
    expect(line('a.mp4')).toBeUndefined()
    await pick(h3, [file('d.mp4', 2 * MiB)])
    expect(h3.result.current.rejection).toBeNull()
    expect(names(h3)).toEqual(['d.mp4'])
  })

  // After a reload whose background DELETE failed: a pick that needs the removed file's place sends that DELETE again
  // first, and its answer decides the pick.
  async function backgroundDeleteFailed() {
    const saved = await removeFailedThenLeft()
    const h2 = mount()
    await settle()
    expect(deletes()).toHaveLength(2)
    expect(marked('a.mp4')).toBe(true)
    return { ...saved, h2 }
  }

  it('row 3 retry: the pick that needs the place sends the DELETE again; answered 200 { ok: true } the pick is accepted', async () => {
    const { att, h2 } = await backgroundDeleteFailed()
    server.routeFault = () => null
    await pick(h2, [file('b.mp4', 2 * MiB), file('c.mp4', 2 * MiB), file('d.mp4', 2 * MiB)])
    expect(deletes()).toHaveLength(3)
    expect(att.status).toBe('aborted')
    expect(line('a.mp4')).toBeUndefined()
    expect(h2.result.current.rejection).toBeNull()
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4', 'd.mp4'])
  })

  it('row 3 retry: the DELETE sent again fails again, so the pick is refused as count and the line stays marked', async () => {
    const { att, h2 } = await backgroundDeleteFailed()
    await pick(h2, [file('b.mp4', 2 * MiB), file('c.mp4', 2 * MiB), file('d.mp4', 2 * MiB)])
    expect(deletes()).toHaveLength(3)
    expect(att.status).toBe('uploading')
    expect(marked('a.mp4')).toBe(true)
    expect(h2.result.current.rejection).toBe('count')
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4'])
  })

  it('row 3 edge: with the removed file holding its place, two new files fit and are accepted', async () => {
    await removeFailedThenLeft()
    const h2 = mount()
    await settle()
    await pick(h2, [file('b.mp4', 2 * MiB), file('c.mp4', 2 * MiB)])
    expect(h2.result.current.rejection).toBeNull()
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4'])
  })
})

describe('web-fix row 4: a DELETE answered 200 without { ok: true } is a failed remove', () => {
  const bad: [string, Fault][] = [
    ['200 {}', { status: 200, body: '{}' }],
    ['200 with a body that is not JSON', { status: 200, body: '<html>ok</html>' }],
    ['200 { ok: false }', { status: 200, body: '{"ok":false}' }],
  ]

  it.each(bad)('row 4: %s on Remove keeps the file, its marked line and its place, and Remove again retries', async (_label, fault) => {
    const { att } = await savedHalfWay()
    server.routeFault = (m, _p, k) => (isDelete(m) && k === 1 ? fault : null)
    const h = mount()
    await pick(h, [file('a.mp4', 4 * PART), file('b.mp4', 2 * MiB), file('c.mp4', 2 * MiB)])
    await remove(h, 'a.mp4')
    expect(deletes()).toHaveLength(1)
    expect(h.result.current.unremoved).toBe(true)
    expect(names(h)).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
    expect(line('a.mp4')).toMatchObject({ attachmentId: att.id })
    expect(marked('a.mp4')).toBe(true)
    await pick(h, [file('d.mp4', 2 * MiB)])
    expect(h.result.current.rejection).toBe('count')

    await remove(h, 'a.mp4')
    expect(deletes()).toHaveLength(2)
    expect(h.result.current.unremoved).toBe(false)
    expect(names(h)).toEqual(['b.mp4', 'c.mp4'])
    expect(line('a.mp4')).toBeUndefined()
  })

  it.each(bad)('row 4: %s on the background DELETE of the next load keeps the line marked and its place', async (_label, fault) => {
    await removeFailedThenLeft()
    server.routeFault = (m) => (isDelete(m) ? fault : null)
    const h2 = mount()
    await settle()
    expect(deletes()).toHaveLength(2)
    expect(marked('a.mp4')).toBe(true)
    expect(h2.result.current.resume).toBeNull()
    await pick(h2, [file('b.mp4', 2 * MiB), file('c.mp4', 2 * MiB), file('d.mp4', 2 * MiB)])
    expect(h2.result.current.rejection).toBe('count')
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4'])
  })

  const good: [string, Fault][] = [
    ['200 { ok: true }', 'ok'],
    ['404 not_found', { status: 404, error: 'not_found' }],
  ]
  it.each(good)('row 4: %s on Remove is a success: the file, its line and its place go', async (_label, fault) => {
    await savedHalfWay()
    server.routeFault = (m) => (isDelete(m) ? fault : null)
    const h = mount()
    await pick(h, [file('a.mp4', 4 * PART), file('b.mp4', 2 * MiB), file('c.mp4', 2 * MiB)])
    await remove(h, 'a.mp4')
    expect(deletes()).toHaveLength(1)
    expect(h.result.current.unremoved).toBe(false)
    expect(names(h)).toEqual(['b.mp4', 'c.mp4'])
    expect(line('a.mp4')).toBeUndefined()
    await pick(h, [file('d.mp4', 2 * MiB)])
    expect(h.result.current.rejection).toBeNull()
    expect(names(h)).toEqual(['b.mp4', 'c.mp4', 'd.mp4'])
  })

  it.each(good)('row 4: %s on the background DELETE of the next load drops the line and frees the place', async (_label, fault) => {
    await removeFailedThenLeft()
    server.routeFault = (m) => (isDelete(m) ? fault : null)
    const h2 = mount()
    await settle()
    expect(deletes()).toHaveLength(2)
    expect(line('a.mp4')).toBeUndefined()
    await pick(h2, [file('b.mp4', 2 * MiB), file('c.mp4', 2 * MiB), file('d.mp4', 2 * MiB)])
    expect(h2.result.current.rejection).toBeNull()
    expect(names(h2)).toEqual(['b.mp4', 'c.mp4', 'd.mp4'])
  })
})
