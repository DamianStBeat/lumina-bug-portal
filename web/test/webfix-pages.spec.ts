// web-fix rows 1 and 3 through the real /add page (jsdom), against the fake worker: what the player sees. Turnstile is
// a stand-in that issues a token at once, as Cloudflare's always-pass test key does (as in pages.spec.ts). A reload is
// an unmount of the page followed by a new render: nothing survives it but sessionStorage and the server.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { I18nProvider, strings } from '../src/i18n'
import AddVideo from '../src/pages/AddVideo'
import { loadSession } from '../src/upload/session'
import { CONTRACT_PART_SIZE as PART, FakeServer, MiB, file, installStorage, type Content } from './helpers'

const CODE = 'LUM-482193'
const VIDEO: Content = { seed: 1 }
const t = strings.en
let server: FakeServer

beforeEach(() => {
  installStorage()
  localStorage.clear()
  server = new FakeServer().install()
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

const never = () => new Promise<void>(() => {})
const page = () => render(createElement(I18nProvider, null, createElement(AddVideo)))
const fileInput = () => document.querySelector('input[type=file]') as HTMLInputElement
const pick = (...files: File[]) => fireEvent.change(fileInput(), { target: { files } })
async function press(name: string): Promise<void> {
  const b = await screen.findByRole('button', { name })
  await waitFor(() => expect(b).toHaveProperty('disabled', false))
  fireEvent.click(b)
}
const removeButton = (name: string) => screen.findByRole('button', { name: `${t.remove} ${name}` })

// A first visit to /add?code=LUM-482193 that sent part 1 of clip.mp4 (3 parts) and was left.
async function firstVisitLeftHalfWay(lastModified: number) {
  server.addReport(CODE)
  server.holdPart = (_id, n) => (n > 1 ? never() : null)
  history.replaceState(null, '', `/add?code=${CODE}`)
  const first = page()
  pick(file('clip.mp4', 3 * PART, 'video/mp4', lastModified, VIDEO))
  await press(t.addSend)
  await waitFor(() => expect(server.attsOf(CODE)[0]?.parts.size).toBe(1))
  first.unmount()
  server.holdPart = () => null
  return server.attsOf(CODE)[0]!
}

describe('web-fix row 1 on /add: the same video picked again after the reload, with another lastModified', () => {
  it('row 1: it carries on from the missing parts and the page shows "We have it" with the code', async () => {
    const att = await firstVisitLeftHalfWay(1000)
    const mark = server.log.length
    page()
    await screen.findByText(t.resumeHint, { exact: false })
    pick(file('clip.mp4', 3 * PART, 'video/mp4', 2000, VIDEO))
    // Picking the last missing file starts the upload by itself; when it has not, Add to report is the Send.
    await waitFor(() =>
      expect(screen.queryByText(t.h4) ?? screen.queryByRole('button', { name: t.addSend })).toBeTruthy(),
    )
    const send = screen.queryByRole('button', { name: t.addSend }) as HTMLButtonElement | null
    if (!screen.queryByText(t.h4) && send && !send.disabled) fireEvent.click(send)
    await screen.findByText(t.h4, undefined, { timeout: 4000 })
    expect(screen.getByText(CODE)).toBeTruthy()
    const after = server.log.slice(mark)
    expect(after.filter((r) => r.method === 'POST' && r.path.endsWith('/attachments'))).toEqual([])
    expect(after.filter((r) => r.method === 'PUT' && r.n === 1)).toEqual([])
    expect(server.attsOf(CODE)).toHaveLength(1)
    expect(att.status).toBe('complete')
    expect(loadSession()).toBeNull()
  }, 15_000)
})

describe('web-fix row 3 on /add: Remove fails, the place stays taken', () => {
  it('row 3: the orange remove line shows, a fourth file gets the orange count line, and Remove again frees the place', async () => {
    server.addReport(CODE)
    // The first PUT of a.mp4 is refused for good, so it has an attachment and a Remove button; b and c go up.
    server.partFault = (id) => (id === 'att-1' ? { status: 400, error: 'invalid_part' } : 'ok')
    server.routeFault = (m, _p, k) => (m === 'DELETE' && k === 1 ? { status: 503 } : null)
    history.replaceState(null, '', `/add?code=${CODE}`)
    page()
    pick(file('a.mp4', 2 * PART), file('b.mp4', 2 * MiB), file('c.mp4', 2 * MiB))
    await press(t.addSend)
    await screen.findByText(t.errRefused)
    fireEvent.click(await removeButton('a.mp4'))
    await screen.findByText(t.errRemove)
    expect(server.attsOf(CODE)[0]?.status).toBe('uploading')

    pick(file('d.mp4', 2 * MiB))
    await screen.findByText(t.errCount)
    expect(screen.queryByRole('progressbar', { name: 'd.mp4' })).toBeNull()

    fireEvent.click(await removeButton('a.mp4'))
    await waitFor(() => expect(screen.queryByRole('progressbar', { name: 'a.mp4' })).toBeNull())
    expect(screen.queryByText(t.errRemove)).toBeNull()
    expect(server.attsOf(CODE)[0]?.status).toBe('aborted')
    pick(file('d.mp4', 2 * MiB))
    await screen.findByRole('progressbar', { name: 'd.mp4' })
    expect(screen.queryByText(t.errCount)).toBeNull()
  })
})
