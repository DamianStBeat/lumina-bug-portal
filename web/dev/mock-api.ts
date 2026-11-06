// Dev-only stand-in for the worker API of CONTRACT.md "HTTP API", so the site, the desk and the screenshots run
// without Cloudflare. `apply: 'serve'` keeps it out of `vite build`: nothing here may reach `dist/`.
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import type { Plugin } from 'vite'
import type {
  AttachmentKind, CreateAttachmentRes, CreateReportRes, DeskAttachment, DeskAttachmentWire, DeskFilter,
  DeskListRowWire, DeskListWire, DeskReport, DeskReportWire, DeskStageA, DeskStageB, DeskTriage, ListPartsRes,
  PublicStatus, ReportStatus, StatusRes,
} from '../src/api/types.ts'

const PART_SIZE = 16777216
const MAX_FILE = 2 * 1024 * 1024 * 1024
const MAX_FILES = 3
const PART_CAP = PART_SIZE + 1024
const JSON_CAP = 64 * 1024
const PAGE = 50
const MIN = 60_000
// "312 MB" in the preview is read as SI megabytes; the desk formats them back.
const MB = 1_000_000
const FIRST_CODE = 482301

const WHERE = ['match', 'lobby', 'shop', 'crates', 'clan', 'other'] as const
const DEVICES = ['phone', 'tablet', 'computer', 'console'] as const
const STATUSES: readonly ReportStatus[] = ['received', 'looking', 'fixed', 'duplicate', 'not_bug', 'closed']
const FILTERS: readonly DeskFilter[] = ['all', 'fix_ready', 'needs_person', 'duplicate', 'not_bug', 'waiting']
// The worker's limits on a desk status change (worker/src/lib/validate.ts prUrl, lib/status.ts depth).
const PR_URL = /^https:\/\/github\.com\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}\/pull\/[1-9]\d{0,9}$/
const MAX_DUPLICATE_DEPTH = 10

type Report = Omit<DeskReport, 'attachments' | 'frames' | 'duplicates'>
type Rec = {
  report: Report
  // Seeded rows keep their age ("4 min ago") however long the server runs, until something changes them.
  seedAgeMs?: number
  tokens: Set<string>
}
type Att = DeskAttachment & { code: string; partCount: number; parts: Map<number, number> }
type Faults = { failParts: number; offline: boolean; slowMs: number }

