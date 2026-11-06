// bp-web-upload audit.md round 1, findings 1-3: three queue rules that had no spec that could fail, now through the
// real pages (jsdom) against the fake worker, as the player reaches them. Turnstile is a stand-in that issues a token
// at once, as in pages.spec.ts. A reload is an unmount followed by a new mount: nothing survives it but
// sessionStorage and the server, so every saved state here comes from a first visit on the page.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, strings } from '../src/i18n'
import AddVideo from '../src/pages/AddVideo'
import Report from '../src/pages/Report'
import { loadSession } from '../src/upload/session'
import { CONTRACT_PART_SIZE as PART, FakeServer, MiB, deferred, file, installStorage, type Content } from './helpers'
import { holdDigest } from './setup'

const CODE = 'LUM-482193'
const OTHER = 'LUM-482194'
const VIDEO: Content = { seed: 31 }
const t = strings.en
let server: FakeServer

beforeEach(() => {
  installStorage()
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
async function press(name: string): Promise<void> {
  const b = await screen.findByRole('button', { name })
  await waitFor(() => expect(b).toHaveProperty('disabled', false))
  fireEvent.click(b)
}
const removeOf = (name: string) => screen.getByRole('button', { name: `${t.remove} ${name}` })
const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms))
const never = () => new Promise<void>(() => {})
const clip = () => file('clip.mp4', 4 * PART, 'video/mp4', 1000, VIDEO)
const small = (name: string) => file(name, 2 * MiB, 'video/mp4')
const deletes = () => server.log.filter((r) => r.method === 'DELETE')

// A first visit to /add?code=CODE that sent part 1 of clip.mp4 (4 parts) and was left: its attachment and its saved
// line exist, so the next visit is bound to CODE after the reload.
async function savedHalfWay() {
  server.addReport(CODE)
  server.holdPart = (_id, n) => (n > 1 ? never() : null)
  history.replaceState(null, '', `/add?code=${CODE}`)
  const first = page(AddVideo)
  pick(clip())
  await press(t.addSend)
  await waitFor(() => expect(server.attsOf(CODE)[0]?.parts.size).toBe(1))
  first.unmount()
  server.holdPart = () => null
  const att = server.attsOf(CODE)[0]!
  expect(loadSession()).toMatchObject({ code: CODE, files: [{ name: 'clip.mp4', attachmentId: att.id }] })
  return att
}

describe('audit 1 finding 1: Remove pressed after Add to report while that Send still waits', () => {
  it('finding 1: /add bound after a reload, Add to report pressed while the picks hash, then Remove on the saved video whose DELETE answers 503: the video is never uploaded nor completed, b.mp4 goes and the report is done', async () => {
    const att = await savedHalfWay()
    server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
    page(AddVideo)
    await screen.findByText(t.resumeHint, { exact: false })
    const mark = server.log.length

    const release = holdDigest()
    pick(small('b.mp4'), clip())
    await screen.findByRole('button', { name: `${t.remove} clip.mp4` })
    await press(t.addSend)
    await tick()
    // The Send waits for the hashes: nothing has gone out yet, and the page still offers Remove (FilePicker.tsx:83).
    expect(server.log.slice(mark)).toEqual([])
    fireEvent.click(removeOf('clip.mp4'))
    release()

    await screen.findByText(t.h4, undefined, { timeout: 5000 })
    await tick(100)
    // The DELETE was sent and failed: the attachment is still open, with only the part of the first visit.
    expect(deletes().map((r) => r.path)).toEqual([expect.stringMatching(new RegExp(`/attachments/${att.id}$`))])
    expect(server.puts(att.id).filter((r) => server.log.indexOf(r) >= mark)).toEqual([])
    expect(server.requests('POST', `/attachments/${att.id}/complete`)).toEqual([])
    expect(att.status).toBe('uploading')
    expect([...att.parts.keys()]).toEqual([1])
    // Never sent as a new file either; the report went with the other file.
    expect(server.attsOf(CODE).filter((a) => a.filename === 'clip.mp4')).toEqual([att])
    expect(server.attsOf(CODE).filter((a) => a !== att).map((a) => [a.filename, a.status])).toEqual([['b.mp4', 'complete']])
    // Its attachment still holds a place: the marked line outlives the done upload for the next load.
    expect(loadSession()?.files).toEqual([expect.objectContaining({ name: 'clip.mp4', attachmentId: att.id, removing: true })])
  })
})

