// useUpload against the fake worker and an in-memory sessionStorage: rows 3, 4, 5 and 8 at the module level, and the
// resume state rules of the brief (written before an attachment exists, cleared only when every file is done, a code
// in the address never bound to another report's session, the upload works without storage).
// A reload is an unmount followed by a new mount: nothing survives it but sessionStorage and the server.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadSession } from '../src/upload/session'
import { useUpload, type Target } from '../src/upload/useUpload'
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
} from './helpers'

const CODE = 'LUM-482193'
const OTHER = 'LUM-111111'
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
async function startAll(h: Hook, t?: Target): Promise<boolean> {
  let ok = false
  await act(async () => {
    ok = await drive(h.result.current.start(t))
  })
  return ok
}
// Starts, lets the requests run until they block on the fake server, then reloads (unmount).
async function startThenReload(h: Hook, t: Target): Promise<void> {
  let p!: Promise<boolean>
  act(() => {
    p = h.result.current.start(t)
  })
  await act(() => flush())
  h.unmount()
  await act(async () => {
    await drive(p)
  })
}
const never = () => new Promise<void>(() => {})
const putsAfter = (mark: number) => server.log.slice(mark).filter((r) => r.method === 'PUT')

describe('row 3: a 300 MB video, sent, ends in "We have it"', () => {
  it('row 3: the bar moves between 0 and 1 while parts are confirmed, then done at 1 and the session is cleared', async () => {
    const token = server.addReport(CODE)
    const gate = deferred()
    server.holdPart = (_id, n) => (n > 6 ? gate.promise : null)
    const h = mount()
    act(() => h.result.current.addFiles([file('boss-bridge.mp4', 300_000_000)]))
    let p!: Promise<boolean>
    act(() => {
      p = h.result.current.start({ code: CODE, reportToken: token })
    })
    await act(() => flush())
    expect(h.result.current.phase).toBe('uploading')
    expect(h.result.current.progress).toBeGreaterThan(0)
    expect(h.result.current.progress).toBeLessThan(1)
    server.holdPart = () => null
    gate.resolve()
    let ok = false
    await act(async () => {
      ok = await drive(p)
    })
    expect(ok).toBe(true)
    expect(h.result.current.phase).toBe('done')
    expect(h.result.current.progress).toBe(1)
    expect(server.attsOf(CODE).map((a) => a.status)).toEqual(['complete'])
    expect(loadSession()).toBeNull()
  })

  it('row 3: before any file is sent the bar is at 0 and the phase idle (not yet, not failed)', () => {
    const h = mount()
    expect(h.result.current.phase).toBe('idle')
    expect(h.result.current.progress).toBe(0)
    expect(h.result.current.resume).toBeNull()
  })

  it('contract rule: two files go up with never more than 3 parts in flight in all', async () => {
    const token = server.addReport(CODE)
    const h = mount()
    act(() => h.result.current.addFiles([file('a.mp4', 5 * PART), file('b.mp4', 5 * PART)]))
    expect(await startAll(h, { code: CODE, reportToken: token })).toBe(true)
    expect(server.maxPutsInFlight).toBe(3)
    expect(server.attsOf(CODE).map((a) => a.status)).toEqual(['complete', 'complete'])
  })

  it('not yet: start with no report and nothing saved sends nothing', async () => {
    const h = mount()
    act(() => h.result.current.addFiles([file('a.mp4', MiB)]))
    expect(await startAll(h)).toBe(false)
    expect(server.log).toHaveLength(0)
  })
})

describe('row 4: the Wi-Fi drops at about 41 %, comes back, Try again', () => {
  it('row 4: the error shows with the bar kept, and Try again sends only the unconfirmed parts', async () => {
    const token = server.addReport(CODE)
    const size = 21 * PART + 5 * MiB
    let outage = true
    server.partFault = (_id, n) => (outage && n >= 10 ? 'network' : 'ok')
    const h = mount()
    act(() => h.result.current.addFiles([file('boss-bridge.mp4', size)]))
    expect(await startAll(h, { code: CODE, reportToken: token })).toBe(false)
    expect(h.result.current.phase).toBe('error')
    expect(h.result.current.files[0]?.state).toBe('error')
    const [att] = server.attsOf(CODE)
    const kept = server.confirmedBytes(att!.id)
    expect(kept).toBe(9 * PART)
    expect(h.result.current.progress).toBeCloseTo(kept / size, 6)
    // A network failure keeps the session: a reload now still resumes this report.
    expect(loadSession()?.code).toBe(CODE)

    outage = false
    const mark = server.log.length
    let ok = false
    await act(async () => {
      ok = await drive(h.result.current.retry())
    })
    expect(ok).toBe(true)
    expect(h.result.current.phase).toBe('done')
    expect(h.result.current.progress).toBe(1)
    const resent = putsAfter(mark).map((r) => r.n as number)
    expect(resent.filter((n) => n <= 9)).toEqual([])
    expect(new Set(resent)).toEqual(new Set([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]))
    expect(server.requests('POST', '/attachments').filter((r) => r.path.endsWith('/attachments'))).toHaveLength(1)
    expect(att!.status).toBe('complete')
  })
})

