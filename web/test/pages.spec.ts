// Rows 3 and 8 through the real pages (jsdom), against the fake worker. Turnstile is the one third-party script:
// here window.turnstile is a stand-in that issues a token at once, as Cloudflare's always-pass test key does.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { I18nProvider, strings } from '../src/i18n'
import AddVideo from '../src/pages/AddVideo'
import Report from '../src/pages/Report'
import { loadSession } from '../src/upload/session'
import { CONTRACT_PART_SIZE as PART, FakeServer, deferred, file, installStorage, type Fault } from './helpers'

const CODE = 'LUM-482193'
const t = strings.en
let server: FakeServer
// The widget's reset, called when a used token must be replaced by a fresh one.
let widgetReset: Mock<(widgetId: string) => void>

beforeEach(() => {
  widgetReset = vi.fn<(widgetId: string) => void>()
  installStorage()
  localStorage.clear()
  server = new FakeServer().install()
  // jsdom has no scrolling; the pages scroll to the top on every step.
  vi.stubGlobal('scrollTo', () => {})
  window.turnstile = {
    render: (_el, o) => {
      o.callback('turnstile-pass')
      return 'w1'
    },
    reset: widgetReset,
    remove: () => {},
  }
})
afterEach(() => {
  cleanup()
  delete window.turnstile
})

const page = (c: () => ReturnType<typeof AddVideo>) => render(createElement(I18nProvider, null, createElement(c)))
const fileInput = () => document.querySelector('input[type=file]') as HTMLInputElement
const pick = (...files: File[]) => fireEvent.change(fileInput(), { target: { files } })
// The send buttons wait for the Turnstile token, which arrives a tick after the widget renders.
async function press(name: string): Promise<void> {
  const b = await screen.findByRole('button', { name })
  await waitFor(() => expect(b).toHaveProperty('disabled', false))
  fireEvent.click(b)
}

describe('row 8: /add?code=LUM-482193 has the code written in, and the video goes to that report', () => {
  it('row 8: the code field is filled from the address', () => {
    history.replaceState(null, '', `/add?code=${CODE}`)
    page(AddVideo)
    expect(screen.getByLabelText(t.addCodeL)).toHaveProperty('value', CODE)
  })

  it('row 8: picking a video and pressing Add to report uploads it to LUM-482193 and shows the code', async () => {
    server.addReport(CODE)
    history.replaceState(null, '', `/add?code=${CODE}`)
    page(AddVideo)
    pick(file('discord-clip.mp4', 2 * PART + 7))
    await press(t.addSend)
    await screen.findByText(t.h4)
    expect(screen.getByText(CODE)).toBeTruthy()
    expect(server.requests('POST', `/reports/${CODE}/attach-session`)).toHaveLength(1)
    expect(server.attsOf(CODE)).toHaveLength(1)
    expect(server.attsOf(CODE)[0]).toMatchObject({ filename: 'discord-clip.mp4', status: 'complete' })
  })

  it('row 8: a saved upload of another report does not replace the code in the address', async () => {
    // A first visit to /add?code=LUM-111111 whose upload is cut by leaving the page.
    const other = 'LUM-111111'
    server.addReport(other)
    server.holdPart = () => new Promise<void>(() => {})
    history.replaceState(null, '', `/add?code=${other}`)
    const first = page(AddVideo)
    pick(file('old.mp4', 2 * PART))
    await press(t.addSend)
    await new Promise((r) => setTimeout(r, 50))
    expect(server.attsOf(other)).toHaveLength(1)
    first.unmount()

    history.replaceState(null, '', `/add?code=${CODE}`)
    server.addReport(CODE)
    server.holdPart = () => null
    const mark = server.log.length
    page(AddVideo)
    expect(screen.getByLabelText(t.addCodeL)).toHaveProperty('value', CODE)
    // And the video picked now goes to LUM-482193, never into the other report's saved upload.
    pick(file('old.mp4', 2 * PART))
    await press(t.addSend)
    await screen.findByText(t.h4)
    expect(screen.getByText(CODE)).toBeTruthy()
    expect(server.log.slice(mark).filter((r) => r.path.includes(other) || r.path.includes('/att-1/'))).toEqual([])
    expect(server.attsOf(CODE)).toHaveLength(1)
    expect(server.attsOf(CODE)[0]).toMatchObject({ status: 'complete' })
  })
})

