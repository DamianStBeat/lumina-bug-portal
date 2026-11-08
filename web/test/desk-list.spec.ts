// The desk reads the worker's JSON on main (worker/src/routes/desk.ts: listReports, getReport): `nextCursor` pages
// the list, `attachment_count` is the row's file count, frames come inside `attachments` with `kind: "frames"`, and a
// 2xx without the envelope is a bad answer (502 bad_answer), never an empty desk. Here fetch answers in those shapes.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deskList, deskReport } from '../src/api/client'
import type { DeskAttachmentWire, DeskListRowWire, DeskReportWire } from '../src/api/types'
import Desk from '../src/pages/desk/Desk'
import { triageReal } from './fixtures/triage-real'

const AT = 1_762_400_000_000
const A = 'LUM-482193'
const B = 'LUM-482194'

function row(code: string, attachment_count: number, what = `What happened in ${code}`): DeskListRowWire {
  return {
    code,
    created_at: AT,
    updated_at: AT,
    source: 'web',
    status: 'received',
    verdict: null,
    title: null,
    what,
    where_area: null,
    device: null,
    attachment_count,
    files: Array.from({ length: attachment_count }, () => ({ kind: 'video' as const, size_bytes: 5_000_000 })),
  }
}

function att(id: string, kind: DeskAttachmentWire['kind'], status: DeskAttachmentWire['status'] = 'complete'): DeskAttachmentWire {
  const mime = kind === 'video' ? 'video/mp4' : 'image/jpeg'
  return { id, kind, filename: `${id}.${kind === 'video' ? 'mp4' : 'jpg'}`, mime, size_bytes: 1000, status, created_at: AT, completed_at: AT }
}

function detail(code: string, attachments: DeskAttachmentWire[]): DeskReportWire {
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
      device: null,
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
    attachments,
    duplicates: [],
  }
}

type Answer = unknown | { raw: string } | 'never'
// `list(cursor)` answers GET /desk/reports for that cursor (undefined: the first page); `report(code)` the detail.
function serve(list: (cursor: string | undefined) => Answer, report: (code: string) => Answer = (c) => detail(c, [])) {
  const urls: string[] = []
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://x')
    urls.push(url.pathname + url.search)
    const m = /\/desk\/reports\/([^/?]+)$/.exec(url.pathname)
    const a = m ? report(decodeURIComponent(m[1]!)) : url.pathname.endsWith('/desk/reports') ? list(url.searchParams.get('cursor') ?? undefined) : null
    if (a === 'never') return new Promise<Response>(() => {})
    if (a === null) return new Response('{"error":"not_found"}', { status: 404 })
    const body = typeof a === 'object' && a !== null && 'raw' in a ? (a as { raw: string }).raw : JSON.stringify(a)
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
  vi.stubGlobal('fetch', fetch)
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
function withoutDuplicates(r: DeskReportWire): Partial<DeskReportWire> {
  const copy: Partial<DeskReportWire> = { ...r }
  delete copy.duplicates
  return copy
}

describe('desk list: nextCursor pages the list', () => {
  it('nextCursor: Load more asks for the next page with that cursor and adds its rows', async () => {
    const urls = serve((cursor) =>
      cursor === undefined
        ? { reports: [row(A, 1)], nextCursor: 'page-2' }
        : cursor === 'page-2'
          ? { reports: [row(B, 1)], nextCursor: null }
          : null,
    )
    open()
    await listed(A)
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }))
    await listed(B)
    expect(urls.filter((u) => u.startsWith('/api/v1/desk/reports?'))).toEqual([
      '/api/v1/desk/reports?filter=all',
      '/api/v1/desk/reports?filter=all&cursor=page-2',
    ])
    // The last page sent nextCursor null: nothing more to load.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull())
  })

  it('nextCursor edge: a first page with nextCursor null shows no Load more', async () => {
    serve(() => ({ reports: [row(A, 1)], nextCursor: null }))
    open()
    await listed(A)
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull()
  })
})

describe('desk list: attachment_count is the row\'s file count', () => {
  it('attachment_count: 2 and 1 show the first file\'s line, 0 says "No video"', async () => {
    const C = 'LUM-482195'
    serve(() => ({ reports: [row(A, 2), row(B, 1), row(C, 0)], nextCursor: null }))
    open()
    await listed(A)
    expect(rowOf(A).textContent).toContain('Video 5 MB')
    expect(rowOf(B).textContent).toContain('Video 5 MB')
    expect(rowOf(B).textContent).not.toContain('files')
    expect(rowOf(C).textContent).toContain('No video')
  })
})