describe('row 5: reload half way, pick the same file again, it carries on', () => {
  it('row 5: after a reload mid-upload the same file continues on the same attachment from the unconfirmed parts', async () => {
    const token = server.addReport(CODE)
    server.holdPart = (_id, n) => (n > 4 ? never() : null)
    const h1 = mount()
    act(() => h1.result.current.addFiles([file('boss-bridge.mp4', 10 * PART)]))
    await startThenReload(h1, { code: CODE, reportToken: token })
    const [att] = server.attsOf(CODE)
    expect([...att!.parts.keys()].sort()).toEqual([1, 2, 3, 4])

    server.holdPart = () => null
    const mark = server.log.length
    const h2 = mount()
    expect(h2.result.current.resume).toMatchObject({ code: CODE, missing: [{ name: 'boss-bridge.mp4', size: 10 * PART }] })
    act(() => h2.result.current.addFiles([file('boss-bridge.mp4', 10 * PART)]))
    expect(await startAll(h2)).toBe(true)
    expect(h2.result.current.phase).toBe('done')
    const after = server.log.slice(mark)
    // Same report, same token, same attachment: nothing new created.
    expect(after.filter((r) => r.method === 'POST' && r.path.endsWith('/attachments'))).toHaveLength(0)
    for (const r of after) expect(r.token).toBe(token)
    expect(after.some((r) => r.method === 'GET' && r.path.endsWith(`/attachments/${att!.id}/parts`))).toBe(true)
    expect(new Set(putsAfter(mark).map((r) => r.n))).toEqual(new Set([5, 6, 7, 8, 9, 10]))
    expect(putsAfter(mark).every((r) => r.id === att!.id)).toBe(true)
    expect(att!.status).toBe('complete')
    expect(loadSession()).toBeNull()
  })

  it('resume state: the session is written before the attachment exists, so a reload during create still resumes', async () => {
    const token = server.addReport(CODE)
    server.holdCreate = never()
    const h1 = mount()
    act(() => h1.result.current.addFiles([file('boss-bridge.mp4', 3 * PART)]))
    await startThenReload(h1, { code: CODE, reportToken: token })
    expect(server.attsOf(CODE)).toHaveLength(0)

    server.holdCreate = null
    const h2 = mount()
    expect(h2.result.current.resume).toMatchObject({ code: CODE, missing: [{ name: 'boss-bridge.mp4', size: 3 * PART }] })
    act(() => h2.result.current.addFiles([file('boss-bridge.mp4', 3 * PART)]))
    expect(await startAll(h2)).toBe(true)
    const atts = server.attsOf(CODE)
    expect(atts).toHaveLength(1)
    expect(atts[0]).toMatchObject({ size: 3 * PART, status: 'complete' })
    expect(loadSession()).toBeNull()
  })

  it('resume state: a file with the same name but another lastModified is not sent into the saved attachment', async () => {
    const token = server.addReport(CODE)
    server.holdPart = (_id, n) => (n > 2 ? never() : null)
    const h1 = mount()
    act(() => h1.result.current.addFiles([file('clip.mp4', 6 * PART, 'video/mp4', 1000)]))
    await startThenReload(h1, { code: CODE, reportToken: token })
    const [saved] = server.attsOf(CODE)

    server.holdPart = () => null
    const mark = server.log.length
    const h2 = mount()
    act(() => h2.result.current.addFiles([file('clip.mp4', 6 * PART, 'video/mp4', 2000)]))
    await startAll(h2)
    expect(putsAfter(mark).filter((r) => r.id === saved!.id)).toEqual([])
    expect([...saved!.parts.keys()].sort()).toEqual([1, 2])
  })

  it('resume state: re-picking one of two saved files finishes it but keeps the session for the other', async () => {
    const token = server.addReport(CODE)
    server.holdPart = () => never()
    const h1 = mount()
    act(() => h1.result.current.addFiles([file('a.mp4', 2 * PART), file('b.mp4', 2 * PART)]))
    await startThenReload(h1, { code: CODE, reportToken: token })

    server.holdPart = () => null
    const h2 = mount()
    act(() => h2.result.current.addFiles([file('a.mp4', 2 * PART)]))
    expect(await startAll(h2)).toBe(false)
    expect(h2.result.current.phase).not.toBe('done')
    expect(loadSession()?.code).toBe(CODE)
    expect(h2.result.current.resume?.missing.map((m) => m.name)).toEqual(['b.mp4'])

    act(() => h2.result.current.addFiles([file('b.mp4', 2 * PART)]))
    expect(await startAll(h2)).toBe(true)
    expect(h2.result.current.phase).toBe('done')
    expect(loadSession()).toBeNull()
    expect(server.attsOf(CODE).map((a) => a.status)).toEqual(['complete', 'complete'])
  })

  it('resume state: a second file failing leaves the session, and a reload offers it again', async () => {
    const token = server.addReport(CODE)
    server.partFault = (id) => (id === 'att-2' ? 'network' : 'ok')
    const h1 = mount()
    act(() => h1.result.current.addFiles([file('a.mp4', PART), file('b.mp4', PART)]))
    expect(await startAll(h1, { code: CODE, reportToken: token })).toBe(false)
    expect(h1.result.current.phase).toBe('error')
    expect(server.atts.get('att-1')?.status).toBe('complete')
    expect(loadSession()?.code).toBe(CODE)
    h1.unmount()
    const h2 = mount()
    expect(h2.result.current.resume).toMatchObject({ code: CODE, missing: [{ name: 'b.mp4' }] })
  })
})

