// web-fix rows 1 and 2 on useUpload, against the fake worker and an in-memory sessionStorage: a file picked again
// after a reload is the saved one when its name, its size and the SHA-256 of its first 1 MiB match; `lastModified`
// (which iPhone Photos changes on every export) no longer decides. A reload is an unmount followed by a new mount:
// nothing survives it but sessionStorage and the server, so every saved state here comes from a first visit.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSession } from '../src/upload/session'
import { useUpload, type Target } from '../src/upload/useUpload'
import {
  CONTRACT_PART_SIZE as PART,
  FakeServer,
  MiB,
  drive,
  file,
  flush,
  installStorage,
  useFakeClock,
  type Content,
} from './helpers'

const CODE = 'LUM-482193'
// Two videos with the same name and size and other bytes from the very first one.
const VIDEO: Content = { seed: 1 }
const OTHER_VIDEO: Content = { seed: 2 }
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
const putsAfter = (mark: number) => server.log.slice(mark).filter((r) => r.method === 'PUT')
const createsAfter = (mark: number) =>
  server.log.slice(mark).filter((r) => r.method === 'POST' && r.path.endsWith('/attachments'))
const names = (h: Hook) => h.result.current.files.map((f) => f.name)

// Lets every pending chain run without moving the clock, the hashing of a pick included: crypto.subtle answers from
// Node's thread pool, so the loop also yields to the real event loop.
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
async function startAll(h: Hook, t?: Target): Promise<boolean> {
  let ok = false
  await act(async () => {
    ok = await drive(h.result.current.start(t))
  })
  return ok
}
// Starts, waits until the server holds what `ready` asks for (the rest blocks on the fake server), then reloads.
async function startThenReload(h: Hook, t: Target, ready: () => boolean): Promise<void> {
  let p!: Promise<boolean>
  act(() => {
    p = h.result.current.start(t)
  })
  for (let i = 0; i < 20 && !ready(); i++) await settle()
  expect(ready()).toBe(true)
  h.unmount()
  await act(async () => {
    await drive(p)
  })
}

// A first visit that sent parts 1 and 2 of clip.mp4 (6 parts) and was left: its attachment and saved line exist.
async function savedHalfWay(content: Content, lastModified = 1000) {
  const token = server.addReport(CODE)
  server.holdPart = (_id, n) => (n > 2 ? never() : null)
  const h1 = mount()
  await pick(h1, [file('clip.mp4', 6 * PART, 'video/mp4', lastModified, content)])
  await startThenReload(h1, { code: CODE, reportToken: token }, () => server.attsOf(CODE)[0]?.parts.size === 2)
  server.holdPart = () => null
  const att = server.attsOf(CODE)[0]!
  expect([...att.parts.keys()].sort()).toEqual([1, 2])
  return { token, att }
}

describe('web-fix row 1: half way, reload, the same video picked again with another lastModified, Send', () => {
  it('row 1: it carries on from the missing parts of the saved attachment and reaches done ("We have it")', async () => {
    const { token, att } = await savedHalfWay(VIDEO, 1000)
    const mark = server.log.length
    const h2 = mount()
    expect(h2.result.current.resume).toMatchObject({ code: CODE, missing: [{ name: 'clip.mp4', size: 6 * PART }] })
    await pick(h2, [file('clip.mp4', 6 * PART, 'video/mp4', 2000, VIDEO)])
    // Recognised as the saved file before anything is sent: nothing is missing any more.
    expect(h2.result.current.resume?.missing ?? []).toEqual([])
    expect(names(h2)).toEqual(['clip.mp4'])

    expect(await startAll(h2)).toBe(true)
    expect(h2.result.current.phase).toBe('done')
    expect(h2.result.current.progress).toBe(1)
    expect(createsAfter(mark)).toEqual([])
    expect(putsAfter(mark).filter((r) => r.n === 1 || r.n === 2)).toEqual([])
    expect(new Set(putsAfter(mark).map((r) => r.n))).toEqual(new Set([3, 4, 5, 6]))
    expect(putsAfter(mark).every((r) => r.id === att.id && r.token === token)).toBe(true)
    expect(server.attsOf(CODE).map((a) => a.status)).toEqual(['complete'])
    expect(loadSession()).toBeNull()
  })

  it('row 1 edge: bytes that differ only from offset 1 MiB on (outside the hashed start) are still the saved file', async () => {
    const { att } = await savedHalfWay({ seed: 0 }, 1000)
    const mark = server.log.length
    const h2 = mount()
    await pick(h2, [file('clip.mp4', 6 * PART, 'video/mp4', 2000, { seed: 7, from: MiB })])
    expect(await startAll(h2)).toBe(true)
    expect(h2.result.current.phase).toBe('done')
    expect(createsAfter(mark)).toEqual([])
    expect(new Set(putsAfter(mark).map((r) => r.n))).toEqual(new Set([3, 4, 5, 6]))
    expect(att.status).toBe('complete')
    expect(loadSession()).toBeNull()
  })

  it('row 1 edge: a file shorter than 1 MiB is hashed whole and found again with another lastModified', async () => {
    const token = server.addReport(CODE)
    // The session is written before the attachment is asked for: a reload while create is held still resumes.
    server.holdCreate = never()
    const h1 = mount()
    await pick(h1, [file('short.mp4', 1000, 'video/mp4', 1000, VIDEO)])
    await startThenReload(h1, { code: CODE, reportToken: token }, () => loadSession()?.code === CODE)
    server.holdCreate = null
    expect(server.attsOf(CODE)).toHaveLength(0)

    const h2 = mount()
    expect(h2.result.current.resume).toMatchObject({ missing: [{ name: 'short.mp4', size: 1000 }] })
    await pick(h2, [file('short.mp4', 1000, 'video/mp4', 2000, VIDEO)])
    expect(h2.result.current.resume?.missing ?? []).toEqual([])
    expect(await startAll(h2)).toBe(true)
    expect(h2.result.current.phase).toBe('done')
    expect(server.attsOf(CODE)).toHaveLength(1)
    expect(server.attsOf(CODE)[0]).toMatchObject({ size: 1000, status: 'complete' })
    expect(loadSession()).toBeNull()
  })
})

