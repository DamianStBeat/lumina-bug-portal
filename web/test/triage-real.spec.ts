// Row 4 (bp-web-upload): a report with the agent's real triage, opened on the desk, shows what it is, the probable
// cause, the files, the risk and the duplicate. The answer is the worker's on main for a report the agent on main
// triaged (test/fixtures/triage-real.ts, every key quoted from its producer); fetch serves it as in desk.spec.ts.
//
// Labels: the approved preview (bp-web/plan/preview/index.html:309-315) names "What it is", "Likely cause", "Risk
// path", "Same bug", "Fix", but no label for the verdict nor for each likely file. The specs assert on the values
// inside the AI triage panel, never on label wording, so the builder keeps the preview's labels free to place.
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReportDetail } from '../src/pages/desk/ReportDetail'
import { CODE, ORIGINAL, triageReal, type AgentStageB, type DeskDetailMain } from './fixtures/triage-real'

// The desk's line for a report the AI has not read; ReportDetail.tsx:175 today.
const NOT_YET = 'The AI has not looked at this report yet.'

afterEach(() => cleanup())

// Answers the desk detail of CODE with `r`, or never answers when `r` is null (still loading).
function serve(r: DeskDetailMain | null) {
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input)
    if (r === null) return new Promise<Response>(() => {})
    if (!url.endsWith(`/desk/reports/${CODE}`)) return new Response('{"error":"not_found"}', { status: 404 })
    return new Response(JSON.stringify(r), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

const onDenied = () => {}
const onChanged = () => {}

// The AI triage panel of the loaded report: the block under its "AI triage" heading (preview and ReportDetail both
// head it that way). Waiting on the report's own heading first means "not shown" is never read while loading.
async function openPanel(r: DeskDetailMain): Promise<HTMLElement> {
  serve(r)
  render(createElement(ReportDetail, { code: CODE, onDenied, onChanged }))
  await screen.findByRole('heading', { name: CODE })
  const heading = screen.getByRole('heading', { name: /AI triage/ })
  const panel = heading.parentElement
  if (!panel) throw new Error('the AI triage heading has no panel around it')
  return panel
}

// The panel's text with runs of whitespace as one space, so `path:line` split over elements still reads as one.
const textOf = (el: HTMLElement) => (el.textContent ?? '').replace(/\s+/g, ' ')

const stageA = (r: DeskDetailMain) => r.report.triage!.stage_a!
const stageB = (r: DeskDetailMain) => r.report.triage!.stage_b!

describe('row 4: the desk reads the triage the agent on main posts', () => {
  it('row 4: what it is (stage A `what`) and the verdict are shown', async () => {
    const r = triageReal()
    const text = textOf(await openPanel(r))
    expect(text).toContain(stageA(r).what)
    expect(text).toMatch(/duplicate/i)
  })

  it('row 4: the probable cause is stage B `summary`', async () => {
    const r = triageReal()
    const text = textOf(await openPanel(r))
    expect(text).toContain(stageB(r).summary)
  })

  it('row 4: every likely file shows as `path:line` with its `why`', async () => {
    const r = triageReal()
    const text = textOf(await openPanel(r))
    expect(stageB(r).likely_files).toHaveLength(2)
    for (const f of stageB(r).likely_files) {
      expect(text).toContain(`${f.path}:${f.line}`)
      expect(text).toContain(f.why)
    }
  })

  it('row 4: the risk shows each of `risk_paths` and the `fix_size`', async () => {
    const r = triageReal()
    const text = textOf(await openPanel(r))
    for (const p of stageB(r).risk_paths) expect(text).toContain(p)
    expect(text).toMatch(new RegExp(`\\b${stageB(r).fix_size}\\b`, 'i'))
  })

  it('row 4: the duplicate shows the code it is the same as (`duplicate_of`)', async () => {
    const r = triageReal()
    const text = textOf(await openPanel(r))
    expect(text).toContain(ORIGINAL)
  })

  it('row 4: a real triage never reads as "not looked at yet"', async () => {
    await openPanel(triageReal())
    expect(screen.queryByText(NOT_YET)).toBeNull()
  })

  it('row 4 verdict: another verdict shows as that verdict (needs_person)', async () => {
    // run.py:191 and agent.ts:177: needs_person leaves the report `looking` with no link; stage B names no duplicate.
    const r = triageReal()
    Object.assign(r.report, { status: 'looking', verdict: 'needs_person', duplicate_of: null })
    Object.assign(stageB(r), { verdict: 'needs_person', duplicate_of: null })
    const text = textOf(await openPanel(r))
    expect(text).toMatch(/needs(_| a )person/i)
  })

  it('row 4 edge: line 0 is a line (`path:0`); line null shows the path alone, never "null"', async () => {
    const r = triageReal()
    stageB(r).likely_files = [
      { path: 'src/server/Waves/WaveClock.luau', line: 0, why: 'the clock starts before the map loads' },
      { path: 'src/shared/Maps/Bridge/Layout.luau', line: null, why: 'the layout table has no end marker' },
    ]
    const text = textOf(await openPanel(r))
    expect(text).toContain('src/server/Waves/WaveClock.luau:0')
    expect(text).toContain('src/shared/Maps/Bridge/Layout.luau')
    expect(text).toContain('the layout table has no end marker')
    expect(text).not.toMatch(/null|undefined/)
  })
})

describe('row 4 not yet: stage B missing, no triage, still loading', () => {
  it('stage A only (stage B not done): stage A shows, nothing crashes, and it is not "not looked at yet"', async () => {
    // run.py:191: stage B gave no valid answer, so the verdict is unclear and stage_b is null; agent.ts:177: looking.
    const r = triageReal()
    Object.assign(r.report, { status: 'looking', verdict: 'unclear', duplicate_of: null })
    Object.assign(r.report.triage!, { stage_b: null, notes: ['stage_b_invalid'] })
    const text = textOf(await openPanel(r))
    expect(text).toContain(stageA(r).what)
    expect(text).toMatch(/unclear/i)
    expect(screen.queryByText(NOT_YET)).toBeNull()
    // Risk unknown is not risk none: without stage B the panel never says there is no risk path.
    expect(text).not.toMatch(/\bnone\b/i)
  })

  it('triage null: the panel still says "not looked at yet"', async () => {
    const r = triageReal()
    Object.assign(r.report, { status: 'received', verdict: null, duplicate_of: null, triage: null })
    await openPanel(r)
    expect(screen.getByText(NOT_YET)).toBeTruthy()
  })

  it('still loading: "not looked at yet" is not shown before the answer', async () => {
    const fetch = serve(null)
    render(createElement(ReportDetail, { code: CODE, onDenied, onChanged }))
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByText(NOT_YET)).toBeNull()
  })
})

