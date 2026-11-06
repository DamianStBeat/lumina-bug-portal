// Decided behaviour B3 (lead, final critical round) on the desk detail (jsdom): a video or picture still `uploading`
// shows "Still uploading.", never "No video or picture."; "not yet" (still arriving, still loading) is not "none".
// The desk reads GET /api/v1/desk/reports/{code}; here fetch answers it, in the worker's shape on main
// (worker/src/routes/desk.ts getReport), with the report of each case.
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentKind, AttachmentStatus, DeskAttachmentWire, DeskReportWire } from '../src/api/types'
import { ReportDetail } from '../src/pages/desk/ReportDetail'

const CODE = 'LUM-482193'
// The desk is English only; these are the two lines B3 names.
const STILL = 'Still uploading.'
const NONE = 'No video or picture.'

afterEach(() => cleanup())

const AT = 1_762_400_000_000

function att(kind: AttachmentKind, status: AttachmentStatus, id = 'att-1'): DeskAttachmentWire {
  const mime = kind === 'image' ? 'image/png' : 'video/mp4'
  const filename = kind === 'image' ? 'shot.png' : 'clip.mp4'
  const completed_at = status === 'complete' ? AT : null
  return { id, kind, filename, mime, size_bytes: 300_000_000, status, created_at: AT, completed_at }
}

function report(attachments: DeskAttachmentWire[]): DeskReportWire {
  return {
    report: {
      code: CODE,
      created_at: AT,
      updated_at: AT,
      source: 'web',
      status: 'received',
      title: null,
      what: 'The boss stopped on the bridge.',
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

// Answers the desk detail of CODE with `r`, or never answers when `r` is null.
function serve(r: DeskReportWire | null) {
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
const open = () => render(createElement(ReportDetail, { code: CODE, onDenied, onChanged }))

describe('decided B3: the desk says a file is still arriving, never that there is none', () => {
  it('B3: a video still uploading shows "Still uploading.", not "No video or picture."', async () => {
    serve(report([att('video', 'uploading')]))
    open()
    await screen.findByText(STILL)
    expect(screen.queryByText(NONE)).toBeNull()
  })

  it('B3: a picture still uploading shows "Still uploading." too', async () => {
    serve(report([att('image', 'uploading')]))
    open()
    await screen.findByText(STILL)
    expect(screen.queryByText(NONE)).toBeNull()
  })

  it('B3: one upload aborted and one still uploading is still uploading', async () => {
    serve(report([att('video', 'aborted', 'att-1'), att('video', 'uploading', 'att-2')]))
    open()
    await screen.findByText(STILL)
    expect(screen.queryByText(NONE)).toBeNull()
  })

  it('B3 edge: a report with no attachment at all says "No video or picture.", not still uploading', async () => {
    serve(report([]))
    open()
    await screen.findByText(NONE)
    expect(screen.queryByText(STILL)).toBeNull()
  })

  it('B3 edge: only an aborted upload says "No video or picture."', async () => {
    serve(report([att('video', 'aborted')]))
    open()
    await screen.findByText(NONE)
    expect(screen.queryByText(STILL)).toBeNull()
  })

  it('B3 edge: a complete video plays; neither line shows', async () => {
    serve(report([att('video', 'complete', 'att-2')]))
    open()
    await screen.findByText(CODE)
    const video = document.querySelector('video')
    expect(video?.getAttribute('src')).toContain('/desk/attachments/att-2/stream')
    expect(screen.queryByText(NONE)).toBeNull()
    expect(screen.queryByText(STILL)).toBeNull()
  })

  it('B3 not yet: while the report loads, neither line shows', async () => {
    const fetch = serve(null)
    open()
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(screen.queryByText(NONE)).toBeNull()
    expect(screen.queryByText(STILL)).toBeNull()
    expect(screen.queryByText(CODE)).toBeNull()
  })
})
