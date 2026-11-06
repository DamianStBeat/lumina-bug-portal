import { ApiError, completeAttachment, listParts, putPart } from '../api/client'

// Framework-free on purpose: one file, one attachment, everything it needs passed in.
// Pool: 3 parts in flight per file, and useUpload sends the files one after the other, so never more than 3 at once.
export const MAX_IN_FLIGHT = 3
export const MAX_ATTEMPTS = 5
const BASE_DELAY_MS = 1000

export type UploadOptions = {
  file: Blob
  attachmentId: string
  partSize: number
  partCount: number
  token: string
  signal?: AbortSignal
  // Bytes the server has answered 200 for, never bytes merely sent: a bar that lies at 99 % is worse than a slow one.
  onConfirmed(bytesConfirmed: number): void
}

// Network, timeouts, rate limits and server errors can pass; any other 4xx will answer the same way next time.
function retryable(e: unknown): boolean {
  if (!(e instanceof ApiError)) return false
  return e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500
}

const hasWindow = typeof window !== 'undefined'

// ~1 s, 2 s, 4 s, 8 s with ±25 % jitter, so many players cut off together do not come back in the same second.
// Ends early when the network returns; rejects when the run is stopped.
function backoff(attempt: number, signal: AbortSignal): Promise<void> {
  const ms = BASE_DELAY_MS * 2 ** (attempt - 1) * (0.75 + Math.random() * 0.5)
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer)
      if (hasWindow) window.removeEventListener('online', done)
      signal.removeEventListener('abort', done)
      if (signal.aborted) reject(signal.reason)
      else resolve()
    }
    const timer = setTimeout(done, ms)
    if (hasWindow) window.addEventListener('online', done)
    signal.addEventListener('abort', done)
  })
}

export async function uploadFile(o: UploadOptions): Promise<void> {
  const { file, attachmentId: id, partSize, partCount, token } = o
  const lastSize = file.size - partSize * (partCount - 1)
  // The server sized the parts from the size we declared; a mismatch means this is not the file it expects.
  if (partCount < 1 || lastSize < 1 || lastSize > partSize) throw new ApiError(0, 'bad_parts')
  const expected = (n: number) => (n < partCount ? partSize : lastSize)

  // `run` stops everything: the caller's signal, or one part out of attempts. A caller's stop rejects as 'aborted',
  // so the page can tell it from a network failure and stay quiet.
  const run = new AbortController()
  const onStop = () => run.abort(new ApiError(0, 'aborted'))
  o.signal?.addEventListener('abort', onStop)
  if (o.signal?.aborted) onStop()

  // Losing the network cancels the parts in flight at once instead of waiting for the browser to time out; each
  // then waits in its backoff for 'online'.
  const inFlight = new Set<AbortController>()
  const onOffline = () => inFlight.forEach((c) => c.abort())
  if (hasWindow) window.addEventListener('offline', onOffline)

  const confirmed = new Map<number, number>()
  const report = () => {
    let sum = 0
    confirmed.forEach((b) => (sum += b))
    o.onConfirmed(sum)
  }

  async function attempt<T>(send: (signal: AbortSignal) => Promise<T>): Promise<T> {
    for (let k = 1; ; k++) {
      if (run.signal.aborted) throw run.signal.reason
      const c = new AbortController()
      const link = () => c.abort()
      run.signal.addEventListener('abort', link)
      inFlight.add(c)
      try {
        return await send(c.signal)
      } catch (e) {
        if (run.signal.aborted) throw run.signal.reason
        if (!retryable(e) || k >= MAX_ATTEMPTS) throw e
      } finally {
        inFlight.delete(c)
        run.signal.removeEventListener('abort', link)
      }
      await backoff(k, run.signal)
    }
  }

  async function sendParts(list: number[]): Promise<void> {
    let next = 0
    let failure: unknown = null
    const worker = async () => {
      while (failure === null && next < list.length) {
        const n = list[next++] as number
        const start = (n - 1) * partSize
        const blob = file.slice(start, start + expected(n))
        try {
          await attempt((signal) => putPart(id, n, token, blob, signal))
          confirmed.set(n, expected(n))
          report()
        } catch (e) {
          // The first failure wins; aborting `run` stops the siblings so the error shows now, not after them.
          if (failure === null) {
            failure = e
            run.abort(e)
          }
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(MAX_IN_FLIGHT, list.length) }, worker))
    if (failure !== null) throw failure
  }

  const unconfirmed = () => Array.from({ length: partCount }, (_, i) => i + 1).filter((n) => !confirmed.has(n))

  async function readServer(): Promise<void> {
    const { uploaded } = await attempt(() => listParts(id, token))
    confirmed.clear()
    // A part of the wrong size (an older, cut attempt) is not "done": it is sent again and replaced.
    for (const p of uploaded) {
      if (Number.isInteger(p.n) && p.n >= 1 && p.n <= partCount && p.size === expected(p.n)) confirmed.set(p.n, p.size)
    }
    report()
  }

  try {
    await readServer()
    await sendParts(unconfirmed())
    const first = await attempt(() => completeAttachment(id, token))
    if (!first.missing) return
    // The server knows better than our map: forget what it says is missing, and ask it when it gave no list.
    first.missing.forEach((n) => confirmed.delete(n))
    if (first.missing.length === 0) await readServer()
    else report()
    await sendParts(unconfirmed())
    const second = await attempt(() => completeAttachment(id, token))
    if (second.missing) throw new ApiError(409, 'missing_parts')
  } finally {
    o.signal?.removeEventListener('abort', onStop)
    if (hasWindow) window.removeEventListener('offline', onOffline)
  }
}