describe('row 3: a 300 MB video, sent, ends in "We have it" with the code', () => {
  it('row 3: the three steps, a 300 MB video, Send: "We have it" with the code the server gave', async () => {
    history.replaceState(null, '', '/')
    page(Report)
    fireEvent.change(screen.getByLabelText(t.q1), { target: { value: 'The boss stopped on the bridge.' } })
    fireEvent.click(screen.getByRole('button', { name: t.next }))
    fireEvent.click(await screen.findByRole('button', { name: t.where.match }))
    fireEvent.click(screen.getByRole('button', { name: t.dev.phone }))
    fireEvent.click(screen.getByRole('button', { name: t.next }))
    await screen.findByText(t.h3)
    pick(file('boss-bridge.mp4', 300_000_000))
    await press(t.send)
    await screen.findByText(t.h4, undefined, { timeout: 5000 })
    const [code] = [...server.reports.keys()]
    expect(code).toMatch(/^LUM-\d{6}$/)
    expect(screen.getByText(code!)).toBeTruthy()
    const atts = server.attsOf(code!)
    expect(atts).toHaveLength(1)
    expect(atts[0]).toMatchObject({ size: 300_000_000, status: 'complete' })
    expect(atts[0]!.parts.size).toBe(18)
  })
})

describe('resume state: a page left while its request is pending writes nothing afterwards', () => {
  const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))

  it('resume state: a late createReport answer after leaving / starts no upload and keeps the session of the upload made since', async () => {
    const gate = deferred()
    server.holdRoute = (method, path) => (method === 'POST' && path === '/reports' ? gate.promise : null)
    history.replaceState(null, '', '/')
    const report = page(Report)
    fireEvent.change(screen.getByLabelText(t.q1), { target: { value: 'The boss stopped on the bridge.' } })
    fireEvent.click(screen.getByRole('button', { name: t.next }))
    fireEvent.click(await screen.findByRole('button', { name: t.next }))
    await screen.findByText(t.h3)
    pick(file('first.mp4', 2 * PART))
    await press(t.send)
    await tick()
    report.unmount()

    // Meanwhile the player adds a video to a Discord report; its upload is cut, so its session must survive.
    server.addReport(CODE)
    server.holdRoute = () => null
    server.holdPart = () => new Promise<void>(() => {})
    history.replaceState(null, '', `/add?code=${CODE}`)
    page(AddVideo)
    pick(file('second.mp4', 2 * PART))
    await press(t.addSend)
    await tick()
    expect(loadSession()?.code).toBe(CODE)

    gate.resolve()
    await tick(100)
    const late = [...server.reports.keys()].find((c) => c !== CODE)
    expect(late).toBeDefined()
    expect(server.requests('POST', `/reports/${late}/attachments`)).toHaveLength(0)
    expect(loadSession()?.code).toBe(CODE)
  })

  it('resume state: a late attach-session answer after leaving /add starts no upload', async () => {
    server.addReport(CODE)
    const gate = deferred()
    server.holdRoute = (_m, path) => (path.endsWith('/attach-session') ? gate.promise : null)
    history.replaceState(null, '', `/add?code=${CODE}`)
    const add = page(AddVideo)
    pick(file('clip.mp4', 2 * PART))
    await press(t.addSend)
    await tick()
    add.unmount()
    gate.resolve()
    await tick(100)
    expect(server.requests('POST', `/reports/${CODE}/attachments`)).toHaveLength(0)
    expect(server.puts()).toHaveLength(0)
    expect(loadSession()).toBeNull()
  })
})

describe('decided B1: a Remove the server does not answer, on the page', () => {
  it('B1: a failed DELETE keeps the file listed with the errRemove line; Remove again removes it and the line goes', async () => {
    server.addReport(CODE)
    // The first PUT is refused for good, so the file has an attachment and a Remove button.
    server.partFault = () => ({ status: 400, error: 'invalid_part' })
    server.routeFault = (m, _p, k) => (m === 'DELETE' && k === 1 ? { status: 503 } : null)
    history.replaceState(null, '', `/add?code=${CODE}`)
    page(AddVideo)
    pick(file('clip.mp4', 2 * PART))
    await press(t.addSend)
    await screen.findByText(t.errRefused)
    fireEvent.click(screen.getByRole('button', { name: `${t.remove} clip.mp4` }))
    await screen.findByText(t.errRemove)
    expect(screen.getByRole('progressbar', { name: 'clip.mp4' })).toBeTruthy()
    expect(server.attsOf(CODE)[0]?.status).toBe('uploading')

    fireEvent.click(await screen.findByRole('button', { name: `${t.remove} clip.mp4` }))
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'clip.mp4' })).toBeNull())
    expect(screen.queryByText(t.errRemove)).toBeNull()
    expect(server.requests('DELETE', '/attachments/')).toHaveLength(2)
    expect(server.attsOf(CODE)[0]?.status).toBe('aborted')
  })
})

