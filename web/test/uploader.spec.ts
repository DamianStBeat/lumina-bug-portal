// The uploader against the fake worker: rows 3 and 4 at the module level, and CONTRACT.md "Limits" (parts of the size
// the API returns, last part smaller, at most 128) plus the brief's uploader rules (3 parts in flight, each part one
// try and 5 retries with backoff, progress from bytes confirmed, 409 missing_parts acted on).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError, createAttachment } from '../src/api/client'
import { uploadFile } from '../src/upload/uploader'
import {
  CONTRACT_PART_SIZE as PART,
  FakeServer,
  GiB,
  MiB,
  deferred,
  drive,
  file,
  flush,
  useFakeClock,
  type Deferred,
} from './helpers'

let server: FakeServer
beforeEach(() => {
  useFakeClock()
  server = new FakeServer().install()
})
afterEach(() => {
  vi.useRealTimers()
})

// A report and an attachment made through the real client, so part size and count are the server's answer.
async function attach(f: File, code = 'LUM-482193') {
  const token = server.reports.get(code)?.tokens.values().next().value ?? server.addReport(code)
  const a = await createAttachment(code, token, { filename: f.name, size: f.size, mime: f.type })
  return { token, ...a }
}

function run(f: File, a: Awaited<ReturnType<typeof attach>>, extra: { signal?: AbortSignal } = {}) {
  const seen: number[] = []
  const p = uploadFile({
    file: f,
    attachmentId: a.attachmentId,
    partSize: a.partSize,
    partCount: a.partCount,
    token: a.token,
    signal: extra.signal,
    onConfirmed: (b) => seen.push(b),
  })
  return { p, seen }
}

describe('row 3: a 300 MB video is sent in parts and completed, with a moving bar', () => {
  it('row 3: 300 MB goes up as 17 parts of 16 MiB and a smaller 18th, from the right offsets, then completes', async () => {
    const size = 300_000_000
    const f = file('boss-bridge.mp4', size)
    const a = await attach(f)
    expect(a.partSize).toBe(PART)
    const { p, seen } = run(f, a)
    await drive(p)
    const att = server.atts.get(a.attachmentId)!
    expect(att.status).toBe('complete')
    expect(att.parts.size).toBe(18)
    for (let n = 1; n <= 17; n++) expect(att.parts.get(n)).toEqual({ size: PART, offset: (n - 1) * PART })
    expect(att.parts.get(18)).toEqual({ size: size - 17 * PART, offset: 17 * PART })
    // The bar: it ends at the file size and passes through values in between.
    expect(seen.at(-1)).toBe(size)
    expect(seen.some((b) => b > 0 && b < size)).toBe(true)
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] as number)
    expect(server.requests('POST', '/complete')).toHaveLength(1)
  })

  it('row 3: every request carries the report token', async () => {
    const f = file('clip.mp4', 40 * MiB)
    const a = await attach(f)
    await drive(run(f, a).p)
    const calls = server.log.filter((r) => r.path.includes('/attachments'))
    expect(calls.length).toBeGreaterThan(0)
    for (const r of calls) expect(r.token).toBe(a.token)
  })
})

describe('contract limit: part size is the one the API returns, last part smaller', () => {
  it('limit part size: a server answering 5 MiB parts gets 5, 5 and 2 MiB', async () => {
    server.partSize = 5 * MiB
    const f = file('clip.mp4', 12 * MiB)
    const a = await attach(f)
    await drive(run(f, a).p)
    const att = server.atts.get(a.attachmentId)!
    expect(att.status).toBe('complete')
    expect([...att.parts.entries()].sort(([x], [y]) => x - y).map(([, q]) => q.size)).toEqual([5 * MiB, 5 * MiB, 2 * MiB])
    // Every PUT body had the size of its part: none was a whole-file or 16 MiB body.
    for (const r of server.puts()) expect(r.bodySize).toBeLessThanOrEqual(5 * MiB)
  })

  it('limit part size: exactly two parts long sends two full parts, no empty third', async () => {
    const f = file('clip.mp4', 2 * PART)
    const a = await attach(f)
    await drive(run(f, a).p)
    expect(server.puts().map((r) => [r.n, r.bodySize])).toEqual(
      expect.arrayContaining([
        [1, PART],
        [2, PART],
      ]),
    )
    expect(server.puts()).toHaveLength(2)
    expect(server.atts.get(a.attachmentId)!.status).toBe('complete')
  })

  it('limit part size: one byte past a part boundary sends a 1 byte last part', async () => {
    const f = file('clip.mp4', PART + 1)
    const a = await attach(f)
    await drive(run(f, a).p)
    const att = server.atts.get(a.attachmentId)!
    expect(att.parts.get(2)).toEqual({ size: 1, offset: PART })
    expect(att.status).toBe('complete')
  })

  it('limit part size: a 1 byte file is one part', async () => {
    const f = file('tiny.png', 1, 'image/png')
    const a = await attach(f)
    await drive(run(f, a).p)
    expect(server.puts()).toHaveLength(1)
    expect(server.atts.get(a.attachmentId)!.status).toBe('complete')
  })

  it('limit 128 parts: a 2 GiB file goes up as 128 parts and completes', async () => {
    const f = file('max.mp4', 2 * GiB)
    const a = await attach(f)
    expect(a.partCount).toBe(128)
    await drive(run(f, a).p)
    const att = server.atts.get(a.attachmentId)!
    expect(att.parts.size).toBe(128)
    expect(att.status).toBe('complete')
  })

  it('limit part size: a file that does not fit the server parts (picked file of another size) sends nothing', async () => {
    const declared = file('clip.mp4', 40 * MiB)
    const a = await attach(declared)
    const other = file('clip.mp4', 10 * MiB)
    const { p } = run(other, a)
    await expect(drive(p)).rejects.toBeInstanceOf(ApiError)
    expect(server.puts()).toHaveLength(0)
    expect(server.requests('POST', '/complete')).toHaveLength(0)
  })
})

