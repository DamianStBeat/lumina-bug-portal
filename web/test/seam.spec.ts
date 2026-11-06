// The digest seam of test/setup.ts must not hide a wrong hash: it gives the real SHA-256 (the FIPS 180-2 vector, and
// Node's own WebCrypto on a fake file's first 1 MiB), answers within microtasks, and refuses any other algorithm.
import { describe, expect, it } from 'vitest'
import { MiB, file } from './helpers'

// Node's own digest: the seam is an own property of the SubtleCrypto instance, so the prototype still holds the real one
// (node:crypto's webcrypto is the same instance, patched as well).
const realDigest = (data: BufferSource): Promise<ArrayBuffer> =>
  (Object.getPrototypeOf(crypto.subtle) as SubtleCrypto).digest.call(crypto.subtle, 'SHA-256', data)
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('')

describe('test seam: crypto.subtle.digest', () => {
  it('seam: SHA-256 of "abc" is the FIPS 180-2 value', async () => {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc'))
    expect(hex(h)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('seam: the first 1 MiB of a fake file hashes as Node\'s real WebCrypto hashes it, and another seed differs', async () => {
    const head = await file('clip.mp4', 4 * MiB, 'video/mp4', 1000, { seed: 1 }).slice(0, MiB).arrayBuffer()
    const other = await file('clip.mp4', 4 * MiB, 'video/mp4', 1000, { seed: 2 }).slice(0, MiB).arrayBuffer()
    const seam = hex(await crypto.subtle.digest('SHA-256', head))
    expect((Object.getPrototypeOf(crypto.subtle) as SubtleCrypto).digest).not.toBe(crypto.subtle.digest)
    expect(seam).toBe(hex(await realDigest(head)))
    expect(seam).not.toBe(hex(await crypto.subtle.digest('SHA-256', other)))
    expect(hex(await crypto.subtle.digest({ name: 'SHA-256' }, new Uint8Array(head)))).toBe(seam)
  })

  it('seam: it answers within microtasks, with no turn of the event loop', async () => {
    let done = false
    void crypto.subtle.digest('SHA-256', new Uint8Array(MiB)).then(() => (done = true))
    for (let i = 0; i < 5; i++) await Promise.resolve()
    expect(done).toBe(true)
  })

  it('seam: any other algorithm is refused', async () => {
    await expect(crypto.subtle.digest('SHA-1', new Uint8Array(3))).rejects.toThrow(/SHA-256 only/)
  })
})