// Per attachment and part number: PUTs that reached the server, and the ones it answered 200. Read by dev/shots.mjs
// to prove that a retry or a resume does not send confirmed parts again.
type Puts = Map<string, Map<number, { got: number; ok: number }>>
type State = {
  reports: Map<string, Rec>; atts: Map<string, Att>; nextCode: number; nextAtt: number; faults: Faults; puts: Puts
}
type SeedFile = [kind: AttachmentKind, filename: string, mime: string, sizeBytes: number]
type Seed = [ageMin: number, report: Omit<Report, 'createdAt' | 'updatedAt' | 'source'>, files: SeedFile[]]
const TOP = 'LUM-482193'
// A triage in the shape the agent posts it (agent/lumina_bug_agent/run.py post_triage): both stages answered.
function triage(a: Pick<DeskStageA, 'what' | 'where' | 'device'>, b: Omit<DeskStageB, 'confidence'>): DeskTriage {
  const stageA: DeskStageA = {
    ...a, when_in_video: null, steps: [], expected: null, actual: null, language: 'en', injection_suspected: false,
  }
  return { stage_a: stageA, stage_b: { ...b, confidence: 0.86 }, files: [], notes: [], agent: 'lumina-bug-agent/1' }
}
// The five rows of the preview's desk screen, same texts, areas, devices, verdicts and sizes.
const SEEDS: Seed[] = [
  [4, {
    code: TOP, status: 'looking', what: 'The boss stopped on the bridge and the wave never ended.', whereArea: 'match',
    device: 'phone', lang: 'en', verdict: 'simple_fix', prUrl: 'https://github.com/DamianStBeat/Lumina2/pull/1402',
    triage: triage({ what: 'on the Bridge map the boss waits at the last waypoint', where: 'match', device: 'phone' }, {
      verdict: 'simple_fix', summary: 'BossPath expects 9 waypoints; the Bridge path has 8.',
      likely_files: [{ path: 'src/server/Waves/BossPath.luau', line: 212, why: 'reads waypoint 9' }],
      risk_paths: [], duplicate_of: null, fix_size: 'small',
    }),
  }, [['video', 'boss-bridge.mp4', 'video/mp4', 312 * MB],
    ...[1, 2, 3, 4, 5, 6].map((n): SeedFile => ['frames', `frame-${n}.jpg`, 'image/jpeg', 149496])]],
  [11, {
    code: 'LUM-482093', status: 'looking', what: 'my crate gave me nothing after the spin', whereArea: 'crates',
    device: 'computer', verdict: 'needs_person',
    triage: triage({ what: 'a crate spin gives no item', where: 'crates', device: 'computer' }, {
      verdict: 'needs_person', summary: 'The crate reward is granted after the spin ends.',
      likely_files: [{ path: 'src/server/Crates/Spin.luau', line: null, why: 'grants the reward' }],
      risk_paths: ['src/server/Inventory/Grant.luau'], duplicate_of: null, fix_size: 'medium',
    }),
  }, [['video', 'crate-spin.mp4', 'video/mp4', 88 * MB]]],
  [18, {
    code: 'LUM-481993', status: 'duplicate', what: 'boss stuck on bridge again!!', whereArea: 'match', device: 'tablet',
    verdict: 'duplicate', duplicateOf: TOP,
    triage: triage({ what: 'the boss stops on the Bridge map', where: 'match', device: 'tablet' }, {
      verdict: 'duplicate', summary: 'The same stop at the last waypoint as LUM-482193.', likely_files: [],
      risk_paths: [], duplicate_of: TOP, fix_size: 'unknown',
    }),
  }, [['video', 'boss-stuck.mp4', 'video/mp4', 540 * MB]]],
  [32, { code: 'LUM-481893', status: 'not_bug', what: 'i want more gems pls', whereArea: 'shop', verdict: 'not_bug' },
    []],
  [40, {
    code: 'LUM-481793', status: 'received', what: 'clan chat buttons overlap on my phone', whereArea: 'clan',
    device: 'phone',
  }, [['image', 'clan-chat.png', 'image/png', 3 * MB]]],
]

function fresh(): State {
  const reports = new Map<string, Rec>()
  const atts = new Map<string, Att>()
  let i = 0
  for (const [ageMin, report, files] of SEEDS) {
    const full: Report = { ...report, source: 'web', createdAt: 0, updatedAt: 0 }
    reports.set(report.code, { report: full, seedAgeMs: ageMin * MIN, tokens: new Set() })
    for (const [kind, filename, mime, sizeBytes] of files) {
      const id = `att-seed-${++i}`
      const partCount = Math.ceil(sizeBytes / PART_SIZE)
      const parts = new Map<number, number>()
      atts.set(id, { id, code: report.code, kind, filename, mime, sizeBytes, status: 'complete', partCount, parts })
    }
  }
  const faults = { failParts: 0, offline: false, slowMs: 0 }
  return { reports, atts, nextCode: FIRST_CODE, nextAtt: 1, faults, puts: new Map() }
}
let state: State = fresh()
// A real clip for the video attachments, sent by dev/shots.mjs (POST /__mock/video) so row 10 can prove playback.
// Outside `state`: /__mock/reset between rows keeps it.
let clip: Buffer | null = null
const CLIP_CAP = 4 * 1024 * 1024

function times(rec: Rec): { createdAt: number; updatedAt: number } {
  if (rec.seedAgeMs === undefined) return { createdAt: rec.report.createdAt, updatedAt: rec.report.updatedAt }
  const t = Date.now() - rec.seedAgeMs
  return { createdAt: t, updatedAt: t }
}