describe('web-fix row 2: another video with the same name and size picked after the reload, Send', () => {
  // The saved attachment is never fed the other video's bytes: it keeps its two parts and stays open.
  async function sentAsNew(saved: Content, content: Content, lastModified: number) {
    const { att } = await savedHalfWay(saved, 1000)
    const mark = server.log.length
    const h2 = mount()
    await pick(h2, [file('clip.mp4', 6 * PART, 'video/mp4', lastModified, content)])
    // Not the saved file: the saved one is still the one asked for.
    expect(h2.result.current.resume?.missing).toEqual([{ name: 'clip.mp4', size: 6 * PART }])
    expect(names(h2)).toEqual(['clip.mp4'])
    await startAll(h2)
    expect(putsAfter(mark).filter((r) => r.id === att.id)).toEqual([])
    expect([...att.parts.keys()].sort()).toEqual([1, 2])
    expect(att.status).toBe('uploading')
    expect(createsAfter(mark)).toHaveLength(1)
    const fresh = server.attsOf(CODE).filter((a) => a.id !== att.id)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toMatchObject({ filename: 'clip.mp4', size: 6 * PART, status: 'complete' })
    expect(new Set(putsAfter(mark).map((r) => r.n))).toEqual(new Set([1, 2, 3, 4, 5, 6]))
  }

  it('row 2: other bytes with the same lastModified too are a new upload, not the saved one', async () => {
    await sentAsNew(VIDEO, OTHER_VIDEO, 1000)
  })

  it('row 2: other bytes and another lastModified are a new upload, not the saved one', async () => {
    await sentAsNew(VIDEO, OTHER_VIDEO, 2000)
  })

  it('row 2 edge: bytes that differ only at the last byte of the first 1 MiB are another video', async () => {
    await sentAsNew({ seed: 0 }, { seed: 7, from: MiB - 1 }, 1000)
  })
})

describe('web-fix rows 1-2, not yet: a pick whose hash is not known yet', () => {
  // Two picks made before the first is hashed: the second must not be added beside the first.
  async function pickedTwice(second: File): Promise<Hook> {
    const h = mount()
    let a!: unknown
    let b!: unknown
    act(() => {
      a = h.result.current.addFiles([file('clip.mp4', 2 * PART, 'video/mp4', 1000, VIDEO)])
      b = h.result.current.addFiles([second])
    })
    await act(async () => {
      await Promise.all([a, b])
    })
    await settle()
    return h
  }

  it('not yet: the same file picked twice before the first pick is hashed is listed once', async () => {
    const h = await pickedTwice(file('clip.mp4', 2 * PART, 'video/mp4', 1000, VIDEO))
    expect(names(h)).toEqual(['clip.mp4'])
    expect(h.result.current.rejection).toBeNull()
  })

  it('row 1 in the list: the same video picked twice with another lastModified is listed once', async () => {
    const h = await pickedTwice(file('clip.mp4', 2 * PART, 'video/mp4', 2000, VIDEO))
    expect(names(h)).toEqual(['clip.mp4'])
  })

  it('row 2 in the list: another video with the same name and size picked after it is listed beside it', async () => {
    const h = await pickedTwice(file('clip.mp4', 2 * PART, 'video/mp4', 1000, OTHER_VIDEO))
    expect(names(h)).toEqual(['clip.mp4', 'clip.mp4'])
  })

  it('not yet: picks made one after the other keep their order while they are hashed', async () => {
    const h = mount()
    let a!: unknown
    let b!: unknown
    act(() => {
      a = h.result.current.addFiles([
        file('big.mp4', 8 * MiB, 'video/mp4', 1000, { seed: 3 }),
        file('small.mp4', 1000, 'video/mp4', 1000, { seed: 4 }),
      ])
      b = h.result.current.addFiles([file('mid.mp4', 2 * MiB, 'video/mp4', 1000, { seed: 5 })])
    })
    await act(async () => {
      await Promise.all([a, b])
    })
    await settle()
    expect(names(h)).toEqual(['big.mp4', 'small.mp4', 'mid.mp4'])
  })
})