describe('decided B2: /add and the address', () => {
  const OTHER = 'LUM-111111'
  const field = () => screen.getByLabelText(t.addCodeL)
  const here = () => location.pathname + location.search
  // Browser Back or Forward: the address changes under the page, then popstate.
  const travel = (to: string) =>
    act(() => {
      history.replaceState(null, '', to)
      window.dispatchEvent(new PopStateEvent('popstate'))
    })

  it('B2: not bound yet, the code field follows the address on Back and Forward', () => {
    history.replaceState(null, '', `/add?code=${CODE}`)
    page(AddVideo)
    expect(field()).toHaveProperty('value', CODE)
    travel(`/add?code=${OTHER}`)
    expect(field()).toHaveProperty('value', OTHER)
    travel('/add')
    expect(field()).toHaveProperty('value', '')
    travel(`/add?code=${CODE}`)
    expect(field()).toHaveProperty('value', CODE)
  })

  it('B2: bound to LUM-482193 while uploading, Back to another code puts the address back and the upload stays on LUM-482193', async () => {
    server.addReport(CODE)
    server.addReport(OTHER)
    const gate = deferred()
    server.holdPart = () => gate.promise
    history.replaceState(null, '', `/add?code=${CODE}`)
    page(AddVideo)
    pick(file('clip.mp4', 2 * PART))
    await press(t.addSend)
    await waitFor(() => expect(server.puts().length).toBeGreaterThan(0))
    const entries = history.length

    travel(`/add?code=${OTHER}`)
    await waitFor(() => expect(here()).toBe(`/add?code=${CODE}`))
    // Put back in place, not pushed: Back still leads where it led before.
    expect(history.length).toBe(entries)
    expect(field()).toHaveProperty('value', CODE)

    server.holdPart = () => null
    gate.resolve()
    await screen.findByText(t.h4)
    expect(screen.getByText(CODE)).toBeTruthy()
    expect(server.attsOf(CODE)).toHaveLength(1)
    expect(server.attsOf(CODE)[0]).toMatchObject({ filename: 'clip.mp4', status: 'complete' })
    expect(server.attsOf(OTHER)).toEqual([])
    expect(server.log.filter((r) => r.path.includes(OTHER))).toEqual([])
  })

  it('B2: bound and idle (a refused file), Back to /add or to another code puts /add?code=LUM-482193 back, and the next file goes there', async () => {
    server.addReport(CODE)
    server.addReport(OTHER)
    server.partFault = (id) => (id === 'att-1' ? { status: 400, error: 'invalid_part' } : 'ok')
    history.replaceState(null, '', `/add?code=${CODE}`)
    page(AddVideo)
    pick(file('wrong.mp4', 2 * PART))
    await press(t.addSend)
    await screen.findByText(t.errRefused)
    const entries = history.length

    travel('/add')
    await waitFor(() => expect(here()).toBe(`/add?code=${CODE}`))
    expect(field()).toHaveProperty('value', CODE)
    travel(`/add?code=${OTHER}`)
    await waitFor(() => expect(here()).toBe(`/add?code=${CODE}`))
    expect(field()).toHaveProperty('value', CODE)
    expect(history.length).toBe(entries)

    fireEvent.click(screen.getByRole('button', { name: `${t.remove} wrong.mp4` }))
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'wrong.mp4' })).toBeNull())
    pick(file('right.mp4', 2 * PART))
    await press(t.addSend)
    await screen.findByText(t.h4)
    expect(screen.getByText(CODE)).toBeTruthy()
    expect(server.attsOf(CODE).map((a) => [a.filename, a.status])).toEqual([
      ['wrong.mp4', 'aborted'],
      ['right.mp4', 'complete'],
    ])
    expect(server.log.filter((r) => r.path.includes(OTHER))).toEqual([])
  })
})