// A change freezes a seeded row's clock, so updatedAt moves forward and stays after createdAt.
function touch(rec: Rec): void {
  rec.report.createdAt = times(rec).createdAt
  rec.seedAgeMs = undefined
  rec.report.updatedAt = Date.now()
}

const fileAtts = (code: string) =>
  [...state.atts.values()].filter((a) => a.code === code && (a.kind === 'video' || a.kind === 'image'))
const liveFiles = (code: string) => fileAtts(code).filter((a) => a.status === 'uploading' || a.status === 'complete')

// The desk answers below are the worker's shapes (worker/src/routes/desk.ts on main): D1 columns, null when empty.
function row(rec: Rec): DeskListRowWire {
  const r = rec.report
  const t = times(rec)
  // Listed field by field: the list row carries no detail-only field (lang, names, triage, PR link, link target).
  return {
    code: r.code, created_at: t.createdAt, updated_at: t.updatedAt, source: r.source, status: r.status,
    verdict: r.verdict ?? null, title: r.title ?? null, what: r.what.slice(0, 200), where_area: r.whereArea ?? null,
    device: r.device ?? null, attachment_count: fileAtts(r.code).filter((a) => a.status !== 'aborted').length,
  }
}

function detail(rec: Rec): DeskReportWire {
  const r = rec.report
  const t = times(rec)
  // The mock keeps no clock per file: the report's stands in (the desk reads neither time).
  const wire = ({ id, kind, filename, mime, sizeBytes, status }: Att): DeskAttachmentWire => ({
    id, kind, filename, mime, size_bytes: sizeBytes, status, created_at: t.createdAt,
    completed_at: status === 'complete' ? t.updatedAt : null,
  })
  return {
    report: {
      code: r.code, created_at: t.createdAt, updated_at: t.updatedAt, source: r.source, status: r.status,
      title: r.title ?? null, what: r.what, where_area: r.whereArea ?? null, device: r.device ?? null,
      lang: r.lang ?? null, roblox_name: r.robloxName ?? null, roblox_user_id: r.robloxUserId ?? null,
      discord_name: r.discordName ?? null, game_context: r.gameContext ?? null, verdict: r.verdict ?? null,
      triage: r.triage ?? null, duplicate_of: r.duplicateOf ?? null, pr_url: r.prUrl ?? null,
    },
    // Frames among the attachments, in creation order, as the worker lists them.
    attachments: [...state.atts.values()].filter((a) => a.code === r.code).map(wire),
    duplicates: [...state.reports.values()].filter((d) => d.report.duplicateOf === r.code).map((d) => d.report.code),
  }
}

// The worker's tabs (desk.ts FILTERS): a person's status wins over the verdict, and fix_ready needs the PR.
const MATCH: Record<DeskFilter, (r: Report) => boolean> = {
  all: () => true,
  fix_ready: (r) => r.verdict === 'simple_fix' && !!r.prUrl && r.status === 'looking',
  needs_person: (r) => r.verdict === 'needs_person' && r.status === 'looking',
  duplicate: (r) => r.status === 'duplicate',
  not_bug: (r) => r.status === 'not_bug',
  waiting: (r) => r.status === 'received',
}

const PUBLIC: Partial<Record<ReportStatus, PublicStatus>> = {
  received: 'received', looking: 'looking', fixed: 'fixed', not_bug: 'checked', closed: 'checked',
}

// As worker/src/lib/status.ts: a duplicate answers its original's status and the latest updatedAt along the chain; a
// missing original, a loop or a chain too deep shows `checked`.
function publicStatus(rec: Rec): { status: PublicStatus; updatedAt: number } {
  let r = rec.report
  let updatedAt = times(rec).updatedAt
  for (let depth = 0; r.status === 'duplicate'; depth++) {
    const next = r.duplicateOf ? state.reports.get(r.duplicateOf) : undefined
    if (!next || depth >= MAX_DUPLICATE_DEPTH) return { status: 'checked', updatedAt }
    r = next.report
    updatedAt = Math.max(updatedAt, times(next).updatedAt)
  }
  return { status: PUBLIC[r.status] ?? 'looking', updatedAt }
}

