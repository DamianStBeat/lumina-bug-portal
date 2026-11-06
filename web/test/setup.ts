// Test seam for every spec (vitest.config.ts setupFiles): crypto.subtle.digest answers from Node's thread pool after
// a few milliseconds of real time, while the specs' flush() and settle() under fake timers last microseconds, so a
// spec waiting on a pick's hash raced. Here SHA-256 is computed by node:crypto and answered in a microtask: still
// async, the same bytes as the real digest (proved in seam.spec.ts), and any other algorithm is refused.
import { createHash } from 'node:crypto'
import { afterEach } from 'vitest'

// Knobs for a spec (cleared after every case): `hold` keeps every digest unanswered until released, a stand-in for a
// phone hashing 1 MiB; `fail` rejects every digest, as a browser that cannot hash does (hashHead then gives null).
let knob: { hold: Promise<void> } | 'fail' | null = null
afterEach(() => {
  knob = null
})
export function holdDigest(): () => void {
  let release!: () => void
  const hold = new Promise<void>((r) => (release = r))
  knob = { hold }
  return () => {
    knob = null
    release()
  }
}
export function failDigest(): void {
  knob = 'fail'
}
export function normalDigest(): void {
  knob = null
}

async function digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
  if (knob === 'fail') throw new DOMException('The operation failed for an operation-specific reason.', 'OperationError')
  if (knob) await knob.hold
  const name = typeof algorithm === 'string' ? algorithm : algorithm.name
  if (name.toUpperCase() !== 'SHA-256') throw new Error(`test seam: digest knows SHA-256 only, not ${name}`)
  const bytes = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data)
  const out = createHash('sha256').update(bytes).digest()
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
}

// An own property on the environment's SubtleCrypto: restoreMocks and unstubGlobals leave it in place.
Object.defineProperty(globalThis.crypto.subtle, 'digest', { value: digest, configurable: true, writable: true })
