// Damian's row 9 of the integration slice:
//   | 9 | Desk | apro | conteggi delle schede e "Video N MB · Device" come l'anteprima |
// CONTRACT.md "Desk (team only)" and the preview (plan/preview/shots/desk.png): six tabs `Label · N`, and under the
// player's text `Video 312 MB · Phone`, `Picture 3 MB · Phone` or `No video`. Fetch answers in the worker's own JSON
// (snake_case: `counts`, `files: [{kind, size_bytes}]`), typed here as plain data on purpose: the spec feeds what the
// worker sends, not the web's type of it, so a client that does not map the wire shape cannot pass.
//
// Run by filter: `cd web && npx vitest run test/desk-data.spec.ts`. The name is .spec.ts, not .tsx: vitest.config.ts
// only collects test/**/*.spec.ts, and a spec nobody collects would be silently green.
//
// Mutations (file|old|new|label), on a throwaway prototype of the builder's code, in done-2b-tests.md's table order:
// web/src/api/client.ts|counts: deskCounts((w as any).counts) }| }|c counts not mapped
// web/src/api/client.ts|if (typeof v === 'number' && Number.isInteger(v) && v >= 0) out[k] = v|out[k] = v as number|c non numbers kept
// web/src/api/client.ts|const o = asObject(raw)\n  if (!o) return undefined|const o = raw as Record<string, unknown>|c null counts
// web/src/api/client.ts|sizeBytes: f.size_bytes|sizeBytes: f.sizeBytes|c no snake mapping
// web/src/pages/desk/ReportList.tsx|const f = files.find((x) => x.kind === 'video') ?? files.find((x) => x.kind === 'image')|const f = files[0]|p first file
// web/src/pages/desk/ReportList.tsx|const f = files.find((x) => x.kind === 'video') ?? files.find((x) => x.kind === 'image')|const f = files.find((x) => x.kind === 'video')|p no picture
// web/src/pages/desk/ReportList.tsx|Math.max(1, Math.round(f.sizeBytes / 1_000_000))|Math.round(f.sizeBytes / 1_000_000)|p no floor of 1
// web/src/pages/desk/ReportList.tsx|Math.max(1, Math.round(f.sizeBytes / 1_000_000))|Math.max(1, Math.floor(f.sizeBytes / 1_000_000))|p floor not round
// web/src/pages/desk/ReportList.tsx|Math.max(1, Math.round(f.sizeBytes / 1_000_000))|Math.max(1, Math.round(f.sizeBytes / 1_048_576))|p MiB
// web/src/pages/desk/ReportList.tsx|f.kind === 'video' ? 'Video' : 'Picture'|f.kind === 'video' ? 'Video' : 'Image'|p Image word
// web/src/pages/desk/ReportList.tsx| MB${where}`| MB`|p device dropped
// web/src/pages/desk/ReportList.tsx|if (!f) return 'No video'|if (!f) return `No video${where}`|p device on no video
// web/src/pages/desk/ReportList.tsx|const where = device && DEVICE[device] ? ` · ${DEVICE[device]}` : ''|const where = device ? ` · ${device}` : ''|p raw device
// web/src/pages/desk/ReportList.tsx|{n === undefined ? label : `${label} · ${n}`}|{`${label} · ${n}`}|p undefined count printed
// web/src/pages/desk/ReportList.tsx|media(r.files ?? [], r.device)|media(Array.from({length: r.fileCount}, () => ({kind: 'video', sizeBytes: 1000})), r.device)|p line from attachment_count
// web/src/pages/desk/ReportList.tsx|['fix_ready', 'Fix ready'],\n  ['needs_person', 'Needs a person'],|['needs_person', 'Needs a person'],\n  ['fix_ready', 'Fix ready'],|p tab order
// web/src/pages/desk/Desk.tsx|counts={list.counts}|counts={undefined}|d counts not passed
// web/src/pages/desk/Desk.tsx|return { ...l, rows: [...l.rows|return { key: l.key, rows: [...l.rows|d load more loses counts
// web/src/pages/desk/Desk.tsx|setList({ key, rows: res.reports, cursor: res.cursor, counts: res.counts })|setList((l) => ({ key, rows: res.reports, cursor: res.cursor, counts: l.counts ?? res.counts }))|d first counts kept
// web/src/pages/desk/ReportDetail.tsx|onChanged({ code, status, updatedAt, prUrl, verdict, duplicateOf })|onChanged({ code, status, updatedAt, prUrl, verdict, duplicateOf, files: [] })|r detail wipes files
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deskList } from '../src/api/client'
import Desk from '../src/pages/desk/Desk'

