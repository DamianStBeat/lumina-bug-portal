// Decided behaviour B3 (lead, final critical round) on the desk detail (jsdom): a video or picture still `uploading`
// shows "Still uploading.", never "No video or picture."; "not yet" (still arriving, still loading) is not "none".
// The desk reads GET /api/v1/desk/reports/{code}; here fetch answers it with the report of each case.
import { cleanup, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentKind, AttachmentStatus, DeskAttachment, DeskReport } from '../src/api/types'
import { ReportDetail } from '../src/pages/desk/ReportDetail'

const CODE = 'LUM-482193'
// The desk is English only; these are the two lines B3 names.
const STILL = 'Still uploading.'
const NONE = 'No video or picture.'

afterEach(() => cleanup())

function att(kind: AttachmentKind, status: AttachmentStatus, id = 'att-1'): DeskAttachment {
  const mime = kind === 'image' ? 'image/png' : 'video/mp4'
  return { id, kind, filename: kind === 'image' ? 'shot.png' : 'clip.mp4', mime, sizeBytes: 300_000_000, status }
}

function report(attachments: DeskAttachment[]): DeskReport {
  return {
    code: CODE,
    createdAt: 1_762_400_000_000,
    updatedAt: 1_762_400_000_000,
    source: 'web',
    status: 'received',
    what: 'The boss stopped on the bridge.',
    attachments,
    frames: [],
    duplicates: [],
  }
}

// Answers the desk detail of CODE with `r`, or never answers when `r` is null.
function serve(r: DeskReport | null) {
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
