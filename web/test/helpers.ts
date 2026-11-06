// Test seams for the uploader specs: a fake worker (CONTRACT.md "HTTP API", public part), files whose bytes are
// never allocated, and an in-memory sessionStorage. The fake keeps parts by length (and the file offset they came
// from), never their bytes, so a 2 GiB upload costs a few kilobytes.
import { vi } from 'vitest'

export const MiB = 1024 ** 2
export const GiB = 1024 ** 3
// CONTRACT.md "Limits": parts of 16 MiB, at most 3 files of 2 GiB each, at most 128 parts.
export const CONTRACT_PART_SIZE = 16777216
const MAX_FILE = 2 * GiB
const MAX_FILES = 3
const MAX_PARTS = 128

// A Blob stand-in: size and slice() behave as the browser's (clamped, end exclusive), the bytes do not exist.
// `offset` is where the slice starts in the original file, so the server can tell which bytes a part carried.
export class SparseBlob {
  constructor(
    readonly size: number,
    readonly type = '',
    readonly offset = 0,
  ) {}
  slice(start = 0, end = this.size): SparseBlob {
    const clamp = (v: number) => Math.max(0, Math.min(this.size, v < 0 ? this.size + v : v))
    const s = clamp(start)
    const e = Math.max(s, clamp(end))
    return new SparseBlob(e - s, '', this.offset + s)
  }
}

export class SparseFile extends SparseBlob {
  constructor(
    readonly name: string,
    size: number,
    type: string,
    readonly lastModified = 1_762_400_000_000,
  ) {
    super(size, type)
  }
}

// The hooks and pages are typed for File; the uploader only reads name, size, type, lastModified and slice().
export function file(name: string, size: number, type = 'video/mp4', lastModified?: number): File {
  return new SparseFile(name, size, type, lastModified) as unknown as File
}

// 'cut': the server stored the request and its 200 headers arrived, then the connection dropped in the body.
// `body`: the answer's raw text instead of `{ error }` (a 200 that is not the JSON the contract names).
export type Fault = 'ok' | 'network' | 'cut' | { status: number; error?: string; body?: string }
type Part = { size: number; offset: number | null }
type Att = {
  id: string
  code: string
  filename: string
  size: number
  mime: string
  partSize: number
  partCount: number
  parts: Map<number, Part>
  status: 'uploading' | 'complete' | 'aborted'
}
type Report = { tokens: Set<string>; status: string; extra: Record<string, unknown> }
export type Logged = {
  method: string
  path: string
  token: string | null
  credentials: RequestCredentials | undefined
  contentType: string | null
  at: number
  // false when the request never reached the server (offline, aborted before it was answered).
  reached: boolean
  // PUT parts only.
  id?: string
  n?: number
  bodySize?: number
}

export type Deferred = { promise: Promise<void>; resolve(): void }
export function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const fail = (status: number, error: string, more: Record<string, unknown> = {}) => json(status, { error, ...more })

// A response whose status and headers arrived and whose body did not: reading it rejects as the browser's does when
// the connection is lost mid-body.
export function cutResponse(status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode('{"ok":tr'))
      c.error(new TypeError('network error'))
    },
  })
  return new Response(stream, { status, headers: { 'Content-Type': 'application/json' } })
}

function faultAnswer(f: Exclude<Fault, 'ok' | 'network' | 'cut'>): Response {
  if (f.body !== undefined) return new Response(f.body, { status: f.status, headers: { 'Content-Type': 'application/json' } })
  return fail(f.status, f.error ?? `fault_${f.status}`)
}

function abortError(): Error {
  const e = new Error('The operation was aborted.')
  e.name = 'AbortError'
  return e
}

function waitOrAbort(p: Promise<void>, signal: AbortSignal | null | undefined): Promise<void> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError())
    signal.addEventListener('abort', onAbort, { once: true })
    p.then(() => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(abortError())
      else resolve()
    })
  })
}