describe('audit 1 finding 2: Remove tapped twice while the file is hashing', () => {
  it('finding 2: two taps on Remove of the re-picked saved video while it hashes, the first DELETE answers 503: exactly one DELETE, and the file stays with the errRemove line', async () => {
    const att = await savedHalfWay()
    server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
    page(AddVideo)
    await screen.findByText(t.resumeHint, { exact: false })

    const putsBefore = server.puts(att.id).length
    const release = holdDigest()
    pick(clip())
    await screen.findByRole('button', { name: `${t.remove} clip.mp4` })
    fireEvent.click(removeOf('clip.mp4'))
    // Still offered while its hash is pending (the Remove is queued, the file is not removing yet).
    fireEvent.click(removeOf('clip.mp4'))
    release()

    await screen.findByText(t.errRemove)
    await tick(200)
    // One DELETE for the player's Remove; none sent by itself afterwards.
    expect(deletes()).toHaveLength(1)
    expect(screen.getByText(t.errRemove)).toBeTruthy()
    expect(screen.getByRole('progressbar', { name: 'clip.mp4' })).toBeTruthy()
    expect(att.status).toBe('uploading')
    expect(server.puts(att.id)).toHaveLength(putsBefore)
  })
})

describe('audit 1 finding 3: a late createReport answer after leaving / never clears the session of the upload made since', () => {
  it('finding 3: the saved upload holds only a removed video, / is left while createReport is held, another report uploads on /add, then the answer: that session stays and the late report gets no attachment', async () => {
    // First visit on /add: the part is refused for good, Remove is pressed, its DELETE answers 503 (decided B1), the
    // page is left: the session holds only the removed, marked line.
    server.addReport(CODE)
    server.partFault = () => ({ status: 400, error: 'invalid_part' })
    server.routeFault = (m) => (m === 'DELETE' ? { status: 503 } : null)
    history.replaceState(null, '', `/add?code=${CODE}`)
    const first = page(AddVideo)
    pick(file('clip.mp4', 2 * PART))
    await press(t.addSend)
    await screen.findByText(t.errRefused)
    fireEvent.click(removeOf('clip.mp4'))
    await screen.findByText(t.errRemove)
    first.unmount()
    server.partFault = () => 'ok'
    const att = server.attsOf(CODE)[0]!
    expect(loadSession()).toMatchObject({ code: CODE, files: [{ attachmentId: att.id, removing: true }] })
    expect(loadSession()!.files).toHaveLength(1)

    // A new report on /: nothing to resume (the only line is removed), so Send goes through createReport, held.
    const gate = deferred()
    server.holdRoute = (method, path) => (method === 'POST' && path === '/reports' ? gate.promise : null)
    history.replaceState(null, '', '/')
    const report = page(Report)
    fireEvent.change(screen.getByLabelText(t.q1), { target: { value: 'The boss stopped on the bridge.' } })
    fireEvent.click(screen.getByRole('button', { name: t.next }))
    fireEvent.click(await screen.findByRole('button', { name: t.next }))
    await screen.findByText(t.h3)
    await press(t.send)
    await tick()
    report.unmount()

    // Meanwhile a video goes to another report on /add; its upload is cut, so its session must survive.
    server.addReport(OTHER)
    server.holdRoute = () => null
    server.holdPart = () => never()
    history.replaceState(null, '', `/add?code=${OTHER}`)
    page(AddVideo)
    pick(file('second.mp4', 2 * PART))
    await press(t.addSend)
    await waitFor(() => expect(loadSession()?.code).toBe(OTHER))
    const saved = structuredClone(loadSession())

    gate.resolve()
    await tick(150)
    const late = [...server.reports.keys()].find((c) => c !== CODE && c !== OTHER)
    expect(late).toBeDefined()
    expect(server.requests('POST', `/reports/${late}/attachments`)).toHaveLength(0)
    expect(loadSession()).toEqual(saved)
  })
})
