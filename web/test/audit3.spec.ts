// The four pick rules of the web-fix round that had no spec (bp-web-fix audit.md, findings 1-4), on useUpload against
// the fake worker. A pick whose outcome a hash may change waits in a queue for its hashes ("queued path"); any other
// pick is listed at once and bound to its saved line once hashed ("fast path"). A reload is an unmount followed by a
// new mount: nothing survives it but sessionStorage and the server.
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
} from './helpers'

const CODE = 'LUM-482193'
const A: Content = { seed: 11 }
const B: Content = { seed: 12 }
const C: Content = { seed: 13 }
let server: FakeServer
let restore: (() => void)[] = []

beforeEach(() => {
  useFakeClock()
  installStorage()
  server = new FakeServer().install()
})
afterEach(() => {
  restore.forEach((r) => r())
  restore = []
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
const a = () => file('a.mp4', 2 * PART, 'video/mp4', 1000, A)
const b = () => file('b.mp4', 2 * MiB, 'video/mp4', 1000, B)
const c = () => file('c.mp4', 2 * MiB, 'video/mp4', 1000, C)

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await flush()
      await new Promise<void>((r) => setImmediate(r))
    }
  })
}
async function pick(h: Hook, files: File[], onBack?: () => void): Promise<void> {
  act(() => h.result.current.addFiles(files, onBack))
  await settle()
}
async function remove(h: Hook, name: string): Promise<void> {
  const key = h.result.current.files.find((f) => f.name === name)!.key
  await act(async () => {
    await drive(h.result.current.removeFile(key))
  })
  await settle()
}
// Holds every digest until released, a stand-in for a phone hashing 1 MiB (the seam of setup.ts answers at once).
function holdDigest(): () => void {
  const subtle = crypto.subtle
  const seam = subtle.digest
  const gate = deferred()
  const held = async (algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> => {
    await gate.promise
    return seam.call(subtle, algorithm, data)
  }
  Object.defineProperty(subtle, 'digest', { value: held, configurable: true, writable: true })
  restore.push(() => Object.defineProperty(subtle, 'digest', { value: seam, configurable: true, writable: true }))
  return () => gate.resolve()
}
// A first visit with `files` picked and sent, left once `ready` holds (the rest blocks on the fake server).
async function firstVisit(files: File[], ready: () => boolean) {
  const token = server.addReport(CODE)
  const h = mount()
  await pick(h, files)
  let p!: Promise<boolean>
  act(() => {
    p = h.result.current.start({ code: CODE, reportToken: token })
  })
  for (let i = 0; i < 20 && !ready(); i++) await settle()
  expect(ready()).toBe(true)
  h.unmount()
  await act(async () => {
    await drive(p)
  })
  server.holdPart = () => null
  server.holdCreate = null
  return token
}

describe('audit finding 1: on the queued path a copy of a removed file is never bound to the attachment being deleted', () => {
  it('finding 1: saved a (removed, DELETE out), b and c open; picking b and a again lists b and refuses the new a as count, never binding it', async () => {
    server.holdPart = (_id, n) => (n > 1 ? never() : null)
    const token = await firstVisit([a(), b(), c()], () => server.attsOf(CODE)[0]?.parts.size === 1)
    const old = server.attsOf(CODE)[0]!
    // Visit 2: a.mp4 picked again and Removed; the DELETE fails, its line stays marked, the page is left.
    server.routeFault = (m) => (m === 'DELETE' ? 'network' : null)
    const h2 = mount()
    await pick(h2, [a()])
    await remove(h2, 'a.mp4')
    expect(h2.result.current.unremoved).toBe(true)
    expect(marked('a.mp4')).toBe(true)
    h2.unmount()

    // Visit 3: the background DELETE is out; the player picks b again and, by mistake, a (one pick: queued).
    server.routeFault = () => null
    const gate = deferred()
    server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
    const h3 = mount()
    await settle()
    expect(deletes()).toHaveLength(2)
    await pick(h3, [b(), a()])
    expect(names(h3)).toEqual(['b.mp4'])
    expect(h3.result.current.rejection).toBe('count')

    // The DELETE lands: the place frees, and a picked now is a new file with its own attachment.
    gate.resolve()
    server.holdRoute = () => null
    await settle()
    expect(old.status).toBe('aborted')
    expect(line('a.mp4')).toBeUndefined()
    await pick(h3, [a()])
    expect(names(h3)).toEqual(['b.mp4', 'a.mp4'])
    const mark = server.log.length
    await act(async () => {
      await drive(h3.result.current.start({ code: CODE, reportToken: token }))
    })
    expect(h3.result.current.refused).toBeNull()
    expect(server.log.slice(mark).filter((r) => r.method === 'PUT' && r.id === old.id)).toEqual([])
    const fresh = server.attsOf(CODE).filter((x) => x.filename === 'a.mp4' && x.id !== old.id)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]!.status).toBe('complete')
  })
})