export class FakeServer {
  partSize = CONTRACT_PART_SIZE
  readonly reports = new Map<string, Report>()
  readonly atts = new Map<string, Att>()
  readonly log: Logged[] = []
  // Every request fails as the browser's fetch does with no network (TypeError), and is never seen by the server.
  offline = false
  putsInFlight = 0
  maxPutsInFlight = 0
  // Decides the answer to one PUT before it is stored; `k` counts the PUTs of that part, this one included.
  partFault: (id: string, n: number, k: number) => Fault = () => 'ok'
  // While it returns a promise, the PUT waits for it (in flight, unanswered) before being stored and answered.
  holdPart: (id: string, n: number) => Promise<void> | null = () => null
  // While set, POST /reports/{code}/attachments waits for it before creating anything.
  holdCreate: Promise<void> | null = null
  // While it returns a promise for a request (method, path after /api/v1), that request waits for it first.
  holdRoute: (method: string, path: string) => Promise<void> | null = () => null
  // Decides the answer to any request but a PUT part (partFault has those) before the server handles it; `k` counts
  // the requests with this method and path, this one included. null or 'ok': handled as usual.
  routeFault: (method: string, path: string, k: number) => Fault | null = () => null
  // Runs at the start of every complete, before the server checks its parts (a server that lost parts).
  beforeComplete: (att: Att, k: number) => void = () => {}
  private nextCode = 500001
  private nextAtt = 1
  private nextToken = 1
  private completes = new Map<string, number>()

  addReport(code: string, status = 'received', extra: Record<string, unknown> = {}): string {
    const token = `tok-${this.nextToken++}`
    this.reports.set(code, { tokens: new Set([token]), status, extra })
    return token
  }

  puts(id?: string): Logged[] {
    return this.log.filter((r) => r.method === 'PUT' && (id === undefined || r.id === id))
  }
  requests(method: string, pathPart: string): Logged[] {
    return this.log.filter((r) => r.method === method && r.path.includes(pathPart))
  }
  attsOf(code: string): Att[] {
    return [...this.atts.values()].filter((a) => a.code === code)
  }
  confirmedBytes(id: string): number {
    let sum = 0
    this.atts.get(id)?.parts.forEach((p) => (sum += p.size))
    return sum
  }
  expectedSize(a: Att, n: number): number {
    return n < a.partCount ? a.partSize : a.size - a.partSize * (a.partCount - 1)
  }

  readonly fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://x')
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = new Headers(init.headers)
    const entry: Logged = {
      method,
      path: url.pathname + url.search,
      token: headers.get('X-Report-Token'),
      credentials: init.credentials,
      contentType: headers.get('Content-Type'),
      at: Date.now(),
      reached: false,
    }
    this.log.push(entry)
    if (init.signal?.aborted) throw abortError()
    if (this.offline) throw new TypeError('Failed to fetch')
    const path = url.pathname.replace(/^.*\/api\/v1/, '')
    const held = this.holdRoute(method, path)
    if (held) await waitOrAbort(held, init.signal)
    let m: RegExpExecArray | null
    const isPart = method === 'PUT' && /^\/attachments\/[^/]+\/parts\/\d+$/.test(path)
    if (!isPart) {
      const k = this.log.filter((r) => r.method === method && r.path === entry.path).length
      const f = this.routeFault(method, path, k)
      if (f === 'network') throw new TypeError('Failed to fetch')
      if (f === 'cut') {
        entry.reached = true
        return cutResponse()
      }
      if (f && f !== 'ok') {
        entry.reached = true
        return faultAnswer(f)
      }
    }