describe('row 8: a code in the address (/add?code=) is never bound to another report\'s session', () => {
  async function interruptedUploadTo(code: string) {
    const token = server.addReport(code)
    server.holdPart = (_id, n) => (n > 1 ? never() : null)
    const h = mount()
    act(() => h.result.current.addFiles([file('boss-bridge.mp4', 4 * PART)]))
    await startThenReload(h, { code, reportToken: token })
    server.holdPart = () => null
    return { token, att: server.attsOf(code)[0]! }
  }

  it('row 8: a saved upload of another report is not offered on /add?code=LUM-482193', async () => {
    await interruptedUploadTo(OTHER)
    const h = mount(CODE)
    expect(h.result.current.resume).toBeNull()
  })

  it('row 8: the same file picked for LUM-482193 goes to a new attachment of LUM-482193, never the other report', async () => {
    const old = await interruptedUploadTo(OTHER)
    const tokenB = server.addReport(CODE)
    const mark = server.log.length
    const h = mount(CODE)
    act(() => h.result.current.addFiles([file('boss-bridge.mp4', 4 * PART)]))
    expect(await startAll(h, { code: CODE, reportToken: tokenB })).toBe(true)
    const after = server.log.slice(mark)
    expect(after.filter((r) => r.path.includes(OTHER) || r.path.includes(`/${old.att.id}`))).toEqual([])
    expect(after.filter((r) => r.token === old.token)).toEqual([])
    const mine = server.attsOf(CODE)
    expect(mine).toHaveLength(1)
    expect(mine[0]).toMatchObject({ size: 4 * PART, status: 'complete' })
    expect(old.att.parts.size).toBe(1)
  })

  it('row 8: with another report saved, start without a target on LUM-482193 sends nothing to the other report', async () => {
    const old = await interruptedUploadTo(OTHER)
    const mark = server.log.length
    const h = mount(CODE)
    act(() => h.result.current.addFiles([file('boss-bridge.mp4', 4 * PART)]))
    await startAll(h)
    const after = server.log.slice(mark)
    expect(after.filter((r) => r.path.includes(OTHER) || r.path.includes(`/${old.att.id}`) || r.token === old.token)).toEqual([])
  })

  it('resume state: a saved upload of another report, re-picked and sent to a new report, reuses none of its attachments', async () => {
    const old = await interruptedUploadTo(OTHER)
    const tokenB = server.addReport(CODE)
    const mark = server.log.length
    const h = mount()
    act(() => h.result.current.addFiles([file('boss-bridge.mp4', 4 * PART)]))
    expect(await startAll(h, { code: CODE, reportToken: tokenB })).toBe(true)
    const after = server.log.slice(mark)
    expect(after.filter((r) => r.path.includes(`/${old.att.id}`) || r.token === old.token)).toEqual([])
    expect(server.attsOf(CODE)).toHaveLength(1)
    expect(server.attsOf(CODE)[0]).toMatchObject({ size: 4 * PART, status: 'complete' })
  })

  it('row 8: the saved upload is still offered for its own code, and when no code is given', async () => {
    await interruptedUploadTo(OTHER)
    expect(mount(OTHER).result.current.resume?.code).toBe(OTHER)
    expect(mount().result.current.resume?.code).toBe(OTHER)
  })
})

describe('resume state: storage blocked or unreadable', () => {
  it('storage: with sessionStorage throwing on every call the upload still completes', async () => {
    installStorage('broken')
    const token = server.addReport(CODE)
    const h = mount()
    act(() => h.result.current.addFiles([file('clip.mp4', 2 * PART)]))
    expect(await startAll(h, { code: CODE, reportToken: token })).toBe(true)
    expect(h.result.current.phase).toBe('done')
    expect(loadSession()).toBeNull()
  })

  it('storage: a saved value that is not JSON is a fresh visit, not a crash', async () => {
    installStorage('garbage')
    expect(loadSession()).toBeNull()
    const h = mount()
    expect(h.result.current.resume).toBeNull()
    const token = server.addReport(CODE)
    act(() => h.result.current.addFiles([file('clip.mp4', PART)]))
    expect(await startAll(h, { code: CODE, reportToken: token })).toBe(true)
  })
})