describe('audit finding 2: re-picking the last missing file after a reload is the whole action (onBack)', () => {
  it('finding 2: with two files saved, the pick of the first does not call onBack; the pick of the last one calls it once', async () => {
    server.holdCreate = never()
    await firstVisit([a(), b()], () => loadSession()?.files.length === 2)
    const h2 = mount()
    expect(h2.result.current.resume?.missing.map((m) => m.name)).toEqual(['a.mp4', 'b.mp4'])
    const onBack = vi.fn()
    await pick(h2, [a()], onBack)
    expect(h2.result.current.resume?.missing.map((m) => m.name)).toEqual(['b.mp4'])
    expect(onBack).not.toHaveBeenCalled()
    await pick(h2, [b()], onBack)
    expect(h2.result.current.resume?.missing ?? []).toEqual([])
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('finding 2 edge: a new file picked after a reload is not a file back, so onBack is not called', async () => {
    server.holdCreate = never()
    await firstVisit([a()], () => loadSession()?.files.length === 1)
    const h2 = mount()
    const onBack = vi.fn()
    await pick(h2, [b()], onBack)
    expect(names(h2)).toEqual(['b.mp4'])
    expect(onBack).not.toHaveBeenCalled()
  })
})

describe('audit finding 3: a pick made while an earlier pick waits in the queue waits behind it', () => {
  it('finding 3: saved b and c open; picks [b, x] (queued) then [b] at once list b and x, in that order, and refuse nothing', async () => {
    server.holdCreate = never()
    await firstVisit([b(), c()], () => loadSession()?.files.length === 2)
    const h2 = mount()
    act(() => {
      h2.result.current.addFiles([b(), file('x.mp4', 2 * MiB, 'video/mp4', 1000, { seed: 14 })])
      h2.result.current.addFiles([b()])
    })
    await settle()
    expect(names(h2)).toEqual(['b.mp4', 'x.mp4'])
    expect(h2.result.current.rejection).toBeNull()
    expect(h2.result.current.resume?.missing.map((m) => m.name)).toEqual(['c.mp4'])
  })
})

describe('audit finding 4: a queued pick never lands in a list emptied by reset() (Back)', () => {
  it('finding 4: two clips with the same name and size, Back before their hashes answer: the emptied form stays empty', async () => {
    const release = holdDigest()
    const h = mount()
    act(() =>
      h.result.current.addFiles([
        file('a.mp4', 2 * MiB, 'video/mp4', 1000, { seed: 1 }),
        file('a.mp4', 2 * MiB, 'video/mp4', 1000, { seed: 2 }),
      ]),
    )
    await settle()
    // Not yet: twins wait for their hashes before they are listed.
    expect(names(h)).toEqual([])
    act(() => h.result.current.reset())
    release()
    await settle()
    expect(names(h)).toEqual([])
    expect(h.result.current.rejection).toBeNull()
  })

  it('finding 4: Back while a pick waits for the DELETE it sent again: the emptied form stays empty when it answers', async () => {
    server.holdPart = (_id, n) => (n > 1 ? never() : null)
    await firstVisit([a()], () => server.attsOf(CODE)[0]?.parts.size === 1)
    server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
    const h2 = mount()
    await pick(h2, [a()])
    await remove(h2, 'a.mp4')
    h2.unmount()
    // The next load's background DELETE fails too; then a pick that needs a's place sends it again, held here.
    const h3 = mount()
    await settle()
    expect(deletes()).toHaveLength(2)
    server.routeFault = () => null
    const gate = deferred()
    server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
    act(() => h3.result.current.addFiles([b(), c(), file('d.mp4', 2 * MiB, 'video/mp4', 1000, { seed: 15 })]))
    await settle()
    expect(deletes()).toHaveLength(3)
    act(() => h3.result.current.reset())
    gate.resolve()
    server.holdRoute = () => null
    await settle()
    expect(names(h3)).toEqual([])
    expect(h3.result.current.rejection).toBeNull()
  })
})