describe('contract rule: 3 parts in flight', () => {
  it('limit 3 in flight: ten parts are sent three at a time, never four, never fewer while parts wait', async () => {
    const f = file('clip.mp4', 10 * PART)
    const a = await attach(f)
    const pending = new Map<number, Deferred>()
    server.holdPart = (_id, n) => {
      const d = deferred()
      pending.set(n, d)
      return d.promise
    }
    const { p } = run(f, a)
    let settled = false
    p.finally(() => (settled = true)).catch(() => {})
    await flush()
    expect(server.putsInFlight).toBe(3)
    for (let spins = 0; !settled && spins < 200; spins++) {
      const next = [...pending.keys()].sort((x, y) => x - y)[0]
      if (next === undefined) {
        await flush()
        continue
      }
      pending.get(next)!.resolve()
      pending.delete(next)
      await flush()
      const left = 10 - server.atts.get(a.attachmentId)!.parts.size
      expect(server.putsInFlight).toBe(Math.min(3, left))
    }
    await p
    expect(server.maxPutsInFlight).toBe(3)
    expect(server.atts.get(a.attachmentId)!.status).toBe('complete')
  })
})

describe('brief rule: progress from bytes confirmed, never bytes sent', () => {
  it('progress: parts sent but not answered count zero; one answer counts exactly that part', async () => {
    const f = file('clip.mp4', 5 * PART)
    const a = await attach(f)
    const gates = new Map<number, Deferred>()
    server.holdPart = (_id, n) => {
      const d = deferred()
      gates.set(n, d)
      return d.promise
    }
    const { p, seen } = run(f, a)
    await flush()
    expect(server.putsInFlight).toBe(3)
    expect(Math.max(0, ...seen)).toBe(0)
    gates.get(2)!.resolve()
    await flush()
    expect(seen.at(-1)).toBe(PART)
    server.holdPart = () => null
    gates.forEach((d) => d.resolve())
    await drive(p)
    expect(seen.at(-1)).toBe(5 * PART)
  })
})

describe('brief rule: each part one try and 5 retries, with backoff', () => {
  it('limit retries: a part failing 5 times (503) then answering is uploaded, after 6 PUTs of it', async () => {
    server.partFault = (_id, n, k) => (n === 2 && k <= 5 ? { status: 503 } : 'ok')
    const f = file('clip.mp4', 3 * PART)
    const a = await attach(f)
    await drive(run(f, a).p)
    expect(server.puts().filter((r) => r.n === 2)).toHaveLength(6)
    expect(server.atts.get(a.attachmentId)!.status).toBe('complete')
  })

  it('limit retries: a part failing 6 times gives up after exactly 6 PUTs of it and never completes', async () => {
    server.partFault = (_id, n) => (n === 2 ? { status: 503 } : 'ok')
    const f = file('clip.mp4', 3 * PART)
    const a = await attach(f)
    const { p } = run(f, a)
    await expect(drive(p)).rejects.toBeInstanceOf(ApiError)
    expect(server.puts().filter((r) => r.n === 2)).toHaveLength(6)
    expect(server.requests('POST', '/complete')).toHaveLength(0)
  })

  it('limit retries: a lost connection (fetch rejects) is retried the same way', async () => {
    server.partFault = (_id, n, k) => (n === 1 && k <= 5 ? 'network' : 'ok')
    const f = file('clip.mp4', 2 * PART)
    const a = await attach(f)
    await drive(run(f, a).p)
    expect(server.puts().filter((r) => r.n === 1)).toHaveLength(6)
    expect(server.atts.get(a.attachmentId)!.status).toBe('complete')
  })

  it('limit retries: a 500 is retried', async () => {
    server.partFault = (_id, n, k) => (n === 1 && k === 1 ? { status: 500 } : 'ok')
    const f = file('clip.mp4', PART)
    const a = await attach(f)
    await drive(run(f, a).p)
    expect(server.puts()).toHaveLength(2)
    expect(server.atts.get(a.attachmentId)!.status).toBe('complete')
  })

  it('backoff: a retry is not sent at once, and the waits grow', async () => {
    server.partFault = (_id, n, k) => (n === 1 && k <= 5 ? { status: 503 } : 'ok')
    const f = file('clip.mp4', PART)
    const a = await attach(f)
    const { p } = run(f, a)
    await flush()
    // The clock has not moved: the first failure must not be retried in the same instant.
    expect(server.puts()).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(server.puts()).toHaveLength(1)
    await drive(p)
    const at = server.puts().map((r) => r.at)
    expect(at).toHaveLength(6)
    const gaps = at.slice(1).map((t, i) => t - (at[i] as number))
    for (let i = 1; i < gaps.length; i++) expect(gaps[i]).toBeGreaterThanOrEqual(gaps[i - 1] as number)
    expect(gaps.at(-1)).toBeGreaterThan(gaps[0] as number)
  })
})