const AT = 1_762_400_000_000
const A = 'LUM-482193'
const B = 'LUM-482194'
const C = 'LUM-482195'

type WireFile = { kind: 'video' | 'image'; size_bytes: number }

// One worker list row as CONTRACT.md "Desk list answer" pins it: every column, including the new `files`.
function wireRow(code: string, files: WireFile[], device: string | null = 'phone') {
  return {
    code,
    created_at: AT,
    updated_at: AT,
    source: 'web',
    status: 'received',
    verdict: null,
    title: null,
    what: `What happened in ${code}`,
    where_area: null,
    device,
    attachment_count: files.length,
    files,
  }
}

const PREVIEW_COUNTS = { all: 128, fix_ready: 6, needs_person: 19, duplicate: 41, not_bug: 22, waiting: 3 }
const LABELS = ['All', 'Fix ready', 'Needs a person', 'Duplicates', 'Not a bug', 'Waiting for AI']
const PREVIEW_TABS = ['All · 128', 'Fix ready · 6', 'Needs a person · 19', 'Duplicates · 41', 'Not a bug · 22', 'Waiting for AI · 3']

function wireDetail(code: string) {
  return {
    report: {
      code,
      created_at: AT,
      updated_at: AT,
      source: 'web',
      status: 'received',
      title: null,
      what: `What happened in ${code}`,
      where_area: null,
      device: 'phone',
      lang: null,
      roblox_name: null,
      roblox_user_id: null,
      discord_name: null,
      game_context: null,
      verdict: null,
      triage: null,
      duplicate_of: null,
      pr_url: null,
    },
    attachments: [],
    duplicates: [],
  }
}

type Answer = unknown | 'never' | 'server_error'
// `list(params)` answers GET /desk/reports; the detail always answers an empty report, the list is what these specs read.
function serve(list: (params: URLSearchParams) => Answer) {
  const urls: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input instanceof Request ? input.url : input), 'http://x')
      urls.push(url.pathname + url.search)
      const detail = /\/desk\/reports\/([^/?]+)$/.exec(url.pathname)
      const a = detail ? wireDetail(decodeURIComponent(detail[1]!)) : list(url.searchParams)
      if (a === 'never') return new Promise<Response>(() => {})
      if (a === 'server_error') return new Response('{"error":"internal"}', { status: 500 })
      return new Response(JSON.stringify(a), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  return urls
}

beforeEach(() => {
  history.replaceState(null, '', '/desk')
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
})
afterEach(() => cleanup())

const open = () => render(createElement(Desk))
// The code shows in its row and, for the selected report, as the detail's heading.
const rowOf = (code: string) => screen.getAllByText(code).map((e) => e.closest('li')).find((li) => li !== null) as HTMLElement
const listed = (code: string) => waitFor(() => expect(rowOf(code)).toBeTruthy())
// The line under the player's text, as one exact string: a row whose line differs in any word fails the match.
const showsLine = (code: string, line: string) => within(rowOf(code)).getByText(line)
const tabs = () =>
  within(screen.getByRole('group', { name: 'Filter' }))
    .getAllByRole('button')
    .map((b) => b.textContent)
const showTabs = (want: string[]) => waitFor(() => expect(tabs()).toEqual(want))