    if (method === 'PUT' && (m = /^\/attachments\/([^/]+)\/parts\/(\d+)$/.exec(path))) {
      const id = decodeURIComponent(m[1] as string)
      const n = Number(m[2])
      const body = init.body as unknown as { size?: number; byteLength?: number; offset?: number } | null
      entry.id = id
      entry.n = n
      entry.bodySize = body?.size ?? body?.byteLength ?? 0
      this.putsInFlight++
      this.maxPutsInFlight = Math.max(this.maxPutsInFlight, this.putsInFlight)
      try {
        const hold = this.holdPart(id, n)
        if (hold) await waitOrAbort(hold, init.signal)
        // Yields once, so parts sent together are really in flight together.
        await waitOrAbort(Promise.resolve(), init.signal)
        if (this.offline) throw new TypeError('Failed to fetch')
        const k = this.puts(id).filter((r) => r.n === n).length
        const fault = this.partFault(id, n, k)
        if (fault === 'network') throw new TypeError('Failed to fetch')
        entry.reached = true
        if (fault !== 'ok' && fault !== 'cut') return faultAnswer(fault)
        const a = this.atts.get(id)
        if (!a) return fail(404, 'not_found')
        if (!entry.token || !this.reports.get(a.code)?.tokens.has(entry.token)) return fail(401, 'invalid_token')
        if (a.status !== 'uploading') return fail(409, 'not_uploading')
        if (n < 1 || n > a.partCount) return fail(400, 'invalid_part')
        if (entry.bodySize !== this.expectedSize(a, n)) return fail(400, 'invalid_part_size')
        a.parts.set(n, { size: entry.bodySize, offset: typeof body?.offset === 'number' ? body.offset : null })
        // Stored, but the answer is lost after its headers: the client cannot know the part arrived.
        if (fault === 'cut') return cutResponse()
        return json(200, { n, etag: `etag-${id}-${n}-${k}` })
      } finally {
        this.putsInFlight--
      }
    }

    if (method === 'POST' && path === '/reports') {
      entry.reached = true
      const body = JSON.parse(String(init.body)) as { what?: string; turnstileToken?: string }
      if (!body.turnstileToken) return fail(403, 'turnstile_failed')
      if (!body.what || !body.what.trim()) return fail(400, 'invalid_what')
      const code = `LUM-${this.nextCode++}`
      const reportToken = this.addReport(code)
      return json(201, { code, reportToken })
    }

    if (method === 'POST' && (m = /^\/reports\/([^/]+)\/attach-session$/.exec(path))) {
      entry.reached = true
      const r = this.reports.get(decodeURIComponent(m[1] as string))
      const body = JSON.parse(String(init.body)) as { turnstileToken?: string }
      if (!body.turnstileToken) return fail(403, 'turnstile_failed')
      if (!r) return fail(404, 'not_found')
      const reportToken = `tok-${this.nextToken++}`
      r.tokens.add(reportToken)
      return json(200, { reportToken })
    }

