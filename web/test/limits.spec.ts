// Acceptance row 6 and CONTRACT.md "Limits" (files): video or image only, at most 3 files, each 1 byte .. 2 GiB,
// checked before any byte leaves the device.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validatePick } from '../src/upload/validate'
import { useUpload } from '../src/upload/useUpload'
import { FakeServer, GiB, MiB, file, installStorage } from './helpers'

describe('row 6: a zip or a 3 GB file is refused before upload', () => {
  let server: FakeServer
  beforeEach(() => {
    installStorage()
    server = new FakeServer().install()
  })
  afterEach(() => server.fetch.mockReset())

  it('row 6: a zip is refused as type and nothing reaches the server', async () => {
    const token = server.addReport('LUM-482193')
    const { result } = renderHook(() => useUpload())
    act(() => result.current.addFiles([file('logs.zip', 3 * MiB, 'application/zip')]))
    expect(result.current.rejection).toBe('type')
    expect(result.current.files).toHaveLength(0)
    await act(() => result.current.start({ code: 'LUM-482193', reportToken: token }))
    expect(server.requests('POST', '/attachments')).toHaveLength(0)
    expect(server.puts()).toHaveLength(0)
  })

  it('row 6: a 3 GB video is refused as size and nothing reaches the server', async () => {
    const token = server.addReport('LUM-482193')
    const { result } = renderHook(() => useUpload())
    act(() => result.current.addFiles([file('long.mp4', 3_000_000_000)]))
    expect(result.current.rejection).toBe('size')
    expect(result.current.files).toHaveLength(0)
    await act(() => result.current.start({ code: 'LUM-482193', reportToken: token }))
    expect(server.requests('POST', '/attachments')).toHaveLength(0)
    expect(server.puts()).toHaveLength(0)
  })
})

describe('contract limit: mime video/* or image/* as declared', () => {
  it('limit mime: video and image types pass', () => {
    const picked = [file('a.mp4', MiB, 'video/mp4'), file('b.mov', MiB, 'video/quicktime'), file('c.png', MiB, 'image/png')]
    const r = validatePick(0, picked)
    expect(r.ok).toHaveLength(3)
    expect(r.rejection).toBeNull()
  })

  it('limit mime: a file with no declared type is refused', () => {
    const r = validatePick(0, [file('clip', MiB, '')])
    expect(r.ok).toHaveLength(0)
    expect(r.rejection).toBe('type')
  })

  it('limit mime: text and audio are refused', () => {
    expect(validatePick(0, [file('notes.txt', MiB, 'text/plain')]).rejection).toBe('type')
    expect(validatePick(0, [file('voice.mp3', MiB, 'audio/mpeg')]).rejection).toBe('type')
  })
})

describe('contract limit: each file 1 byte .. 2 GiB', () => {
  it('limit size: exactly 2 GiB passes', () => {
    const r = validatePick(0, [file('max.mp4', 2 * GiB)])
    expect(r.ok).toHaveLength(1)
    expect(r.rejection).toBeNull()
  })

  it('limit size: 2 GiB + 1 byte is refused as size', () => {
    const r = validatePick(0, [file('over.mp4', 2 * GiB + 1)])
    expect(r.ok).toHaveLength(0)
    expect(r.rejection).toBe('size')
  })

  it('limit 0 bytes: an empty file is refused as empty, not as size or type', () => {
    const r = validatePick(0, [file('empty.mp4', 0)])
    expect(r.ok).toHaveLength(0)
    expect(r.rejection).toBe('empty')
  })

  it('limit 0 bytes: a 1 byte file passes', () => {
    const r = validatePick(0, [file('tiny.png', 1, 'image/png')])
    expect(r.ok).toHaveLength(1)
    expect(r.rejection).toBeNull()
  })
})

describe('contract limit: at most 3 files per report', () => {
  const pick = (k: number) => Array.from({ length: k }, (_, i) => file(`clip${i}.mp4`, MiB))

  it('limit 3 files: three at once pass', () => {
    const r = validatePick(0, pick(3))
    expect(r.ok).toHaveLength(3)
    expect(r.rejection).toBeNull()
  })

  it('limit 3 files: a fourth in the same pick is refused as count', () => {
    const r = validatePick(0, pick(4))
    expect(r.ok).toHaveLength(3)
    expect(r.rejection).toBe('count')
  })

  it('limit 3 files: two already listed leave room for one', () => {
    const r = validatePick(2, pick(2))
    expect(r.ok).toHaveLength(1)
    expect(r.rejection).toBe('count')
  })

  it('limit 3 files: three already listed leave no room', () => {
    const r = validatePick(3, pick(1))
    expect(r.ok).toHaveLength(0)
    expect(r.rejection).toBe('count')
  })

  it('limit 3 files: through the hook, a fourth pick is not listed', () => {
    installStorage()
    const { result } = renderHook(() => useUpload())
    act(() => result.current.addFiles(pick(3)))
    expect(result.current.files).toHaveLength(3)
    expect(result.current.rejection).toBeNull()
    act(() => result.current.addFiles([file('fourth.mp4', MiB)]))
    expect(result.current.files).toHaveLength(3)
    expect(result.current.rejection).toBe('count')
  })
})