describe('desk tabs: the counts of the worker, as the preview', () => {
  it('row 9: the six tabs read Label · N, in the preview\'s order', async () => {
    serve(() => ({ reports: [], nextCursor: null, counts: PREVIEW_COUNTS }))
    open()
    await showTabs(PREVIEW_TABS)
  })

  it('row 9: the client gives the worker\'s counts to the page unchanged', async () => {
    serve(() => ({ reports: [], nextCursor: null, counts: PREVIEW_COUNTS }))
    expect((await deskList('fix_ready')).counts).toEqual(PREVIEW_COUNTS)
  })

  it('row 9 edge: a count of 0 is known: "Not a bug · 0", not the plain label', async () => {
    const counts = { all: 0, fix_ready: 0, needs_person: 0, duplicate: 0, not_bug: 0, waiting: 0 }
    serve(() => ({ reports: [], nextCursor: null, counts }))
    open()
    await showTabs(LABELS.map((l) => `${l} · 0`))
  })

  it('row 9, not yet: while the list is unanswered every tab is its plain label', async () => {
    serve(() => 'never')
    open()
    expect(await screen.findByText('Loading reports…')).toBeTruthy()
    expect(tabs()).toEqual(LABELS)
  })

  it('row 9, not yet: a list that failed leaves every tab its plain label', async () => {
    serve(() => 'server_error')
    open()
    await screen.findByText(/The reports did not load\./)
    expect(tabs()).toEqual(LABELS)
  })

  it('row 9, not yet: an answer without counts leaves the plain labels, the rows still show', async () => {
    serve(() => ({ reports: [wireRow(A, [])], nextCursor: null }))
    open()
    await listed(A)
    expect(tabs()).toEqual(LABELS)
  })

  it('row 9, not yet: counts of null leave the plain labels', async () => {
    serve(() => ({ reports: [], nextCursor: null, counts: null }))
    open()
    await screen.findByText('No reports here.')
    expect(tabs()).toEqual(LABELS)
  })

  it('row 9 edge: a tab whose count is not a number shows its plain label, the rest their numbers', async () => {
    serve(() => ({ reports: [], nextCursor: null, counts: { all: 7, fix_ready: null, needs_person: '3', waiting: 2 } }))
    open()
    await showTabs(['All · 7', 'Fix ready', 'Needs a person', 'Duplicates', 'Not a bug', 'Waiting for AI · 2'])
  })

  it('row 9: Load more keeps the tab counts', async () => {
    serve((p) =>
      p.get('cursor') === 'page-2'
        ? { reports: [wireRow(B, [])], nextCursor: null, counts: PREVIEW_COUNTS }
        : { reports: [wireRow(A, [])], nextCursor: 'page-2', counts: PREVIEW_COUNTS },
    )
    open()
    await listed(A)
    await showTabs(PREVIEW_TABS)
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await listed(B)
    expect(tabs()).toEqual(PREVIEW_TABS)
  })

  it('row 9: a tab with its count filters, and the tabs follow the counts of the new answer', async () => {
    const urls = serve((p) => ({
      reports: [],
      nextCursor: null,
      counts: p.get('filter') === 'fix_ready' ? { ...PREVIEW_COUNTS, fix_ready: 7 } : PREVIEW_COUNTS,
    }))
    open()
    await showTabs(PREVIEW_TABS)
    fireEvent.click(screen.getByRole('button', { name: 'Fix ready · 6' }))
    await showTabs(['All · 128', 'Fix ready · 7', 'Needs a person · 19', 'Duplicates · 41', 'Not a bug · 22', 'Waiting for AI · 3'])
    expect(urls).toContain('/api/v1/desk/reports?filter=fix_ready')
  })
})

