// The two defects of the web-fix red team (bp-web-fix redteam-astra.md), on useUpload against the fake worker, with
// the digest knobs of test/setup.ts. A: a file whose first 1 MiB could not be hashed (head null) never binds to a
// saved line, and a saved line with head null never matches (lead's rule); such a pick is a new upload, and it is
// still listed and sent. B: Remove pressed on a listed file always takes effect, even while its hash is pending and
// the re-pick of the last missing file is about to start the upload by itself. A reload is an unmount followed by a
// new mount: nothing survives it but sessionStorage and the server.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSession } from '../src/upload/session'
import { useUpload } from '../src/upload/useUpload'
import { CONTRACT_PART_SIZE as PART, FakeServer, drive, file, flush, installStorage, useFakeClock, type Content } from './helpers'
import { failDigest, holdDigest, normalDigest } from './setup'

const CODE = 'LUM-482193'
const VIDEO: Content = { seed: 21 }
const OTHER_VIDEO: Content = { seed: 22 }
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
const createsAfter = (mark: number) =>
  server.log.slice(mark).filter((r) => r.method === 'POST' && r.path.endsWith('/attachments'))
const line = (name: string) => loadSession()?.files.find((f) => f.name === name)
const marked = (name: string) => (line(name) as { removing?: unknown } | undefined)?.removing
const names = (h: Hook) => h.result.current.files.map((f) => f.name)
const clip = (content: Content) => file('clip.mp4', 4 * PART, 'video/mp4', 1000, content)

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i++) {
      await flush()
      await new Promise<void>((r) => setImmediate(r))
    }
  })
}
async function startAll(h: Hook, t?: { code: string; reportToken: string }): Promise<boolean> {
  let ok = false
  await act(async () => {
    ok = await drive(h.result.current.start(t))
  })
  return ok
}
// A first visit that sent part 1 of clip.mp4 (4 parts) and was left; `noHash`: its digest failed (head null).
async function savedHalfWay(content: Content, noHash: boolean) {
  const token = server.addReport(CODE)
  server.holdPart = (_id, n) => (n > 1 ? never() : null)
  if (noHash) failDigest()
  const h = mount()
  act(() => h.result.current.addFiles([clip(content)]))
  await settle()
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
  expect(line('clip.mp4')).toMatchObject({ attachmentId: att.id, head: noHash ? null : expect.any(String) })
  return { token, att }
}

describe('red team A: a file that could not be hashed is never the saved one', () => {
  it('A: hashing fails on both visits; another video with the same name and size is a new upload, nothing goes to the old attachment', async () => {
    const { token, att } = await savedHalfWay(VIDEO, true)
    const mark = server.log.length
    const h2 = mount()
    act(() => h2.result.current.addFiles([clip(OTHER_VIDEO)]))
    await settle()
    expect(names(h2)).toEqual(['clip.mp4'])
    await startAll(h2, { code: CODE, reportToken: token })
    expect(putsAfter(mark).filter((r) => r.id === att.id)).toEqual([])
    expect(createsAfter(mark)).toHaveLength(1)
    expect([...att.parts.keys()]).toEqual([1])
    expect(att.status).toBe('uploading')
    const fresh = server.attsOf(CODE).filter((a) => a.id !== att.id)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toMatchObject({ filename: 'clip.mp4', status: 'complete' })
  })

  it('A: hashing fails on both visits; even the same bytes are a new upload, since nothing tells them apart', async () => {
    const { token, att } = await savedHalfWay(VIDEO, true)
    const mark = server.log.length
    const h2 = mount()
    act(() => h2.result.current.addFiles([clip(VIDEO)]))
    await settle()
    await startAll(h2, { code: CODE, reportToken: token })
    expect(putsAfter(mark).filter((r) => r.id === att.id)).toEqual([])
    expect(createsAfter(mark)).toHaveLength(1)
  })

  it('A edge: a saved line with head null never matches a re-pick that hashes fine', async () => {
    const { token, att } = await savedHalfWay(VIDEO, true)
    normalDigest()
    const mark = server.log.length
    const h2 = mount()
    act(() => h2.result.current.addFiles([clip(VIDEO)]))
    await settle()
    await startAll(h2, { code: CODE, reportToken: token })
    expect(putsAfter(mark).filter((r) => r.id === att.id)).toEqual([])
    expect(createsAfter(mark)).toHaveLength(1)
  })

  it('A: a pick whose hash fails in this visit is still listed and goes up to done', async () => {
    const token = server.addReport(CODE)
    failDigest()
    const h = mount()
    act(() => h.result.current.addFiles([clip(VIDEO)]))
    await settle()
    expect(names(h)).toEqual(['clip.mp4'])
    expect(await startAll(h, { code: CODE, reportToken: token })).toBe(true)
    expect(h.result.current.phase).toBe('done')
    expect(server.attsOf(CODE).map((a) => a.status)).toEqual(['complete'])
    expect(loadSession()).toBeNull()
  })
})

describe('red team B: Remove pressed while the re-picked last file is still being hashed', () => {
  // After a reload clip.mp4 is picked again (the last missing file: its onBack starts the upload, as FilePicker does)
  // and Remove is pressed before its hash answers.
  async function removedWhileHashing() {
    const { att } = await savedHalfWay(VIDEO, false)
    const h2 = mount()
    const release = holdDigest()
    act(() => h2.result.current.addFiles([clip(VIDEO)], () => void h2.result.current.start()))
    await settle()
    expect(names(h2)).toEqual(['clip.mp4'])
    const mark = server.log.length
    const key = h2.result.current.files[0]!.key
    let p!: Promise<void>
    act(() => {
      p = h2.result.current.removeFile(key)
    })
    await settle()
    release()
    await act(async () => {
      await drive(p)
    })
    // Whatever the hash answer set going (an upload, a DELETE) is let run to its end.
    await act(async () => {
      await drive(new Promise<void>((r) => setTimeout(r, 60_000)))
    })
    await settle()
    return { att, h2, mark }
  }

  it('B: the file leaves the list, none of it is uploaded, and its saved attachment gets its DELETE', async () => {
    const { att, h2, mark } = await removedWhileHashing()
    expect(names(h2)).toEqual([])
    expect(putsAfter(mark)).toEqual([])
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0]!.path).toContain(`/attachments/${att.id}`)
    expect(att.status).toBe('aborted')
    expect(line('clip.mp4')).toBeUndefined()
    expect(h2.result.current.phase).not.toBe('done')
    expect(h2.result.current.resume).toBeNull()
  })

  it('B: when that DELETE fails, row 3 holds: the file stays with the orange remove line, its line marked, none of it uploaded', async () => {
    server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
    const { att, h2, mark } = await removedWhileHashing()
    expect(deletes()).toHaveLength(1)
    expect(putsAfter(mark)).toEqual([])
    expect(att.status).toBe('uploading')
    expect(h2.result.current.unremoved).toBe(true)
    expect(marked('clip.mp4')).toBe(true)
    expect(names(h2)).toEqual(['clip.mp4'])
    expect(h2.result.current.phase).not.toBe('done')
  })
})
