// Test seam for every spec (vitest.config.ts setupFiles): crypto.subtle.digest answers from Node's thread pool after
// a few milliseconds of real time, while the specs' flush() and settle() under fake timers last microseconds, so a
// spec waiting on a pick's hash raced. Here SHA-256 is computed by node:crypto and answered in a microtask: still
// async, the same bytes as the real digest (proved in seam.spec.ts), and any other algorithm is refused.
import { createHash } from 'node:crypto'

async function digest(algorithm: AlgorithmIdentifier, data: BufferSource): Promise<ArrayBuffer> {
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