// The original a manual `duplicate` links to (worker lib/duplicates.ts): the target's root, never the report itself.
function rootOf(code: string, target: unknown): string {
  if (typeof target !== 'string' || !/^LUM-\d{6}$/.test(target) || target === code) fail(400, 'invalid_duplicate_of')
  const seen = new Set([code, target as string])
  let at = state.reports.get(target as string) ?? fail(400, 'invalid_duplicate_of')
  for (let depth = 1; at.report.status === 'duplicate' && at.report.duplicateOf && depth < MAX_DUPLICATE_DEPTH; depth++) {
    const next = state.reports.get(at.report.duplicateOf)
    if (!next) break
    if (seen.has(next.report.code)) fail(409, 'duplicate_cycle')
    seen.add(next.report.code)
    at = next
  }
  return at.report.code
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code) }
}

// Reads at most `cap` bytes; above it the rest is drained unread so the client gets its 413 instead of a reset.
function readBody(req: IncomingMessage, cap: number, keep: boolean): Promise<{ bytes: Buffer[]; length: number }> {
  return new Promise((resolve, reject) => {
    const bytes: Buffer[] = []
    let length = 0
    req.on('data', (chunk: Buffer) => {
      length += chunk.length
      if (keep && length <= cap) bytes.push(chunk)
    })
    req.on('end', () => (length > cap ? reject(new HttpError(413, 'payload_too_large')) : resolve({ bytes, length })))
    req.on('error', reject)
  })
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const { bytes } = await readBody(req, JSON_CAP, true)
  let v: unknown
  try {
    v = JSON.parse(Buffer.concat(bytes).toString('utf8') || '{}')
  } catch {
    v = null
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new HttpError(400, 'bad_json')
  return v as Record<string, unknown>
}

const JSON_HEADERS = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }
const send = (res: ServerResponse, status: number, body: unknown) =>
  void res.writeHead(status, JSON_HEADERS).end(JSON.stringify(body))

const optStr = (v: unknown, max: number): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string' || v.length > max) throw new HttpError(400, 'bad_request')
  return v
}
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T | undefined => {
  if (v === undefined || v === null || v === '') return undefined
  if (!list.includes(v as T)) throw new HttpError(400, 'bad_request')
  return v as T
}
const token = () => randomBytes(32).toString('base64url')

const fail = (status: number, code: string): never => {
  throw new HttpError(status, code)
}
const needReport = (code: string): Rec => state.reports.get(code) ?? fail(404, 'not_found')
function needAtt(req: IncomingMessage, id: string): Att {
  const att = state.atts.get(id)
  if (!att || att.kind === 'frames') throw new HttpError(404, 'not_found')
  const t = req.headers['x-report-token']
  if (typeof t !== 'string' || !state.reports.get(att.code)?.tokens.has(t)) throw new HttpError(401, 'bad_token')
  return att
}