describe('desk detail: frames come inside attachments and are shown apart', () => {
  it('frames: the player\'s video plays, the two frames are the frame strip and the first is its poster', async () => {
    serve(
      () => ({ reports: [row(A, 1)], nextCursor: null }),
      (c) => detail(c, [att('att-1', 'video'), att('fr-1', 'frames'), att('fr-2', 'frames')]),
    )
    open()
    await screen.findByRole('heading', { name: A })
    const video = document.querySelector('video')
    expect(video?.getAttribute('src')).toContain('/desk/attachments/att-1/stream')
    expect(video?.getAttribute('poster')).toContain('/desk/attachments/fr-1/stream')
    expect(screen.getByRole('button', { name: 'Open frame 1' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open frame 2' })).toBeTruthy()
    expect(screen.queryByText('No video or picture.')).toBeNull()
  })

  it('frames: the detail client gives the player\'s files and the agent\'s frames apart, each in the worker\'s order', async () => {
    serve(
      () => null,
      (c) => detail(c, [att('fr-1', 'frames'), att('att-1', 'video'), att('fr-2', 'frames'), att('att-2', 'image', 'uploading')]),
    )
    const r = await deskReport(A)
    expect(r.attachments.map((x) => x.id)).toEqual(['att-1', 'att-2'])
    expect(r.frames.map((x) => x.id)).toEqual(['fr-1', 'fr-2'])
  })

  it('frames edge: frames alone are not the player\'s file: "No video or picture." with the frame strip', async () => {
    serve(
      () => ({ reports: [row(A, 0)], nextCursor: null }),
      (c) => detail(c, [att('fr-1', 'frames')]),
    )
    open()
    await screen.findByText('No video or picture.')
    expect(document.querySelector('video')).toBeNull()
    expect(screen.getByRole('button', { name: 'Open frame 1' })).toBeTruthy()
  })
})

describe('desk: a 2xx without the worker\'s envelope is an error, never an empty desk', () => {
  it('envelope: the list client rejects 200 {} and 200 { reports: null } as 502 bad_answer', async () => {
    serve(() => ({}))
    await expect(deskList('all')).rejects.toMatchObject({ status: 502, code: 'bad_answer' })
    serve(() => ({ reports: null, nextCursor: null }))
    await expect(deskList('all')).rejects.toMatchObject({ status: 502, code: 'bad_answer' })
  })

  it('envelope: the detail client rejects the old flat shape and an envelope without duplicates as 502 bad_answer', async () => {
    serve(
      () => null,
      (c) => detail(c, []).report,
    )
    await expect(deskReport(A)).rejects.toMatchObject({ status: 502, code: 'bad_answer' })
    serve(
      () => null,
      () => withoutDuplicates(detail(A, [])),
    )
    await expect(deskReport(A)).rejects.toMatchObject({ status: 502, code: 'bad_answer' })
  })

  it('envelope: the desk page shows "The reports did not load." with Try again, not "No reports here."', async () => {
    serve(() => ({}))
    open()
    await screen.findByText('The reports did not load.', { exact: false })
    expect(screen.getByRole('button', { name: 'Try again' })).toBeTruthy()
    expect(screen.queryByText('No reports here.')).toBeNull()
  })

  it('envelope: a detail without duplicates shows "This report did not load.", not the report', async () => {
    serve(
      () => ({ reports: [row(A, 1)], nextCursor: null }),
      () => withoutDuplicates(detail(A, [att('att-1', 'video')])),
    )
    open()
    await screen.findByText('This report did not load.')
    expect(screen.queryByRole('heading', { name: A })).toBeNull()
  })

  it('envelope, not yet: while the list is unanswered neither "No reports here." nor the failure line shows', async () => {
    serve(() => 'never')
    open()
    await screen.findByText('Loading reports…')
    expect(screen.queryByText('No reports here.')).toBeNull()
    expect(screen.queryByText('The reports did not load.', { exact: false })).toBeNull()
  })
})

// bp-web-fix audit finding 5: the field mapping beyond nextCursor, attachment_count, frames and the envelope.
describe('desk: the worker\'s columns reach the page (snake_case in, null as not set)', () => {
  const PR = 'https://github.com/DamianStBeat/Lumina2/pull/12'

  it('fields, list row: device, title, where_area and verdict show in the row', async () => {
    // The selected row is refreshed from its detail answer (Desk patchRow), so the detail carries the same verdict.
    const d = detail(A, [])
    serve(
      () => ({
        reports: [{ ...row(A, 1), device: 'phone', title: 'Boss froze on the bridge', where_area: 'match', verdict: 'simple_fix' }],
        nextCursor: null,
      }),
      () => ({ ...d, report: { ...d.report, verdict: 'simple_fix' } }),
    )
    open()
    await screen.findByRole('heading', { name: A })
    await listed(A)
    const text = rowOf(A).textContent ?? ''
    expect(text).toContain('Video 5 MB · Phone')
    expect(text).toContain('Boss froze on the bridge')
    expect(text).not.toContain(`What happened in ${A}`)
    expect(text).toContain('Match')
    expect(text).toContain('Simple fix')
  })

  it('fields, list row: a row that is not selected (never refreshed from a detail) shows its own verdict', async () => {
    serve(() => ({ reports: [row(A, 0), { ...row(B, 2), verdict: 'not_bug', device: 'console' }], nextCursor: null }))
    open()
    await screen.findByRole('heading', { name: A })
    const text = rowOf(B).textContent ?? ''
    expect(text).toContain('Not a bug')
    expect(text).toContain('Video 5 MB · Console')
  })

  it('fields, list client: every column is renamed and null becomes absent', async () => {
    serve(() => ({
      reports: [row(A, 0), { ...row(B, 3), title: 'T', where_area: 'shop', device: 'computer', verdict: 'unclear' }],
      nextCursor: null,
    }))
    const { reports } = await deskList('all')
    expect(reports[1]).toMatchObject({ code: B, createdAt: AT, updatedAt: AT, title: 'T', whereArea: 'shop', device: 'computer', verdict: 'unclear', fileCount: 3 })
    for (const k of ['title', 'whereArea', 'device', 'verdict'] as const) expect(reports[0]![k]).toBeUndefined()
  })

  it('fields, list row edge: null columns are "not set": no device, the text, "—" and "Waiting for AI"', async () => {
    serve(() => ({ reports: [row(A, 1)], nextCursor: null }))
    open()
    await listed(A)
    const text = rowOf(A).textContent ?? ''
    expect(text).toContain('Video 5 MB')
    expect(text).not.toContain('·')
    expect(text).toContain(`What happened in ${A}`)
    expect(text).toContain('—')
    expect(text).toContain('Waiting for AI')
  })

  it('fields, detail: the AI triage shows, pr_url gives Open PR #12, and duplicate_of reaches the row', async () => {
    const d = detail(A, [])
    // The triage as the agent on main posts it (test/fixtures/triage-real.ts): what it is is stage A `what`, the
    // cause is stage B `summary`.
    const triage = triageReal().report.triage!
    triage.stage_a!.what = 'The boss script stops on the bridge.'
    Object.assign(triage.stage_b!, { summary: 'A nil target after the wave ends.', duplicate_of: B })
    serve(
      () => ({ reports: [row(A, 0)], nextCursor: null }),
      () => ({
        ...d,
        report: { ...d.report, verdict: 'duplicate', duplicate_of: B, pr_url: PR, triage },
      }),
    )
    open()
    await screen.findByText('The boss script stops on the bridge.', { exact: false })
    expect(screen.getByText('A nil target after the wave ends.', { exact: false })).toBeTruthy()
    expect(screen.queryByText('The AI has not looked at this report yet.')).toBeNull()
    expect(screen.getByRole('link', { name: 'Open PR #12' }).getAttribute('href')).toBe(PR)
    await waitFor(() => expect(rowOf(A).textContent).toContain(`of ${B}`))
  })

  it('fields, detail client: every column is renamed, null becomes absent, and a 0 stays 0', async () => {
    const d = detail(A, [])
    serve(
      () => null,
      () => ({
        ...d,
        report: {
          ...d.report,
          title: 'T',
          where_area: 'lobby',
          device: 'tablet',
          lang: 'it',
          roblox_name: 'kev',
          roblox_user_id: 0,
          discord_name: 'kev#1',
          game_context: { wave: 3 },
          verdict: 'needs_person',
          triage: { summary: 'S' },
          duplicate_of: B,
          pr_url: PR,
        },
      }),
    )
    expect(await deskReport(A)).toMatchObject({
      code: A,
      title: 'T',
      whereArea: 'lobby',
      device: 'tablet',
      lang: 'it',
      robloxName: 'kev',
      robloxUserId: 0,
      discordName: 'kev#1',
      gameContext: { wave: 3 },
      verdict: 'needs_person',
      triage: { summary: 'S' },
      duplicateOf: B,
      prUrl: PR,
    })
    serve(
      () => null,
      () => d,
    )
    const empty = await deskReport(A)
    for (const k of ['title', 'whereArea', 'device', 'lang', 'robloxName', 'robloxUserId', 'discordName', 'gameContext', 'verdict', 'triage', 'duplicateOf', 'prUrl'] as const) {
      expect(k in empty ? empty[k] : undefined).toBeUndefined()
    }
  })

  it('fields, detail edge: a triage stored as text that is not JSON is "not looked at yet", never shown as data', async () => {
    const d = detail(A, [])
    serve(
      () => ({ reports: [row(A, 0)], nextCursor: null }),
      () => ({ ...d, report: { ...d.report, triage: 'not json {' } }),
    )
    open()
    await screen.findByText('The AI has not looked at this report yet.')
  })
})
