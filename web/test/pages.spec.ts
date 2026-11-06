// Rows 3 and 8 through the real pages (jsdom), against the fake worker. Turnstile is the one third-party script:
// here window.turnstile is a stand-in that issues a token at once, as Cloudflare's always-pass test key does.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, strings } from '../src/i18n'
import AddVideo from '../src/pages/AddVideo'
import Report from '../src/pages/Report'
import { loadSession } from '../src/upload/session'
import { CONTRACT_PART_SIZE as PART, FakeServer, deferred, file, installStorage } from './helpers'

const CODE = 'LUM-482193'
const t = strings.en
let server: FakeServer

beforeEach(() => {
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
    reset: () => {},
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