describe('row 4: the Wi-Fi drops at about 41 %, comes back, Try again', () => {
  it('row 4: after the drop the retry sends only the parts the server has not confirmed', async () => {
    // 22 parts; 9 of them confirmed before the drop (9 / 22 = 41 % of the parts).
    const size = 21 * PART + 5 * MiB
    const f = file('boss-bridge.mp4', size)
    const a = await attach(f)
    let outage = true
    server.partFault = (_id, n) => (outage && n >= 10 ? 'network' : 'ok')
    const first = run(f, a)
    await expect(drive(first.p)).rejects.toBeInstanceOf(ApiError)
    const att = server.atts.get(a.attachmentId)!
    expect([...att.parts.keys()].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
    // The bar stopped where the server stopped confirming, not at 0 and not past it.
    expect(first.seen.at(-1)).toBe(9 * PART)
    expect(att.status).toBe('uploading')

    outage = false
    const mark = server.log.length
    const second = run(f, a)
    await drive(second.p)
    const resent = server.log.slice(mark).filter((r) => r.method === 'PUT').map((r) => r.n as number)
    expect(resent.sort((x, y) => x - y)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22])
    // Try again reads the server first, so the bar starts from the confirmed bytes, not from 0.
    expect(second.seen[0]).toBe(9 * PART)
    expect(att.status).toBe('complete')
    expect(att.parts.size).toBe(22)
  })
})

describe('contract rule: 409 missing_parts with the list', () => {
  it('missing_parts: a part the server lost is sent again and the upload completes', async () => {
    server.beforeComplete = (att, k) => {
      if (k === 1) att.parts.delete(3)
    }
    const f = file('clip.mp4', 5 * PART)
    const a = await attach(f)
    await drive(run(f, a).p)
    const byPart = (n: number) => server.puts().filter((r) => r.n === n).length
    expect(byPart(3)).toBe(2)
    for (const n of [1, 2, 4, 5]) expect(byPart(n)).toBe(1)
    expect(server.requests('POST', '/complete')).toHaveLength(2)
    expect(server.atts.get(a.attachmentId)!.status).toBe('complete')
  })

  it('missing_parts: every part asked again (the worker forgot them all) is sent again', async () => {
    server.beforeComplete = (att, k) => {
      if (k === 1) att.parts.clear()
    }
    const f = file('clip.mp4', 3 * PART)
    const a = await attach(f)
    await drive(run(f, a).p)
    for (const n of [1, 2, 3]) expect(server.puts().filter((r) => r.n === n)).toHaveLength(2)
    expect(server.atts.get(a.attachmentId)!.status).toBe('complete')
  })

  it('missing_parts: a server that keeps losing a part ends in a failure, not an endless loop', async () => {
    server.beforeComplete = (att) => att.parts.delete(2)
    const f = file('clip.mp4', 3 * PART)
    const a = await attach(f)
    const { p } = run(f, a)
    const err = await drive(p).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).code).toBe('missing_parts')
    expect(server.requests('POST', '/complete').length).toBeLessThanOrEqual(3)
    expect(server.atts.get(a.attachmentId)!.status).toBe('uploading')
  })
})

describe('resume from GET /attachments/{id}/parts', () => {
  it('resume: parts the server already has are not sent again', async () => {
    const f = file('clip.mp4', 6 * PART)
    const a = await attach(f)
    const att = server.atts.get(a.attachmentId)!
    for (const n of [1, 2, 4]) att.parts.set(n, { size: PART, offset: (n - 1) * PART })
    const { p, seen } = run(f, a)
    await drive(p)
    expect(server.puts().map((r) => r.n).sort()).toEqual([3, 5, 6])
    expect(seen[0]).toBe(3 * PART)
    expect(att.status).toBe('complete')
  })

  it('stop: a caller abort rejects and no part starts after it', async () => {
    const f = file('clip.mp4', 10 * PART)
    const a = await attach(f)
    const gates: Deferred[] = []
    server.holdPart = () => {
      const d = deferred()
      gates.push(d)
      return d.promise
    }
    const ac = new AbortController()
    const { p } = run(f, a, { signal: ac.signal })
    await flush()
    const before = server.puts().length
    ac.abort()
    gates.forEach((d) => d.resolve())
    await expect(drive(p)).rejects.toBeDefined()
    await flush()
    expect(server.puts().length).toBe(before)
    expect(server.requests('POST', '/complete')).toHaveLength(0)
  })
})
