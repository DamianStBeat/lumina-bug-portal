// Acceptance row 9 and the public status mapping of CONTRACT.md "Statuses": /status/LUM-482193 shows one of the four
// public states (received, looking, fixed, checked), the one the API answered, and nothing else about the report.
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { I18nProvider, strings } from '../src/i18n'
import Status from '../src/pages/Status'
import { FakeServer, deferred, installStorage } from './helpers'

const CODE = 'LUM-482193'
const t = strings.en
const PUBLIC = ['received', 'looking', 'fixed', 'checked'] as const
let server: FakeServer

beforeEach(() => {
  installStorage()
  localStorage.clear()
  history.replaceState(null, '', `/status/${CODE}`)
  server = new FakeServer().install()
})
afterEach(() => cleanup())

const open = () => render(createElement(I18nProvider, null, createElement(Status)))
const shownStates = () => PUBLIC.filter((s) => screen.queryByText(t.status[s]) !== null)

describe('row 9: /status/LUM-482193 shows one of the four states, nothing else', () => {
  for (const s of PUBLIC) {
    it(`row 9: the API status ${s} shows the ${s} line and no other state`, async () => {
      server.addReport(CODE, s)
      open()
      await screen.findByText(t.status[s])
      expect(shownStates()).toEqual([s])
      expect(server.requests('GET', `/status/${CODE}`)).toHaveLength(1)
    })
  }

  it('row 9: fields the API might add (what, verdict, PR link, name) are not shown', async () => {
    server.addReport(CODE, 'looking', {
      what: 'SECRET-WHAT the boss stopped',
      verdict: 'simple_fix',
      prUrl: 'https://github.com/DamianStBeat/Lumina2/pull/1402',
      robloxName: 'SecretPlayer',
    })
    open()
    await screen.findByText(t.status.looking)
    const text = document.body.textContent ?? ''
    for (const leak of ['SECRET-WHAT', 'simple_fix', 'pull/1402', 'SecretPlayer']) expect(text).not.toContain(leak)
  })

  for (const internal of ['duplicate', 'not_bug', 'closed']) {
    it(`row 9: an internal status (${internal}) reaching the page is not shown as a state`, async () => {
      server.addReport(CODE, internal)
      open()
      await screen.findByRole('alert')
      expect(shownStates()).toEqual([])
      expect(document.body.textContent ?? '').not.toContain(internal)
    })
  }

  it('row 9: an unknown code says the code was not found, with no state', async () => {
    open()
    await screen.findByText(t.errCode)
    expect(shownStates()).toEqual([])
  })

  it('row 9: while the answer is loading no state is shown (not yet is not received)', async () => {
    server.addReport(CODE, 'fixed')
    const gate = deferred()
    const real = server.fetch.getMockImplementation()!
    server.fetch.mockImplementation(async (input, init) => {
      await gate.promise
      return real(input, init)
    })
    open()
    expect(screen.getByText(t.loading)).toBeTruthy()
    expect(shownStates()).toEqual([])
    gate.resolve()
    await screen.findByText(t.status.fixed)
  })

  it('row 9: no network shows the load error and Try again, with no state', async () => {
    server.addReport(CODE, 'received')
    server.offline = true
    open()
    await screen.findByText(t.errLoad)
    expect(screen.getByRole('button', { name: t.retry })).toBeTruthy()
    expect(shownStates()).toEqual([])
  })
})
