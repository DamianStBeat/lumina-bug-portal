// The five rules of the last critical round that had no spec (bp-web audit-2, findings 2-6), on useUpload against
// the fake worker and on the Turnstile widget in jsdom. Each case is green on ce757b7 and turns red when the rule's
// line is reverted. A reload is an unmount followed by a new mount: nothing survives it but sessionStorage and the
// server.
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { Turnstile } from '../src/components/Turnstile'
import { I18nProvider, strings } from '../src/i18n'
import { loadSession } from '../src/upload/session'
import { useUpload } from '../src/upload/useUpload'
import {
  CONTRACT_PART_SIZE as PART,
  FakeServer,
  deferred,
  drive,
  file,
  flush,
  installStorage,
  useFakeClock,
  type Fault,
} from './helpers'

const CODE = 'LUM-482193'
const OTHER = 'LUM-111111'
let server: FakeServer

type Hook = ReturnType<typeof mount>
function mount(only?: string) {
  return renderHook(() => useUpload(only))
}
const never = () => new Promise<void>(() => {})
const deletes = () => server.log.filter((r) => r.method === 'DELETE')
const putsAfter = (mark: number) => server.log.slice(mark).filter((r) => r.method === 'PUT')
const line = (name: string) => loadSession()?.files.find((f) => f.name === name)
// The flag is the decided shape of a removed saved line (B1); read without the type, which may not carry it.
const marked = (name: string) => (line(name) as { removing?: unknown } | undefined)?.removing
const names = (h: Hook) => h.result.current.files.map((f) => f.name)

// Lets every pending chain run without moving the clock (the hashing of a pick included, which answers from Node's
// thread pool, so the loop also yields to the real event loop).
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
async function removeFirst(h: Hook): Promise<void> {
  const key = h.result.current.files[0]!.key
  await act(async () => {
    await drive(h.result.current.removeFile(key))
  })
  await settle()
}

// A first visit that sent part 1 of a.mp4 and was left: its attachment exists on the server and in the session.
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
  expect(line('a.mp4')).toMatchObject({ attachmentId: att.id, done: false })
  return { token, att }
}

// Then a.mp4 is picked again and Removed in a visit whose first DELETE fails; the page is left with the line marked.
async function removeFailedThenLeft(fault: Fault = 'network') {
  const saved = await savedHalfWay()
  server.routeFault = (m, _p, k) => (m === 'DELETE' && k === 1 ? fault : null)
  const h1 = mount()
  await pick(h1, [file('a.mp4', 4 * PART)])
  await removeFirst(h1)
  expect(h1.result.current.unremoved).toBe(true)
  expect(marked('a.mp4')).toBe(true)
  h1.unmount()
  server.routeFault = () => null
  return saved
}