async function stream(req: IncomingMessage, res: ServerResponse, att: Att, jpg: string): Promise<void> {
  // Videos get the clip shots.mjs sent, else a few KB of zeros (enough for Range, not for playback).
  const isVideo = att.kind === 'video'
  const data = isVideo ? (clip ?? Buffer.alloc(8192)) : await readFile(jpg)
  const total = data.length
  res.setHeader('Content-Type', isVideo ? 'video/mp4' : 'image/jpeg')
  res.setHeader('Accept-Ranges', 'bytes')
  const range = req.headers.range
  if (!range) return void res.setHeader('Content-Length', String(total)).end(data)
  const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
  // "bytes=-N" is the last N bytes; "bytes=N-" runs to the end.
  const suffix = m && !m[1] && m[2] ? Number(m[2]) : NaN
  const start = Number.isNaN(suffix) ? (m && m[1] ? Number(m[1]) : NaN) : Math.max(0, total - suffix)
  const end = Math.min(m && m[1] && m[2] ? Number(m[2]) : total - 1, total - 1)
  if (!Number.isInteger(start) || start >= total || end < start) {
    res.statusCode = 416
    return void res.setHeader('Content-Range', `bytes */${total}`).end()
  }
  res.statusCode = 206
  res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`)
  res.setHeader('Content-Length', String(end - start + 1))
  res.end(data.subarray(start, end + 1))
}

async function api(req: IncomingMessage, res: ServerResponse, url: URL, jpg: string): Promise<void> {
  const p = url.pathname.slice('/api/v1'.length)
  const method = req.method ?? 'GET'
  const at = (re: RegExp, verb: string) => (method === verb ? re.exec(p) : null)
  let m: RegExpExecArray | null

  if (state.faults.offline) throw new HttpError(503, 'unavailable')

  if (at(/^\/reports$/, 'POST')) {
    const b = await readJson(req)
    const what = typeof b.what === 'string' ? b.what.replace(/[^\P{Cc}\n\t]/gu, '').trim() : ''
    if (what.length < 1 || what.length > 2000) throw new HttpError(400, 'bad_request')
    if (typeof b.turnstileToken !== 'string' || !b.turnstileToken) throw new HttpError(403, 'turnstile_failed')
    const now = Date.now()
    const code = `LUM-${state.nextCode++}`
    const reportToken = token()
    const report: Report = {
      code, createdAt: now, updatedAt: now, source: 'web', status: 'received', what,
      whereArea: oneOf(b.where, WHERE), device: oneOf(b.device, DEVICES),
      robloxName: optStr(b.robloxName, 20), lang: optStr(b.lang, 10),
    }
    state.reports.set(code, { report, tokens: new Set([reportToken]) })
    return send(res, 201, { code, reportToken } satisfies CreateReportRes)
  }
  if ((m = at(/^\/reports\/(LUM-\d{6})\/attach-session$/, 'POST'))) {
    const rec = needReport(m[1]!)
    const b = await readJson(req)
    if (typeof b.turnstileToken !== 'string' || !b.turnstileToken) throw new HttpError(403, 'turnstile_failed')
    const reportToken = token()
    rec.tokens.add(reportToken)
    return send(res, 200, { reportToken })
  }
  if ((m = at(/^\/reports\/(LUM-\d{6})\/attachments$/, 'POST'))) {
    const rec = needReport(m[1]!)
    const t = req.headers['x-report-token']
    if (typeof t !== 'string' || !rec.tokens.has(t)) throw new HttpError(401, 'bad_token')
    const b = await readJson(req)
    const { filename, size, mime } = b
    const ok = typeof filename === 'string' && filename.trim() && typeof mime === 'string'
    if (!ok || typeof size !== 'number' || !Number.isInteger(size) || size < 1) throw new HttpError(400, 'bad_request')
    // Same word as the worker slice, so the client sees one name for this refusal in dev and in production.
    if (!/^(video|image)\//.test(mime)) throw new HttpError(400, 'invalid_mime')
    // 2 GiB is exactly 128 parts of 16 MiB, so the size cap is also the parts cap.
    if (size > MAX_FILE) throw new HttpError(400, 'file_too_large')
    if (liveFiles(rec.report.code).length >= MAX_FILES) throw new HttpError(400, 'too_many_files')
    const id = `att-${state.nextAtt++}`
    const partCount = Math.ceil(size / PART_SIZE)
    const kind: AttachmentKind = mime.startsWith('video/') ? 'video' : 'image'
    const safeName = filename.replace(/[^\w.\- ]/g, '_').slice(0, 120)
    const code = rec.report.code
    const parts = new Map<number, number>()
    state.atts.set(id, { id, code, kind, filename: safeName, mime, sizeBytes: size, status: 'uploading', partCount, parts })
    touch(rec)
    return send(res, 201, { attachmentId: id, partSize: PART_SIZE, partCount } satisfies CreateAttachmentRes)
  }
  if ((m = at(/^\/attachments\/([\w-]+)\/parts\/(\d+)$/, 'PUT'))) {
    const att = needAtt(req, m[1]!)
    const n = Number(m[2])
    // Counted on arrival, before the body: a part cut by a reload was still sent once.
    const byPart = state.puts.get(att.id) ?? new Map<number, { got: number; ok: number }>()
    state.puts.set(att.id, byPart)
    const count = byPart.get(n) ?? { got: 0, ok: 0 }
    byPart.set(n, count)
    count.got++
    // Only the length is kept: a 2 GB upload must not live in the dev server's memory.
    const { length } = await readBody(req, PART_CAP, false)
    if (state.faults.slowMs > 0) await new Promise((r) => setTimeout(r, state.faults.slowMs))
    if (state.faults.failParts > 0) {
      state.faults.failParts--
      throw new HttpError(503, 'unavailable')
    }
    if (att.status !== 'uploading') throw new HttpError(409, 'not_uploading')
    if (!Number.isInteger(n) || n < 1 || n > att.partCount) throw new HttpError(400, 'bad_part')
    // R2 multipart refuses unequal middle parts; the mock does too so an uploader slicing wrong is caught here.
    const expected = n < att.partCount ? PART_SIZE : att.sizeBytes - (att.partCount - 1) * PART_SIZE
    if (length !== expected) throw new HttpError(400, 'bad_part_size')
    att.parts.set(n, length)
    count.ok++
    return send(res, 200, { n, etag: `"${att.id}-${n}-${length}"` })
  }
  if ((m = at(/^\/attachments\/([\w-]+)\/parts$/, 'GET'))) {
    const att = needAtt(req, m[1]!)
    const uploaded = [...att.parts].sort((a, b) => a[0] - b[0]).map(([n, size]) => ({ n, size }))
    return send(res, 200, { uploaded } satisfies ListPartsRes)
  }
  if ((m = at(/^\/attachments\/([\w-]+)\/complete$/, 'POST'))) {
    const att = needAtt(req, m[1]!)
    if (att.status === 'complete') return send(res, 200, { ok: true })
    if (att.status !== 'uploading') throw new HttpError(409, 'not_uploading')
    const missing: number[] = []
    for (let n = 1; n <= att.partCount; n++) if (!att.parts.has(n)) missing.push(n)
    if (missing.length) return send(res, 409, { error: 'missing_parts', missing })
    att.status = 'complete'
    touch(needReport(att.code))
    return send(res, 200, { ok: true })
  }
  if ((m = at(/^\/attachments\/([\w-]+)$/, 'DELETE'))) {
    const att = needAtt(req, m[1]!)
    att.status = att.status === 'complete' ? 'deleted' : 'aborted'
    att.parts.clear()
    return send(res, 200, { ok: true })
  }
  if ((m = at(/^\/status\/(LUM-\d{6})$/, 'GET'))) {
    const rec = state.reports.get(m[1]!)
    if (!rec) throw new HttpError(404, 'not_found')
    return send(res, 200, { code: rec.report.code, ...publicStatus(rec) } satisfies StatusRes)
  }

  if (at(/^\/desk\/reports$/, 'GET')) {
    const filter = url.searchParams.get('filter') ?? 'all'
    if (!FILTERS.includes(filter as DeskFilter)) throw new HttpError(400, 'invalid_filter')
    // The worker's cursor is opaque to the desk; an offset is enough here. No tab counts: the worker sends none.
    const offset = Number(url.searchParams.get('cursor') || 0)
    if (!Number.isInteger(offset) || offset < 0) throw new HttpError(400, 'invalid_cursor')
    const all = [...state.reports.values()].sort((a, b) => times(b).createdAt - times(a).createdAt)
    const hits = all.filter((r) => MATCH[filter as DeskFilter](r.report))
    const page = hits.slice(offset, offset + PAGE).map(row)
    const nextCursor = offset + PAGE < hits.length ? String(offset + PAGE) : null
    return send(res, 200, { reports: page, nextCursor } satisfies DeskListWire)
  }
  if ((m = at(/^\/desk\/reports\/(LUM-\d{6})$/, 'GET'))) return send(res, 200, detail(needReport(m[1]!)))
  if ((m = at(/^\/desk\/attachments\/([\w-]+)\/stream$/, 'GET'))) {
    const att = state.atts.get(m[1]!)
    if (!att || att.status !== 'complete') throw new HttpError(404, 'not_found')
    return stream(req, res, att, jpg)
  }
  if ((m = at(/^\/desk\/reports\/(LUM-\d{6})\/status$/, 'POST'))) {
    // The worker's order (desk.ts setStatus): the body's fields first, then the report, then the link.
    const b = await readJson(req)
    if (!STATUSES.includes(b.status as ReportStatus)) throw new HttpError(400, 'invalid_status')
    const status = b.status as ReportStatus
    const pr = b.prUrl ?? null
    if (pr !== null && (typeof pr !== 'string' || pr.length > 300 || !PR_URL.test(pr))) fail(400, 'invalid_pr_url')
    if (b.note != null && (typeof b.note !== 'string' || [...b.note.trim()].length > 2000)) fail(400, 'invalid_note')
    // A link only with `duplicate`; any other status clears it.
    if (status !== 'duplicate' && b.duplicateOf != null) fail(400, 'invalid_duplicate_of')
    const rec = needReport(m[1]!)
    rec.report.duplicateOf = status === 'duplicate' ? rootOf(rec.report.code, b.duplicateOf) : undefined
    rec.report.status = status
    if (typeof pr === 'string') rec.report.prUrl = pr
    touch(rec)
    return send(res, 200, { ok: true })
  }
  throw new HttpError(404, 'not_found')
}

async function control(req: IncomingMessage, res: ServerResponse, p: string): Promise<void> {
  if (req.method === 'POST' && p === '/__mock/reset') {
    state = fresh()
    return send(res, 200, { ok: true })
  }
  if (req.method === 'POST' && p === '/__mock/faults') {
    const b = await readJson(req)
    const { failParts, offline, slowMs } = b
    const isCount = (v: unknown, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max
    // Checked before any write, so a bad switch leaves the faults as they were.
    if (failParts !== undefined && !isCount(failParts, 10_000)) throw new HttpError(400, 'bad_request')
    if (offline !== undefined && typeof offline !== 'boolean') throw new HttpError(400, 'bad_request')
    if (slowMs !== undefined && !isCount(slowMs, 60_000)) throw new HttpError(400, 'bad_request')
    const f = state.faults
    if (failParts !== undefined) f.failParts = failParts as number
    if (offline !== undefined) f.offline = offline as boolean
    if (slowMs !== undefined) f.slowMs = slowMs as number
    return send(res, 200, f)
  }
  if (req.method === 'POST' && p === '/__mock/video') {
    const { bytes, length } = await readBody(req, CLIP_CAP, true)
    clip = length > 0 ? Buffer.concat(bytes) : null
    return send(res, 200, { bytes: length })
  }
  if (req.method === 'GET' && p === '/__mock/stats') {
    const parts = (byPart: Map<number, { got: number; ok: number }>) => Object.fromEntries([...byPart])
    return send(res, 200, Object.fromEntries([...state.puts].map(([id, byPart]) => [id, parts(byPart)])))
  }
  throw new HttpError(404, 'not_found')
}

export function mockApi(): Plugin {
  return {
    name: 'lumina-mock-api',
    apply: 'serve',
    configureServer(server) {
      const jpg = path.join(server.config.publicDir, 'gameplay-wave2.jpg')
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://mock.local')
        const isApi = url.pathname.startsWith('/api/v1/')
        if (!isApi && !url.pathname.startsWith('/__mock/')) return next()
        const work = isApi ? api(req, res, url, jpg) : control(req, res, url.pathname)
        work.catch((err: unknown) => {
          // An error answered before its body was read still needs the body drained, or the socket stalls.
          req.resume()
          if (res.headersSent) return res.end()
          if (err instanceof HttpError) return send(res, err.status, { error: err.code })
          server.config.logger.error(`[mock-api] ${String(err)}`)
          send(res, 500, { error: 'internal' })
        })
      })
    },
  }
}