describe('row 4 untrusted: the triage is data, never trusted', () => {
  it('likely_files of the wrong type ("x") is dropped; the rest of the triage still shows', async () => {
    const r = triageReal()
    // Deliberately not an array: the stored JSON is the agent's, the desk must not trust its types.
    ;(stageB(r) as Record<keyof AgentStageB, unknown>).likely_files = 'WRONG-TYPE-FILES'
    const text = textOf(await openPanel(r))
    expect(text).not.toContain('WRONG-TYPE-FILES')
    expect(text).toContain(stageA(r).what)
    expect(text).toContain(stageB(r).summary)
    for (const p of stageB(r).risk_paths) expect(text).toContain(p)
    expect(text).toContain(ORIGINAL)
  })

  it('a likely file whose path is not text is dropped; the good one still shows', async () => {
    const r = triageReal()
    const [good] = stageB(r).likely_files
    ;(stageB(r) as Record<keyof AgentStageB, unknown>).likely_files = [
      { path: 4242, line: 7, why: 'BAD-ITEM-WHY' },
      good,
    ]
    const text = textOf(await openPanel(r))
    expect(text).toContain(`${good!.path}:${good!.line}`)
    expect(text).not.toContain('BAD-ITEM-WHY')
    expect(text).not.toContain('4242')
  })

  it('HTML in `summary` renders as literal text, never as an element', async () => {
    const r = triageReal()
    const evil = 'Boss stops <img src=x onerror="globalThis.__triagePwned=1"> at the end'
    stageB(r).summary = evil
    const panel = await openPanel(r)
    expect(textOf(panel)).toContain(evil)
    expect(document.querySelector('[onerror]')).toBeNull()
    expect(panel.querySelector('img')).toBeNull()
  })
})