describe('audit-2 findings 2-5: the finisher and the marked line of a removed file', () => {
  beforeEach(() => {
    useFakeClock()
    installStorage()
    server = new FakeServer().install()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('finding 2: a background DELETE answered after its page was left never writes over the session of the upload made since', async () => {
    await removeFailedThenLeft()
    // `/` boots with the marked line; its DELETE is slow, and the player leaves for /add?code=LUM-111111.
    const gate = deferred()
    server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
    const h2 = mount()
    await settle()
    expect(deletes()).toHaveLength(2)
    h2.unmount()

    // There an upload starts and is still going, so its session is the one a reload must find.
    const tokenB = server.addReport(OTHER)
    server.holdPart = () => never()
    const h3 = mount(OTHER)
    await pick(h3, [file('b.mp4', 2 * PART)])
    let p!: Promise<boolean>
    act(() => {
      p = h3.result.current.start({ code: OTHER, reportToken: tokenB })
    })
    await settle()
    expect(loadSession()?.code).toBe(OTHER)

    gate.resolve()
    await settle()
    expect(loadSession()?.code).toBe(OTHER)
    expect(loadSession()?.files.map((f) => f.name)).toEqual(['b.mp4'])
    expect(mount(OTHER).result.current.resume).toMatchObject({ code: OTHER, missing: [{ name: 'b.mp4' }] })
    h3.unmount()
    await act(async () => {
      await drive(p)
    })
  })

  it('finding 3: a copy of the removed file picked while its DELETE is out is a new file with a new attachment, never the one being deleted', async () => {
    const { token, att } = await removeFailedThenLeft()
    const gate = deferred()
    server.holdRoute = (m) => (m === 'DELETE' ? gate.promise : null)
    const h2 = mount()
    await settle()
    expect(deletes()).toHaveLength(2)
    const mark = server.log.length
    await pick(h2, [file('a.mp4', 4 * PART)])
    expect(names(h2)).toEqual(['a.mp4'])

    // The DELETE lands, then the player presses Send.
    gate.resolve()
    server.holdRoute = () => null
    await settle()
    expect(att.status).toBe('aborted')
    let ok = false
    await act(async () => {
      ok = await drive(h2.result.current.start({ code: CODE, reportToken: token }))
    })
    expect(ok).toBe(true)
    expect(h2.result.current.phase).toBe('done')
    expect(h2.result.current.refused).toBeNull()
    expect(putsAfter(mark).filter((r) => r.id === att.id)).toEqual([])
    const fresh = server.attsOf(CODE).filter((a) => a.id !== att.id)
    expect(fresh).toHaveLength(1)
    expect(fresh[0]).toMatchObject({ filename: 'a.mp4', status: 'complete' })
    expect(loadSession()).toBeNull()
  })

  it('finding 3: removing that new copy (never sent) leaves the marked line of the old one, whose DELETE a later load sends', async () => {
    const { att } = await removeFailedThenLeft()
    // The next load cannot reach the server for its DELETE: the line stays marked.
    server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
    const h2 = mount()
    await settle()
    expect(deletes()).toHaveLength(2)
    expect(marked('a.mp4')).toBe(true)
    await pick(h2, [file('a.mp4', 4 * PART)])
    await removeFirst(h2)
    expect(names(h2)).toEqual([])
    expect(deletes()).toHaveLength(2)
    expect(marked('a.mp4')).toBe(true)
    h2.unmount()

    server.routeFault = () => null
    mount()
    await settle()
    expect(deletes()).toHaveLength(3)
    expect(att.status).toBe('aborted')
    expect(line('a.mp4')).toBeUndefined()
  })

  it('finding 4: a listed file whose Remove failed, sent with Try again instead, is no longer marked: done clears the session and no later load deletes it', async () => {
    const { att } = await savedHalfWay()
    server.routeFault = (m, _p, k) => (m === 'DELETE' && k === 1 ? 'network' : null)
    const h = mount()
    await pick(h, [file('a.mp4', 4 * PART)])
    await removeFirst(h)
    expect(h.result.current.unremoved).toBe(true)
    expect(marked('a.mp4')).toBe(true)

    // Wi-Fi back; the player presses Try again (the upload), not Remove.
    let ok = false
    await act(async () => {
      ok = await drive(h.result.current.retry())
    })
    expect(ok).toBe(true)
    expect(h.result.current.phase).toBe('done')
    expect(h.result.current.unremoved).toBe(false)
    expect(att.status).toBe('complete')
    expect(loadSession()).toBeNull()
    h.unmount()

    const h2 = mount()
    await settle()
    expect(deletes()).toHaveLength(1)
    expect(att.status).toBe('complete')
    expect(h2.result.current.resume).toBeNull()
  })

  it('finding 5: an upload that completes while a removed line is still marked keeps that line, and the next load sends its DELETE', async () => {
    const { token, att } = await removeFailedThenLeft()
    server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
    const h2 = mount()
    await settle()
    expect(deletes()).toHaveLength(2)
    await pick(h2, [file('b.mp4', 2 * PART)])
    let ok = false
    await act(async () => {
      ok = await drive(h2.result.current.start({ code: CODE, reportToken: token }))
    })
    expect(ok).toBe(true)
    expect(h2.result.current.phase).toBe('done')
    expect(marked('a.mp4')).toBe(true)
    expect(att.status).toBe('uploading')
    h2.unmount()

    server.routeFault = () => null
    const h3 = mount()
    await settle()
    expect(deletes()).toHaveLength(3)
    expect(att.status).toBe('aborted')
    expect(line('a.mp4')).toBeUndefined()
    expect(h3.result.current.resume).toBeNull()
  })
})

describe('audit-2 finding 6: a Turnstile widget whose script did not load', () => {
  const t = strings.en
  const SCRIPT = 'script[src*="challenges.cloudflare.com/turnstile"]'
  const script = () => document.head.querySelector(SCRIPT) as HTMLScriptElement | null
  let onToken: Mock<(token: string | null) => void>

  beforeEach(() => {
    localStorage.clear()
    delete window.turnstile
    document.head.querySelectorAll(SCRIPT).forEach((s) => s.remove())
    onToken = vi.fn<(token: string | null) => void>()
    render(createElement(I18nProvider, null, createElement(Turnstile, { onToken })))
  })
  afterEach(() => {
    // A script left unanswered would be the next case's pending load.
    const s = script()
    if (s) act(() => void s.dispatchEvent(new Event('error')))
    cleanup()
  })

  it('finding 6, not yet: while the script has not answered neither line shows', () => {
    expect(script()).not.toBeNull()
    expect(screen.queryByText(t.errCheckLoad)).toBeNull()
    expect(screen.queryByText(t.errCheck)).toBeNull()
    expect(screen.queryByRole('button', { name: t.retry })).toBeNull()
  })

  it('finding 6: a blocked script shows errCheckLoad with Try again, never errCheck', async () => {
    act(() => void script()!.dispatchEvent(new Event('error')))
    expect(await screen.findByText(t.errCheckLoad)).toBeTruthy()
    expect(screen.queryByText(t.errCheck)).toBeNull()
    expect(screen.getByRole('button', { name: t.retry })).toBeTruthy()
    expect(onToken).toHaveBeenLastCalledWith(null)
  })

  it('finding 6: a script that loads without the widget API shows errCheckLoad too, and Try again adds the script again', async () => {
    act(() => void script()!.dispatchEvent(new Event('load')))
    expect(await screen.findByText(t.errCheckLoad)).toBeTruthy()
    expect(screen.queryByText(t.errCheck)).toBeNull()
    expect(script()).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: t.retry }))
    expect(script()).not.toBeNull()
    expect(screen.queryByText(t.errCheckLoad)).toBeNull()
  })
})
