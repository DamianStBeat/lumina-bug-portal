// src/api/client.ts against CONTRACT.md "HTTP API" (public part): the report token header, no cookies on public
// calls (brief: "no cookies"), 409 missing_parts as an answer with its list, errors as snake_case words only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  attachSession,
  completeAttachment,
  createAttachment,
  createReport,
  deleteAttachment,
  getStatus,
  listParts,
  putPart,
} from '../src/api/client'
import { FakeServer, MiB, SparseBlob } from './helpers'

const CODE = 'LUM-482193'
let server: FakeServer
beforeEach(() => {
  server = new FakeServer().install()
})
afterEach(() => vi.unstubAllGlobals())

function answer(status: number, body: string, type = 'application/json') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status, headers: { 'Content-Type': type } })))
}

describe('contract rule: upload calls carry X-Report-Token, public calls carry no cookies', () => {
  it('token and credentials: every public call omits credentials, every attachment call sends the token', async () => {
    const { code, reportToken } = await createReport({ what: 'The boss stopped.', turnstileToken: 'tt' })
    const { reportToken: second } = await attachSession(code, 'tt')
    const a = await createAttachment(code, second, { filename: 'a.mp4', size: 2 * MiB, mime: 'video/mp4' })
    await putPart(a.attachmentId, 1, second, new SparseBlob(2 * MiB) as unknown as Blob)
    await listParts(a.attachmentId, second)
    await completeAttachment(a.attachmentId, second)
    await getStatus(code)
    const b = await createAttachment(code, reportToken, { filename: 'b.mp4', size: MiB, mime: 'video/mp4' })
    await deleteAttachment(b.attachmentId, reportToken)

    expect(server.log.length).toBe(9)
    for (const r of server.log) {
      expect(r.reached).toBe(true)
      expect(r.credentials).toBe('omit')
    }
    const withToken = server.log.filter((r) => r.path.includes('/attachments'))
    expect(withToken).toHaveLength(6)
    for (const r of withToken) expect(r.token === second || r.token === reportToken).toBe(true)
    expect(server.atts.get(a.attachmentId)?.status).toBe('complete')
    expect(server.atts.get(b.attachmentId)?.status).toBe('aborted')
  })
})

describe('contract rule: 409 missing_parts comes with the list', () => {
  it('missing_parts: complete answers the list instead of throwing', async () => {
    const token = server.addReport(CODE)
    const a = await createAttachment(CODE, token, { filename: 'a.mp4', size: 3 * 16777216, mime: 'video/mp4' })
    const r = await completeAttachment(a.attachmentId, token)
    expect(r.missing).toEqual([1, 2, 3])
  })

  it('missing_parts: another 409 (not_uploading) is an error with that word', async () => {
    answer(409, JSON.stringify({ error: 'not_uploading' }))
    const err = await completeAttachment('att-1', 'tok').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(409)
    expect((err as ApiError).code).toBe('not_uploading')
  })

  it('missing_parts: a 200 complete has no missing list', async () => {
    answer(200, JSON.stringify({ ok: true }))
    const r = await completeAttachment('att-1', 'tok')
    expect(r.missing).toBeUndefined()
  })
})

describe('contract rule: errors are { error: "<snake_case>" }, never raw text for the player', () => {
  it('errors: a 404 not_found on status is an ApiError 404 not_found', async () => {
    const err = await getStatus('LUM-000000').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(404)
    expect((err as ApiError).code).toBe('not_found')
  })

  it('errors: no network is an ApiError with status 0, not a TypeError', async () => {
    server.offline = true
    const err = await getStatus(CODE).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(0)
  })

  it('errors: a 500 carrying prose does not pass the prose on', async () => {
    const prose = 'TypeError: cannot read properties of undefined at worker.js:12'
    answer(500, JSON.stringify({ error: prose }))
    const err = await getStatus(CODE).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(500)
    expect((err as ApiError).code).not.toContain('TypeError')
    expect((err as ApiError).message).not.toContain('worker.js')
  })

  it('errors: a 200 that is not JSON (a proxy page) is a failure, not an empty success', async () => {
    answer(200, '<html>captive portal</html>', 'text/html')
    await expect(getStatus(CODE)).rejects.toBeInstanceOf(ApiError)
  })
})
