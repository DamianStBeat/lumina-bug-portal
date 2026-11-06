// Row 4 (bp-web-upload): a report with the agent's real triage, opened on the desk, shows what it is, the probable
// cause, the files, the risk and the duplicate. The answer is the worker's on main for a report the agent on main
// triaged (test/fixtures/triage-real.ts, every key quoted from its producer); fetch serves it as in desk.spec.ts.
//
// Labels (tests-commit 9): the panel is the approved preview's (bp-web/plan/preview/index.html:309-315, shots/desk.png),
// row 5 «nessun cambiamento visivo». Its rows are `<li><b>Label:</b> value</li>` with the labels "What it is",
// "Likely cause", "Risk path", "Same bug", "Fix", in that order; the verdict is not one of them (the list shows it as
// a chip), and the gold "marked by the AI" frame is not asserted (the agent names no frame).
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

// The preview's rows, in its order (index.html:309-315).
const LABELS = ['What it is', 'Likely cause', 'Risk path', 'Same bug', 'Fix'] as const
type Label = (typeof LABELS)[number]
// The panel's rows: its list items, not one inside another (a likely file in a nested list is part of its row).
const rows = (panel: HTMLElement): string[] =>
  [...panel.querySelectorAll('li')].filter((li) => !li.parentElement?.closest('li')).map((li) => textOf(li).trim())
const labelOf = (row: string): Label | undefined => LABELS.find((l) => row.startsWith(`${l}:`))
// The value of the row with that label, or undefined when the panel has no such row.
function rowOf(panel: HTMLElement, label: Label): string | undefined {
  const r = rows(panel).filter((x) => labelOf(x) === label)
  expect(r.length).toBeLessThanOrEqual(1)
  return r[0]?.slice(label.length + 1).trim()
}
// The value of a row the panel must have: a missing row fails here, by its label.
function need(panel: HTMLElement, label: Label): string {
  const v = rowOf(panel, label)
  expect(v, `the panel has a "${label}" row`).toBeDefined()
  return v ?? ''
}
// Rows with none of the preview's labels (the old unlabelled verdict line was one).
const unlabelled = (panel: HTMLElement) => rows(panel).filter((x) => labelOf(x) === undefined)