    if (method === 'POST' && (m = /^\/reports\/([^/]+)\/attachments$/.exec(path))) {
      if (this.holdCreate) await waitOrAbort(this.holdCreate, init.signal)
      entry.reached = true
      const code = decodeURIComponent(m[1] as string)
      const r = this.reports.get(code)
      if (!r) return fail(404, 'not_found')
      if (!entry.token || !r.tokens.has(entry.token)) return fail(401, 'invalid_token')
      const body = JSON.parse(String(init.body)) as { filename: string; size: number; mime: string }
      if (!/^(video|image)\//.test(body.mime ?? '')) return fail(400, 'invalid_mime')
      if (!Number.isInteger(body.size) || body.size < 1) return fail(400, 'invalid_size')
      if (body.size > MAX_FILE) return fail(400, 'file_too_large')
      if (this.attsOf(code).filter((a) => a.status !== 'aborted').length >= MAX_FILES) {
        return fail(400, 'too_many_files')
      }
      const partCount = Math.ceil(body.size / this.partSize)
      if (partCount > MAX_PARTS) return fail(400, 'file_too_large')
      const id = `att-${this.nextAtt++}`
      this.atts.set(id, {
        id,
        code,
        filename: body.filename,
        size: body.size,
        mime: body.mime,
        partSize: this.partSize,
        partCount,
        parts: new Map(),
        status: 'uploading',
      })
      return json(201, { attachmentId: id, partSize: this.partSize, partCount })
    }

    if ((m = /^\/attachments\/([^/]+)(\/parts|\/complete)?$/.exec(path))) {
      entry.reached = true
      const a = this.atts.get(decodeURIComponent(m[1] as string))
      if (!a) return fail(404, 'not_found')
      if (!entry.token || !this.reports.get(a.code)?.tokens.has(entry.token)) return fail(401, 'invalid_token')
      if (method === 'GET' && m[2] === '/parts') {
        return json(200, { uploaded: [...a.parts].map(([n, p]) => ({ n, size: p.size })) })
      }
      if (method === 'POST' && m[2] === '/complete') {
        const k = (this.completes.get(a.id) ?? 0) + 1
        this.completes.set(a.id, k)
        this.beforeComplete(a, k)
        if (a.status === 'complete') return json(200, { ok: true })
        const missing: number[] = []
        for (let n = 1; n <= a.partCount; n++) if (!a.parts.has(n)) missing.push(n)
        if (missing.length) return fail(409, 'missing_parts', { missing })
        a.status = 'complete'
        return json(200, { ok: true })
      }
      if (method === 'DELETE' && !m[2]) {
        a.status = 'aborted'
        return json(200, { ok: true })
      }
    }

    if (method === 'GET' && (m = /^\/status\/([^/]+)$/.exec(path))) {
      entry.reached = true
      const code = decodeURIComponent(m[1] as string)
      const r = this.reports.get(code)
      if (!r) return fail(404, 'not_found')
      return json(200, { code, status: r.status, updatedAt: 1_762_400_000_000, ...r.extra })
    }

    entry.reached = true
    return fail(404, 'not_found')
  })

  install(): this {
    vi.stubGlobal('fetch', this.fetch)
    return this
  }
}

// sessionStorage as the browser's, in memory; `broken` makes every call throw (blocked storage, private mode),
// `garbage` answers every read with text that is not JSON.
export function memoryStorage(mode: 'ok' | 'broken' | 'garbage' = 'ok'): Storage {
  const data = new Map<string, string>()
  const guard = () => {
    if (mode === 'broken') throw new DOMException('The operation is insecure.', 'SecurityError')
  }
  return {
    get length() {
      guard()
      return data.size
    },
    key(i: number) {
      guard()
      return [...data.keys()][i] ?? null
    },
    getItem(k: string) {
      guard()
      if (mode === 'garbage') return '{"v":2,"code":'
      return data.get(k) ?? null
    },
    setItem(k: string, v: string) {
      guard()
      data.set(k, String(v))
    },
    removeItem(k: string) {
      guard()
      data.delete(k)
    },
    clear() {
      guard()
      data.clear()
    },
  }
}

export function installStorage(mode: 'ok' | 'broken' | 'garbage' = 'ok'): Storage {
  const s = memoryStorage(mode)
  vi.stubGlobal('sessionStorage', s)
  return s
}

// Fake timers for setTimeout/Date only: promises, React's act and the fake server's awaits keep running for real.
export function useFakeClock(): void {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  // Jitter fixed at the middle of its range, so a run is the same every time.
  vi.spyOn(Math, 'random').mockReturnValue(0.5)
}

// Moves the fake clock until `p` settles (every backoff of a 6-try part fits in well under 10 minutes).
export async function drive<T>(p: Promise<T>, maxMs = 600_000): Promise<T> {
  let settled = false
  p.then(
    () => (settled = true),
    () => (settled = true),
  )
  for (let t = 0; t < maxMs && !settled; t += 250) await vi.advanceTimersByTimeAsync(250)
  return p
}

// Lets every pending promise chain run without moving the clock.
export async function flush(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await vi.advanceTimersByTimeAsync(0)
}