describe('desk row: the file line from the worker\'s files', () => {
  const VIDEO = (size_bytes: number): WireFile => ({ kind: 'video', size_bytes })
  const IMAGE = (size_bytes: number): WireFile => ({ kind: 'image', size_bytes })

  async function rows(entries: [string, WireFile[], string?][]) {
    serve(() => ({ reports: entries.map(([code, files, device]) => wireRow(code, files, device ?? 'phone')), nextCursor: null }))
    open()
    await listed(entries[0]![0])
  }

  it('row 9: a video reads Video 312 MB · Phone', async () => {
    await rows([[A, [VIDEO(312_000_000)]]])
    expect(showsLine(A, 'Video 312 MB · Phone')).toBeTruthy()
  })

  it('row 9: a picture reads Picture 3 MB · Phone', async () => {
    await rows([[A, [IMAGE(3_000_000)]]])
    expect(showsLine(A, 'Picture 3 MB · Phone')).toBeTruthy()
  })

  it('row 9: no file reads No video, and no device part even when the device is known', async () => {
    await rows([[A, [], 'phone']])
    expect(showsLine(A, 'No video')).toBeTruthy()
    expect(rowOf(A).textContent).not.toContain('Phone')
  })

  it('row 9: the other devices of the preview', async () => {
    await rows([
      [A, [VIDEO(88_000_000)], 'computer'],
      [B, [VIDEO(540_000_000)], 'tablet'],
      [C, [VIDEO(1_000_000)], 'console'],
    ])
    expect(showsLine(A, 'Video 88 MB · Computer')).toBeTruthy()
    expect(showsLine(B, 'Video 540 MB · Tablet')).toBeTruthy()
    expect(showsLine(C, 'Video 1 MB · Console')).toBeTruthy()
  })

  it('row 9, not yet: with no device known the line stops at the size', async () => {
    serve(() => ({
      reports: [wireRow(A, [VIDEO(312_000_000)], null), wireRow(B, [IMAGE(3_000_000)], null), wireRow(C, [], null)],
      nextCursor: null,
    }))
    open()
    await listed(A)
    expect(showsLine(A, 'Video 312 MB')).toBeTruthy()
    expect(showsLine(B, 'Picture 3 MB')).toBeTruthy()
    expect(showsLine(C, 'No video')).toBeTruthy()
  })

  it('row 9 edge: a device value the desk does not know is not printed', async () => {
    await rows([[A, [VIDEO(312_000_000)], 'toaster']])
    expect(showsLine(A, 'Video 312 MB')).toBeTruthy()
    expect(rowOf(A).textContent).not.toContain('toaster')
  })

  it('row 9: the first video wins, even when an older picture comes before it', async () => {
    await rows([
      [A, [IMAGE(3_000_000), VIDEO(312_000_000)]],
      [B, [VIDEO(7_000_000), VIDEO(9_000_000)]],
    ])
    expect(showsLine(A, 'Video 312 MB · Phone')).toBeTruthy()
    expect(showsLine(B, 'Video 7 MB · Phone')).toBeTruthy()
  })

  it('row 9: with no video, the first picture', async () => {
    await rows([[A, [IMAGE(2_000_000), IMAGE(4_000_000)]]])
    expect(showsLine(A, 'Picture 2 MB · Phone')).toBeTruthy()
  })

  it('row 9: the line comes from `files`, not from attachment_count', async () => {
    serve(() => ({ reports: [{ ...wireRow(A, [VIDEO(5_000_000)]), attachment_count: 3 }], nextCursor: null }))
    open()
    await listed(A)
    expect(showsLine(A, 'Video 5 MB · Phone')).toBeTruthy()
    expect(rowOf(A).textContent).not.toContain('3 files')
  })

  it('row 9, not yet: the row keeps its line after the detail answers', async () => {
    await rows([[A, [VIDEO(312_000_000)]]])
    await screen.findByRole('heading', { name: A })
    expect(showsLine(A, 'Video 312 MB · Phone')).toBeTruthy()
  })

  // bytes / 1 000 000 rounded, at least 1 (CONTRACT.md). One row per case in a single render; the name carries the case.
  const ROUNDING: [number, string][] = [
    [312_000_000, '312 MB'],
    [2_999_999, '3 MB'],
    [400_000, '1 MB'],
    [499_999, '1 MB'], // rounds to 0: the floor of 1 holds
    [500_000, '1 MB'],
    [999_999, '1 MB'],
    [1_000_000, '1 MB'],
    [1_499_999, '1 MB'], // below the half: down
    [1_500_000, '2 MB'], // the half: up
    [1_048_576, '1 MB'], // not a MiB count
    [0, '1 MB'], // at least 1
    [5_368_709_120, '5369 MB'],
  ]

  it('row 9 edges: MB is bytes / 1 000 000 rounded, at least 1', async () => {
    const entries = ROUNDING.map(([bytes], i): [string, WireFile[]] => [`LUM-5${String(i).padStart(5, '0')}`, [VIDEO(bytes)]])
    await rows(entries)
    ROUNDING.forEach(([bytes, size], i) => {
      expect(showsLine(entries[i]![0], `Video ${size} · Phone`), String(bytes)).toBeTruthy()
    })
  })
})
