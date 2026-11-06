import { API_BASE } from '../config'
import type {
  ApiErrorBody,
  AttachSessionBody,
  AttachSessionRes,
  CreateAttachmentBody,
  CreateAttachmentRes,
  CreateReportBody,
  CreateReportRes,
  DeskAttachment,
  DeskAttachmentWire,
  DeskFilter,
  DeskListRes,
  DeskListRowWire,
  DeskListWire,
  DeskReport,
  DeskReportRow,
  DeskReportWire,
  DeskStatusBody,
  DeskTriage,
  ListPartsRes,
  PutPartRes,
  StatusRes,
} from './types'

// `code` is a machine word for the pages to map to their own strings; it never carries server or browser prose,
// so nothing raw can reach the player.
export class ApiError extends Error {
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

type Req = { method?: string; json?: unknown; raw?: Blob; token?: string; desk?: boolean; signal?: AbortSignal }

const CODE_WORD = /^[a-z0-9_]{1,64}$/

// Two failures told apart: a body that never fully arrived (the connection dropped after the headers) is the
// network, retried like any other; a body that arrived and is not JSON (a proxy page) is null for the caller to judge.
async function readBody(res: Response): Promise<unknown> {
  let text: string
  try {
    text = await res.text()
  } catch {
    throw new ApiError(0, 'network')
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function errorCode(res: Response, body: unknown): string {
  const word = (body as Partial<ApiErrorBody> | null)?.error
  return typeof word === 'string' && CODE_WORD.test(word) ? word : `http_${res.status}`
}

async function send(path: string, req: Req): Promise<Response> {
  const headers: Record<string, string> = {}
  let body: BodyInit | undefined
  if (req.raw) {
    body = req.raw
    headers['Content-Type'] = 'application/octet-stream'
  } else if (req.json !== undefined) {
    body = JSON.stringify(req.json)
    headers['Content-Type'] = 'application/json'
  }
  if (req.token) headers['X-Report-Token'] = req.token
  try {
    return await fetch(API_BASE + path, {
      method: req.method ?? 'GET',
      headers,
      body,
      signal: req.signal,
      // Public calls carry no cookies at all; the desk needs the Cloudflare Access cookie of its own origin.
      credentials: req.desk ? 'include' : 'omit',
    })
  } catch {
    // Offline, DNS, CORS, abort: the browser's reason is not something a player can act on.
    throw new ApiError(0, 'network')
  }
}

async function call<T>(path: string, req: Req = {}): Promise<T> {
  const res = await send(path, req)
  const body = await readBody(res)
  if (!res.ok) throw new ApiError(res.status, errorCode(res, body))
  // A 2xx without the JSON we expect (a proxy page, a cut body) is a failure, not an empty success.
  if (body === null || typeof body !== 'object') throw new ApiError(res.status, `http_${res.status}`)
  return body as T
}

async function callVoid(path: string, req: Req): Promise<void> {
  const res = await send(path, req)
  if (!res.ok) throw new ApiError(res.status, errorCode(res, await readBody(res)))
}

const seg = encodeURIComponent

export function createReport(body: CreateReportBody): Promise<CreateReportRes> {
  return call('/reports', { method: 'POST', json: body })
}

export function attachSession(code: string, turnstileToken: string): Promise<AttachSessionRes> {
  const json: AttachSessionBody = { turnstileToken }
  return call(`/reports/${seg(code)}/attach-session`, { method: 'POST', json })
}

export function createAttachment(
  code: string,
  token: string,
  body: CreateAttachmentBody,
  signal?: AbortSignal,
): Promise<CreateAttachmentRes> {
  return call(`/reports/${seg(code)}/attachments`, { method: 'POST', json: body, token, signal })
}

export function putPart(id: string, n: number, token: string, data: Blob, signal?: AbortSignal): Promise<PutPartRes> {
  return call(`/attachments/${seg(id)}/parts/${n}`, { method: 'PUT', raw: data, token, signal })
}

export function listParts(id: string, token: string, signal?: AbortSignal): Promise<ListPartsRes> {
  return call(`/attachments/${seg(id)}/parts`, { token, signal })
}

// 409 missing_parts is an answer the uploader acts on, not a failure. `missing` is [] when the server gave no list
// (the contract does not fix the field name), so the caller knows to ask listParts instead.
export async function completeAttachment(
  id: string,
  token: string,
  signal?: AbortSignal,
): Promise<{ ok: true; missing?: number[] }> {
  const res = await send(`/attachments/${seg(id)}/complete`, { method: 'POST', token, signal })
  const body = await readBody(res)
  if (res.ok) {
    // Only the contract's `{ ok: true }` closes the upload. Anything else is treated as a bad gateway (502): the
    // uploader retries it and the session keeps the file, instead of a file marked done that the server never closed.
    if ((body as { ok?: unknown } | null)?.ok !== true) throw new ApiError(502, 'bad_answer')
    return { ok: true }
  }
  const code = errorCode(res, body)
  if (res.status !== 409 || code !== 'missing_parts') throw new ApiError(res.status, code)
  const list = (body as Partial<ApiErrorBody>).missing
  return { ok: true, missing: Array.isArray(list) ? list.filter((n) => Number.isInteger(n)) : [] }
}

export function deleteAttachment(id: string, token: string): Promise<void> {
  return callVoid(`/attachments/${seg(id)}`, { method: 'DELETE', token })
}

export function getStatus(code: string): Promise<StatusRes> {
  return call(`/status/${seg(code)}`)
}

// The worker sends null for an empty column; the pages read "not set" as absent. A 0 or '' passes unchanged.
const opt = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v)

// Only a JSON object is read as data: the worker answers a stored text that does not parse as that text.
const asObject = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

// A 2xx without the worker's envelope (a proxy page that happens to be JSON) is a bad gateway, never an empty desk.
const badAnswer = () => new ApiError(502, 'bad_answer')

const deskRow = (w: DeskListRowWire): DeskReportRow => ({
  code: w.code,
  createdAt: w.created_at,
  updatedAt: w.updated_at,
  source: w.source,
  status: w.status,
  title: opt(w.title),
  what: w.what,
  whereArea: opt(w.where_area),
  device: opt(w.device),
  verdict: opt(w.verdict),
  fileCount: w.attachment_count,
})

const deskAttachment = (a: DeskAttachmentWire): DeskAttachment => ({
  id: a.id,
  kind: a.kind,
  filename: a.filename,
  mime: a.mime,
  sizeBytes: a.size_bytes,
  status: a.status,
})

export async function deskList(filter: DeskFilter, cursor?: string): Promise<DeskListRes> {
  const q = new URLSearchParams({ filter })
  if (cursor) q.set('cursor', cursor)
  const w = await call<DeskListWire>(`/desk/reports?${q}`, { desk: true })
  if (!Array.isArray(w.reports)) throw badAnswer()
  return { reports: w.reports.map(deskRow), cursor: opt(w.nextCursor) }
}

export async function deskReport(code: string): Promise<DeskReport> {
  const w = await call<DeskReportWire>(`/desk/reports/${seg(code)}`, { desk: true })
  const r = w.report
  if (!asObject(r) || !Array.isArray(w.attachments) || !Array.isArray(w.duplicates)) throw badAnswer()
  // The worker lists the agent's frames among the attachments; the page shows them apart from the player's files.
  const all = w.attachments.map(deskAttachment)
  return {
    code: r.code,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    source: r.source,
    status: r.status,
    title: opt(r.title),
    what: r.what,
    whereArea: opt(r.where_area),
    device: opt(r.device),
    verdict: opt(r.verdict),
    prUrl: opt(r.pr_url),
    duplicateOf: opt(r.duplicate_of),
    lang: opt(r.lang),
    robloxName: opt(r.roblox_name),
    robloxUserId: opt(r.roblox_user_id),
    discordName: opt(r.discord_name),
    gameContext: asObject(r.game_context),
    triage: asObject(r.triage) as DeskTriage | undefined,
    attachments: all.filter((a) => a.kind !== 'frames'),
    frames: all.filter((a) => a.kind === 'frames'),
    duplicates: w.duplicates,
  }
}

export function deskSetStatus(code: string, body: DeskStatusBody): Promise<void> {
  return callVoid(`/desk/reports/${seg(code)}/status`, { method: 'POST', json: body, desk: true })
}

// Used as a <video src>: the browser sends the Access cookie itself and handles Range requests.
export function deskStreamUrl(id: string): string {
  return `${API_BASE}/desk/attachments/${seg(id)}/stream`
}