describe('decided B4: refusals on Send and Add to report say what happened', () => {
  // The decided English lines (B4); errCode and errSend keep their texts.
  const RATE = 'You sent a lot of reports in a short time. Try again in an hour.'
  const CHECK = 'The safety check did not pass. Wait a moment, then send it again.'
  const lines = () => [RATE, CHECK, t.errSend, t.errCode].filter((l) => screen.queryByText(l) !== null)

  async function sendReport(): Promise<void> {
    history.replaceState(null, '', '/')
    page(Report)
    fireEvent.change(screen.getByLabelText(t.q1), { target: { value: 'The boss stopped on the bridge.' } })
    fireEvent.click(screen.getByRole('button', { name: t.next }))
    fireEvent.click(await screen.findByRole('button', { name: t.next }))
    await screen.findByText(t.h3)
    pick(file('clip.mp4', 2 * PART))
    await press(t.send)
  }
  async function addToReport(): Promise<void> {
    history.replaceState(null, '', `/add?code=${CODE}`)
    page(AddVideo)
    pick(file('clip.mp4', 2 * PART))
    await press(t.addSend)
  }
  const onCreate = (f: Fault) => (server.routeFault = (m, p) => (m === 'POST' && p === '/reports' ? f : null))
  const onAttach = (f: Fault) => (server.routeFault = (m, p) => (m === 'POST' && p.endsWith('/attach-session') ? f : null))

  it('B4 send: 429 rate_limited shows the errRate line, not the Wi-Fi line, and no report is made', async () => {
    onCreate({ status: 429, error: 'rate_limited' })
    await sendReport()
    await screen.findByText(RATE)
    expect(lines()).toEqual([RATE])
    expect(server.reports.size).toBe(0)
    expect(server.atts.size).toBe(0)
  })

  it('B4 send: 403 turnstile_failed shows the errCheck line and resets the widget', async () => {
    onCreate({ status: 403, error: 'turnstile_failed' })
    await sendReport()
    await screen.findByText(CHECK)
    expect(lines()).toEqual([CHECK])
    expect(widgetReset).toHaveBeenCalledWith('w1')
  })

  const others: [string, Fault][] = [
    ['no network', 'network'],
    ['a 503', { status: 503 }],
    ['a 500', { status: 500, error: 'internal' }],
    ['another refusal (400 invalid_what)', { status: 400, error: 'invalid_what' }],
  ]
  it.each(others)('B4 send: %s shows the errSend line only', async (_label, f) => {
    onCreate(f)
    await sendReport()
    await screen.findByText(t.errSend)
    expect(lines()).toEqual([t.errSend])
  })

  it('B4 send, not yet: while createReport is unanswered none of the four lines shows', async () => {
    const gate = deferred()
    server.holdRoute = (m, p) => (m === 'POST' && p === '/reports' ? gate.promise : null)
    await sendReport()
    await waitFor(() => expect(server.requests('POST', '/reports')).toHaveLength(1))
    expect(lines()).toEqual([])
    gate.resolve()
  })

  it('B4 add: 429 rate_limited on attach-session shows the errRate line, not the Wi-Fi line', async () => {
    server.addReport(CODE)
    onAttach({ status: 429, error: 'rate_limited' })
    await addToReport()
    await screen.findByText(RATE)
    expect(lines()).toEqual([RATE])
    expect(server.attsOf(CODE)).toEqual([])
  })

  it('B4 add: 403 turnstile_failed on attach-session shows the errCheck line and resets the widget', async () => {
    server.addReport(CODE)
    onAttach({ status: 403, error: 'turnstile_failed' })
    await addToReport()
    await screen.findByText(CHECK)
    expect(lines()).toEqual([CHECK])
    expect(widgetReset).toHaveBeenCalledWith('w1')
  })

  it('B4 add: 404 not_found on attach-session shows the errCode line', async () => {
    // No report LUM-482193 on the server: the worker answers 404 not_found.
    await addToReport()
    await screen.findByText(t.errCode)
    expect(lines()).toEqual([t.errCode])
  })

  it.each(others)('B4 add: %s on attach-session shows the errSend line only', async (_label, f) => {
    server.addReport(CODE)
    onAttach(f)
    await addToReport()
    await screen.findByText(t.errSend)
    expect(lines()).toEqual([t.errSend])
  })
})