describe('row 4: the desk reads the triage the agent on main posts', () => {
  it('row 4: what it is (stage A `what`) shows, and the verdict is not a line of the panel', async () => {
    const r = triageReal()
    const panel = await openPanel(r)
    expect(need(panel, 'What it is')).toContain(stageA(r).what)
    // The list shows the verdict as a chip; the preview's panel has no such line.
    expect(unlabelled(panel)).toEqual([])
    expect(textOf(panel)).not.toMatch(/\bduplicate\b/i)
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

  it('row 4 verdict: another verdict (needs_person) with both stages is not a line of the panel either', async () => {
    // run.py:191 and agent.ts:177: needs_person leaves the report `looking` with no link; stage B names no duplicate.
    const r = triageReal()
    Object.assign(r.report, { status: 'looking', verdict: 'needs_person', duplicate_of: null })
    Object.assign(stageB(r), { verdict: 'needs_person', duplicate_of: null })
    const panel = await openPanel(r)
    expect(need(panel, 'What it is')).toContain(stageA(r).what)
    expect(unlabelled(panel)).toEqual([])
    expect(textOf(panel)).not.toMatch(/needs(_| a )person/i)
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
    const panel = await openPanel(r)
    const text = textOf(panel)
    expect(need(panel, 'What it is')).toContain(stageA(r).what)
    // A stage exists, so the verdict is not a line (tests-commit 9): the list's chip says "Unclear".
    expect(unlabelled(panel)).toEqual([])
    expect(text).not.toMatch(/unclear/i)
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

describe('row 5: the desk AI panel is the approved preview, filled from the real triage (tests-commit 9)', () => {
  // The preview's two other reports under "Same bug" (index.html:313), here as the worker's `duplicates` of this one:
  // the codes of the reports whose duplicate_of is CODE (desk.ts getReport).
  const LINKED = ['LUM-481993', 'LUM-479093']

  it('row 5: a full triage shows exactly the preview rows, in its order, each with its label', async () => {
    const panel = await openPanel(triageReal())
    expect(rows(panel).map(labelOf)).toEqual([...LABELS])
  })

  it('row 5 Likely cause: stage B `summary` first, then each likely file `path:line` with its `why`, in order', async () => {
    const r = triageReal()
    const cause = need(await openPanel(r), 'Likely cause')
    const [f1, f2] = stageB(r).likely_files
    const at = [stageB(r).summary, `${f1!.path}:${f1!.line}`, f1!.why, `${f2!.path}:${f2!.line}`, f2!.why].map((s) =>
      cause.indexOf(s),
    )
    expect(at.every((i) => i >= 0)).toBe(true)
    expect(at).toEqual([...at].sort((a, b) => a - b))
  })

  it('row 5 Likely cause: a summary and whys that end in a full stop never read as doubled punctuation (`.;`)', async () => {
    const r = triageReal()
    stageB(r).summary = 'BossPath expects nine waypoints while the Bridge path has eight.'
    stageB(r).likely_files = [
      { path: 'src/server/Waves/BossPath.luau', line: 212, why: 'Reads waypoint nine, which Bridge lacks.' },
      { path: 'src/shared/Maps/Bridge/Waypoints.luau', line: 8, why: 'The Bridge path ends at waypoint eight.' },
    ]
    const cause = need(await openPanel(r), 'Likely cause')
    expect(cause).toContain('BossPath expects nine waypoints while the Bridge path has eight')
    expect(cause).toContain('src/shared/Maps/Bridge/Waypoints.luau:8')
    expect(cause).toContain('The Bridge path ends at waypoint eight')
    expect(cause).not.toMatch(/[.;,:]\s*[.;,]/)
  })

  it('row 5 Risk path: every one of `risk_paths`, in one row', async () => {
    const r = triageReal()
    stageB(r).risk_paths = ['src/server/Network/WaveSync.luau', 'src/server/Data/SaveStore.luau']
    const risk = need(await openPanel(r), 'Risk path')
    for (const p of stageB(r).risk_paths) expect(risk).toContain(p)
  })

  it('row 5 Risk path: stage B with an empty `risk_paths` says the preview word "none"', async () => {
    const r = triageReal()
    stageB(r).risk_paths = []
    expect(need(await openPanel(r), 'Risk path')).toMatch(/^none\b/i)
  })

  it('row 5 Same bug: `duplicate_of` and the codes in the worker `duplicates`, as the preview lists two codes', async () => {
    const r = triageReal()
    r.duplicates = [...LINKED]
    const same = need(await openPanel(r), 'Same bug')
    for (const c of [ORIGINAL, ...LINKED]) expect(same).toContain(c)
  })

  it('row 5 Same bug: no `duplicate_of` (needs_person) but two reports linked here: the row lists their codes', async () => {
    const r = triageReal()
    Object.assign(r.report, { status: 'looking', verdict: 'needs_person', duplicate_of: null })
    Object.assign(stageB(r), { verdict: 'needs_person', duplicate_of: null })
    r.duplicates = [...LINKED]
    const same = need(await openPanel(r), 'Same bug')
    for (const c of LINKED) expect(same).toContain(c)
    expect(same).not.toContain(ORIGINAL)
  })

  it('row 5 Fix: the row is `fix_size`', async () => {
    const r = triageReal()
    expect(need(await openPanel(r), 'Fix')).toMatch(new RegExp(`\\b${stageB(r).fix_size}\\b`, 'i'))
  })

  it('row 5 agent failed (both stages null, verdict unclear): the panel shows the verdict alone, never "not looked at yet"', async () => {
    // run.py:155: post_triage(code, "unclear", None, None, [], ["agent_failed"]).
    const r = triageReal()
    Object.assign(r.report, { status: 'looking', verdict: 'unclear', duplicate_of: null })
    Object.assign(r.report.triage!, { stage_a: null, stage_b: null, files: [], notes: ['agent_failed'] })
    const panel = await openPanel(r)
    expect(textOf(panel)).toMatch(/unclear/i)
    expect(rows(panel).map(labelOf).filter(Boolean)).toEqual([])
    expect(screen.queryByText(NOT_YET)).toBeNull()
  })

  it('row 5 triage too large (both stages null, verdict simple_fix kept): the verdict alone, never "not looked at yet"', async () => {
    // run.py:76: fit_triage keeps the verdict and drops both stages, notes ["triage_too_large"].
    const r = triageReal()
    Object.assign(r.report, { status: 'looking', verdict: 'simple_fix', duplicate_of: null })
    Object.assign(r.report.triage!, { stage_a: null, stage_b: null, notes: ['triage_too_large'] })
    const panel = await openPanel(r)
    expect(textOf(panel)).toMatch(/simple(_| )fix/i)
    expect(rows(panel).map(labelOf).filter(Boolean)).toEqual([])
    expect(screen.queryByText(NOT_YET)).toBeNull()
  })
})

describe('audit 1 finding 4: each typed field of the stored triage, of the wrong type, is dropped and nothing crashes', () => {
  // A stored triage is the agent's JSON (desk.ts parsed): its types are not trusted. Each case breaks one field; the
  // detail still renders (heading, video, Mark fixed), the broken value never shows, the other fields still do.
  const BAD = 424242
  type Case = [string, (r: DeskDetailMain) => void, (r: DeskDetailMain) => string[]]
  const loose = (r: DeskDetailMain) => stageB(r) as Record<keyof AgentStageB, unknown>
  const cases: Case[] = [
    [
      'likely file `why` = {}',
      (r) => {
        ;(loose(r).likely_files as Record<string, unknown>[])[0]!.why = {}
      },
      (r) => [stageB(r).summary, `${stageB(r).likely_files[0]!.path}:212`, stageB(r).likely_files[1]!.why, ORIGINAL],
    ],
    [
      'stage A `what` = a number',
      (r) => {
        ;(stageA(r) as Record<string, unknown>).what = BAD
      },
      (r) => [stageB(r).summary, stageB(r).likely_files[0]!.why, ...stageB(r).risk_paths, ORIGINAL, 'medium'],
    ],
    [
      'stage B `summary` = a number',
      (r) => {
        loose(r).summary = BAD
      },
      (r) => [stageA(r).what, stageB(r).likely_files[0]!.why, ...stageB(r).risk_paths, ORIGINAL, 'medium'],
    ],
    [
      '`risk_paths` = a string',
      (r) => {
        loose(r).risk_paths = 'WRONG-TYPE-RISK'
      },
      (r) => [stageA(r).what, stageB(r).summary, ORIGINAL, 'medium'],
    ],
    [
      '`duplicate_of` = {}',
      (r) => {
        loose(r).duplicate_of = {}
      },
      (r) => [stageA(r).what, stageB(r).summary, ...stageB(r).risk_paths, 'medium'],
    ],
    [
      '`fix_size` = {}',
      (r) => {
        loose(r).fix_size = {}
      },
      (r) => [stageA(r).what, stageB(r).summary, ...stageB(r).risk_paths, ORIGINAL],
    ],
  ]

  it.each(cases)('finding 4: %s: the detail renders, the value is dropped, the other fields show', async (_l, br, others) => {
    const r = triageReal()
    const want = others(r)
    br(r)
    const panel = await openPanel(r)
    const text = textOf(panel)
    for (const s of want) expect(text).toContain(s)
    expect(text).not.toContain(String(BAD))
    expect(text).not.toContain('WRONG-TYPE-RISK')
    expect(text).not.toContain('[object')
    expect(screen.getByText('boss-bridge.mp4', { exact: false })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Mark fixed' })).toBeTruthy()
  })

  it('finding 4: `risk_paths` of the wrong type is unknown, never "none" (no all-clear from broken data)', async () => {
    const r = triageReal()
    loose(r).risk_paths = 'WRONG-TYPE-RISK'
    expect(rowOf(await openPanel(r), 'Risk path') ?? '').not.toMatch(/\bnone\b/i)
  })

  it('finding 4: a report verdict that is not one of the five (`__proto__`, both stages null) is dropped, nothing crashes', async () => {
    // `__proto__` is the one key that a plain lookup without an own-key check turns into an object (React throws).
    const r = triageReal()
    Object.assign(r.report, { status: 'looking', verdict: '__proto__', duplicate_of: null })
    Object.assign(r.report.triage!, { stage_a: null, stage_b: null, notes: ['agent_failed'] })
    const text = textOf(await openPanel(r))
    expect(text).not.toContain('[object')
    expect(text).not.toContain('__proto__')
    expect(screen.getByRole('button', { name: 'Mark fixed' })).toBeTruthy()
  })
})
