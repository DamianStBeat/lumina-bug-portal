// The upload queue reducer (src/upload/queue.ts) on its own: one case per transition of its table, and one per stale
// answer it must drop (another generation, a file no longer listed, an old epoch) for each kind of answer. No React,
// no server: events in, state and effects out. The races two red team rounds found (bp-web-fix redteam-astra-2.md,
// redteam-opus-2.md) are here as transitions; queue-races.spec.ts checks the same rows through the hook.
import { describe, expect, it } from 'vitest'
import { busy, initial, reduce, resumeOf, unremoved, viewState, type Att, type Effect, type Event, type Stage, type State } from '../src/upload/queue'
import type { SavedFile, Session } from '../src/upload/session'
import { MiB, file } from './helpers'

const H1 = 'a'.repeat(64)
const H2 = 'b'.repeat(64)
const T = { code: 'LUM-482193', reportToken: 'tok' }
const OTHER = { code: 'LUM-482194', reportToken: 'tok2' }
const SIZE = 2 * MiB
const att = (id: string): Att => ({ attachmentId: id, partSize: MiB, partCount: 2 })
const vid = (name: string, size = SIZE) => file(name, size, 'video/mp4')
const saved = (name: string, head: string | null, a?: Att, o: { done?: boolean; removing?: true } = {}): SavedFile =>
  !a
    ? { name, size: SIZE, head, done: false, attachmentId: null }
    : o.removing
      ? { name, size: SIZE, head, done: o.done ?? false, ...a, removing: true }
      : { name, size: SIZE, head, done: o.done ?? false, ...a }
const session = (files: SavedFile[], t = T): Session => ({ v: 3, code: t.code, reportToken: t.reportToken, files })

let n = 0
const run = (s: State, ...events: Event[]): State => events.reduce(reduce, s)
const pickOf = (files: File[]): Extract<Event, { t: 'pick' }> => ({ t: 'pick', pick: ++n, files: files.map((f) => ({ key: `k${++n}`, file: f })) })
const fxOf = <K extends Effect['t']>(s: State, t: K) => s.fx.filter((f): f is Extract<Effect, { t: K }> => f.t === t)
const item = (s: State, name: string) => s.items.find((x) => x.file.name === name)
const keyOf = (s: State, name: string) => item(s, name)!.key
const names = (s: State) => s.items.map((x) => x.file.name)
const line = (s: State, name: string) => s.session?.files.find((f) => f.name === name)
// The answer helpers answer the effects `from` asked for (the last transition by default) on the state `s`.
// Every hash: by file name, H1 unless said otherwise.
function hashed(s: State, heads: Record<string, string | null> = {}, from = s): State {
  const headOf = (name: string) => (Object.hasOwn(heads, name) ? (heads[name] ?? null) : H1)
  return fxOf(from, 'hash').reduce((x, h) => reduce(x, { t: 'hashed', key: h.key, gen: h.gen, epoch: h.epoch, head: headOf(h.file.name) }), s)
}
const ready = (s: State, files: File[], heads?: Record<string, string | null>) => hashed(reduce(s, pickOf(files)), heads)
const created = (s: State, id: string, from = s): State => {
  const c = fxOf(from, 'create')[0]!
  return reduce(s, { t: 'created', key: c.key, gen: c.gen, epoch: c.epoch, att: att(id) })
}
const uploaded = (s: State): State => {
  const u = fxOf(s, 'upload')[0]!
  return reduce(s, { t: 'uploaded', key: u.key, gen: u.gen, epoch: u.epoch })
}
const deletedFx = (s: State, gone: boolean, from = s): State => {
  const d = fxOf(from, 'delete')[0]!
  return reduce(s, { t: 'deleted', id: d.id, epoch: d.epoch, by: d.by, gone })
}
// a.mp4 saved with attachment A (not done), picked again and bound to it, b.mp4 new.
const resumed = () => ready(initial(session([saved('a.mp4', H1, att('A'))])), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 })

describe('queue: the load', () => {
  it('mount: a marked line has its DELETE sent again in the background; answered gone its line is dropped', () => {
    const s0 = initial(session([saved('a.mp4', H1, att('A'), { removing: true }), saved('b.mp4', H2, att('B'))]))
    const s1 = reduce(s0, { t: 'mount' })
    expect(fxOf(s1, 'delete')).toEqual([{ t: 'delete', id: 'A', token: 'tok', epoch: 0, by: { k: 'load' } }])
    const s2 = deletedFx(s1, true)
    expect(s2.session?.files.map((f) => f.name)).toEqual(['b.mp4'])
    expect(fxOf(s2, 'save')).toEqual([{ t: 'save', session: s2.session }])
  })
  it('mount with nothing marked changes nothing', () => {
    const s0 = initial(session([saved('b.mp4', H2, att('B'))]))
    expect(reduce(s0, { t: 'mount' })).toBe(s0)
  })
  it('load DELETE not gone: the line stays marked and is noted as failed on this load', () => {
    const s = deletedFx(reduce(initial(session([saved('a.mp4', H1, att('A'), { removing: true })])), { t: 'mount' }), false)
    expect(line(s, 'a.mp4')).toMatchObject({ removing: true })
    expect(s.failed).toEqual(['A'])
  })
})

describe('queue: picks', () => {
  it('pick: listed at once as picked, not hashed yet, each file hashed', () => {
    const s = reduce(initial(null), pickOf([vid('a.mp4')]))
    expect(s.items).toMatchObject([{ step: 'picked', gen: 0 }])
    expect(s.items[0]!.head).toBeUndefined()
    expect(fxOf(s, 'hash')).toEqual([{ t: 'hash', key: s.items[0]!.key, gen: 0, epoch: 0, file: s.items[0]!.file }])
    expect(hashed(s).items[0]!.head).toBe(H1)
  })
  it('pick over the 3 places: the first 3 listed, the rest refused as count', () => {
    const s = reduce(initial(null), pickOf(['a', 'b', 'c', 'd'].map((x) => vid(`${x}.mp4`))))
    expect(names(s)).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
    expect(s.rejection).toBe('count')
  })
  it('pick of twins (same name and size): listed only once hashed; the same file twice is listed once', () => {
    const s1 = reduce(initial(null), pickOf([vid('a.mp4'), vid('a.mp4')]))
    expect(s1.items).toEqual([])
    expect(fxOf(s1, 'hash')).toHaveLength(2)
    expect(names(hashed(s1))).toEqual(['a.mp4'])
  })
  it('pick of twins with other bytes: both listed, in order', () => {
    const s1 = reduce(initial(null), pickOf([vid('a.mp4'), vid('a.mp4')]))
    const [h1, h2] = fxOf(s1, 'hash')
    const s2 = run(s1, { t: 'hashed', key: h2!.key, gen: 0, epoch: 0, head: H2 })
    expect(s2.items).toEqual([])
    const s3 = run(s2, { t: 'hashed', key: h1!.key, gen: 0, epoch: 0, head: H1 })
    expect(s3.items.map((x) => x.head)).toEqual([H1, H2])
  })
  it('pick while a Send is going: ignored', () => {
    const s = reduce(ready(initial(null), [vid('a.mp4')]), { t: 'send', target: T })
    expect(busy(s)).toBe(true)
    expect(reduce(s, pickOf([vid('b.mp4')]))).toBe(s)
  })
  it('bind: the re-picked saved file takes its attachment under a new generation, and onBack runs for the last missing', () => {
    const s0 = initial(session([saved('a.mp4', H1, att('A'))]))
    expect(resumeOf(s0)).toEqual({ code: T.code, missing: [{ name: 'a.mp4', size: SIZE }] })
    const p = pickOf([vid('a.mp4')])
    const s2 = hashed(reduce(s0, p))
    expect(item(s2, 'a.mp4')).toMatchObject({ att: att('A'), gen: 1, step: 'picked' })
    expect(fxOf(s2, 'back')).toEqual([{ t: 'back', pick: p.pick }])
    expect(resumeOf(s2)?.missing).toEqual([])
  })
  it('bind: a re-pick the browser could not hash never takes a saved attachment', () => {
    const s = ready(initial(session([saved('a.mp4', null, att('A'))])), [vid('a.mp4')], { 'a.mp4': null })
    expect(item(s, 'a.mp4')!.att).toBeUndefined()
    expect(item(s, 'a.mp4')!.head).toBeNull()
    expect(fxOf(s, 'back')).toEqual([])
  })
  it('bind: a saved done file comes back done', () => {
    const s = ready(initial(session([saved('a.mp4', H1, att('A'), { done: true })])), [vid('a.mp4')])
    expect(item(s, 'a.mp4')).toMatchObject({ step: 'done', confirmed: SIZE })
    expect(viewState(item(s, 'a.mp4')!)).toBe('done')
  })
  // X removed on the last visit, its DELETE failed again on this load, so it holds one of the 3 places.
  const stuckX = () => {
    const s0 = deletedFx(reduce(initial(session([saved('x.mp4', H2, att('X'), { removing: true })])), { t: 'mount' }), false)
    const s1 = ready(s0, [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 })
    const s2 = reduce(s1, pickOf([vid('c.mp4')]))
    expect(names(s2)).toEqual(['a.mp4', 'b.mp4'])
    return hashed(s2)
  }
  it('held: a pick that needs the place of a failed removed line sends its DELETE again; gone, the pick is listed', () => {
    const s = stuckX()
    expect(fxOf(s, 'delete')).toEqual([{ t: 'delete', id: 'X', token: 'tok', epoch: 0, by: { k: 'held' } }])
    expect(names(s)).toEqual(['a.mp4', 'b.mp4'])
    const s2 = deletedFx(s, true)
    expect(names(s2)).toEqual(['a.mp4', 'b.mp4', 'c.mp4'])
    expect(s2.rejection).toBeNull()
    expect(line(s2, 'x.mp4')).toBeUndefined()
  })
  it('held: that DELETE fails again: the pick is refused as count and the line stays marked', () => {
    const s2 = deletedFx(stuckX(), false)
    expect(names(s2)).toEqual(['a.mp4', 'b.mp4'])
    expect(s2.rejection).toBe('count')
    expect(line(s2, 'x.mp4')).toMatchObject({ removing: true })
  })
})

describe('queue: Remove', () => {
  it('remove of a file with no attachment: it leaves at once, with no DELETE', () => {
    const s0 = ready(initial(null), [vid('a.mp4')])
    const s = reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') })
    expect(s.items).toEqual([])
    expect(fxOf(s, 'forget')).toEqual([{ t: 'forget', key: keyOf(s0, 'a.mp4') }])
    expect(fxOf(s, 'delete')).toEqual([])
  })
  it('remove of a file with an attachment: removing, its line marked (saved before the DELETE), under a new generation', () => {
    const s0 = resumed()
    const s = reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') })
    expect(item(s, 'a.mp4')).toMatchObject({ step: 'removing', gen: 2 })
    expect(line(s, 'a.mp4')).toMatchObject({ removing: true })
    expect(s.fx.map((f) => f.t)).toEqual(['save', 'delete'])
    expect(fxOf(s, 'delete')[0]).toEqual({ t: 'delete', id: 'A', token: 'tok', epoch: 0, by: { k: 'remove', key: keyOf(s0, 'a.mp4'), gen: 2 } })
    expect(busy(s)).toBe(true)
  })
  it('remove answered gone: the file and its line go', () => {
    const s0 = resumed()
    const s = deletedFx(reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') }), true)
    expect(names(s)).toEqual(['b.mp4'])
    expect(line(s, 'a.mp4')).toBeUndefined()
  })
  it('remove not gone: unremoved, the line still marked, the orange line; Remove again sends it again', () => {
    const s0 = resumed()
    const k = keyOf(s0, 'a.mp4')
    const s = deletedFx(reduce(s0, { t: 'remove', key: k }), false)
    expect(item(s, 'a.mp4')?.step).toBe('unremoved')
    expect(viewState(item(s, 'a.mp4')!)).toBe('error')
    expect(unremoved(s)).toBe(true)
    expect(line(s, 'a.mp4')).toMatchObject({ removing: true })
    expect(fxOf(reduce(s, { t: 'remove', key: k }), 'delete')).toHaveLength(1)
  })
  it('remove of a done file does nothing', () => {
    const s0 = ready(initial(session([saved('a.mp4', H1, att('A'), { done: true })])), [vid('a.mp4')])
    const s = reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') })
    expect(s.items).toEqual(s0.items)
    expect(s.fx).toEqual([])
  })
  it('remove pressed while the file is hashed waits for the hash, then sends the DELETE, and onBack is not called', () => {
    const s1 = reduce(initial(session([saved('a.mp4', H1, att('A'))])), pickOf([vid('a.mp4')]))
    const s2 = reduce(s1, { t: 'remove', key: s1.items[0]!.key })
    expect(s2.fx).toEqual([])
    const s3 = hashed(s2, {}, s1)
    expect(fxOf(s3, 'delete').map((d) => d.id)).toEqual(['A'])
    expect(fxOf(s3, 'back')).toEqual([])
  })
  it('remove while a DELETE is out waits for it', () => {
    const s0 = resumed()
    const s1 = reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') })
    const s2 = reduce(s1, { t: 'remove', key: keyOf(s0, 'b.mp4') })
    expect(names(s2)).toEqual(['a.mp4', 'b.mp4'])
    expect(names(deletedFx(s2, true, s1))).toEqual([])
  })
})

describe('queue: Send', () => {
  it('send without a target or a saved session: ignored', () => {
    const s = ready(initial(null), [vid('a.mp4')])
    expect(reduce(s, { t: 'send' })).toBe(s)
  })
  it('send: every file written down before its attachment is asked for, then created one at a time', () => {
    const s = reduce(ready(initial(null), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 }), { t: 'send', target: T })
    expect(s.phase).toBe('uploading')
    expect(s.fx.map((f) => f.t)).toEqual(['save', 'create'])
    expect(s.session?.files.map((f) => [f.name, f.attachmentId])).toEqual([
      ['a.mp4', null],
      ['b.mp4', null],
    ])
    expect(fxOf(s, 'create')[0]).toMatchObject({ target: T, body: { filename: 'a.mp4', size: SIZE, mime: 'video/mp4' } })
    expect(s.items.map((x) => x.step)).toEqual(['creating', 'picked'])
  })
  it('created: the line takes the attachment and the upload starts', () => {
    const s0 = reduce(ready(initial(null), [vid('a.mp4')]), { t: 'send', target: T })
    const s = created(s0, 'A')
    expect(item(s, 'a.mp4')).toMatchObject({ step: 'uploading', att: att('A') })
    expect(line(s, 'a.mp4')).toMatchObject({ attachmentId: 'A' })
    expect(fxOf(s, 'upload')[0]).toMatchObject({ att: att('A'), token: 'tok', file: item(s, 'a.mp4')!.file })
  })
  it('confirmed: the bytes the server answered for', () => {
    const s0 = created(reduce(ready(initial(null), [vid('a.mp4')]), { t: 'send', target: T }), 'A')
    const u = fxOf(s0, 'upload')[0]!
    expect(item(reduce(s0, { t: 'confirmed', key: u.key, gen: u.gen, epoch: u.epoch, bytes: MiB }), 'a.mp4')!.confirmed).toBe(MiB)
  })
  it('uploaded: done, and the next file is created', () => {
    const s0 = created(reduce(ready(initial(null), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 }), { t: 'send', target: T }), 'A')
    const s = uploaded(s0)
    expect(item(s, 'a.mp4')).toMatchObject({ step: 'done', confirmed: SIZE })
    expect(line(s, 'a.mp4')?.done).toBe(true)
    expect(fxOf(s, 'create')[0]?.body.filename).toBe('b.mp4')
  })
  it('the last file uploaded: done, the session cleared', () => {
    const s = uploaded(created(reduce(ready(initial(null), [vid('a.mp4')]), { t: 'send', target: T }), 'A'))
    expect(s.phase).toBe('done')
    expect(s.send).toBeNull()
    expect(s.session).toBeNull()
    expect(fxOf(s, 'save')).toEqual([{ t: 'save', session: null }])
  })
  it('a saved file not picked again: the upload ends idle, the session kept for the resume hint', () => {
    const s0 = ready(initial(session([saved('z.mp4', H2, att('Z'))])), [vid('a.mp4')])
    const s = uploaded(created(reduce(s0, { t: 'send' }), 'A'))
    expect(s.phase).toBe('idle')
    expect(resumeOf(s)?.missing).toEqual([{ name: 'z.mp4', size: SIZE }])
  })
  it('a re-picked saved file resumes on its attachment, no create', () => {
    const s = reduce(ready(initial(session([saved('a.mp4', H1, att('A'))])), [vid('a.mp4')]), { t: 'send' })
    expect(fxOf(s, 'create')).toEqual([])
    expect(fxOf(s, 'upload')[0]).toMatchObject({ att: att('A') })
  })
  it('failed, Try again can pass: the error phase, the Send ends, and Try again sends it under a new generation', () => {
    const s0 = created(reduce(ready(initial(null), [vid('a.mp4')]), { t: 'send', target: T }), 'A')
    const u = fxOf(s0, 'upload')[0]!
    const s = reduce(s0, { t: 'failed', key: u.key, gen: u.gen, epoch: u.epoch, why: null })
    expect(s.phase).toBe('error')
    expect(viewState(item(s, 'a.mp4')!)).toBe('error')
    expect(s.send).toBeNull()
    expect(fxOf(reduce(s, { t: 'send' }), 'upload')[0]).toMatchObject({ gen: u.gen + 1 })
  })
  it('failed as a refusal: refused, idle, and Send stays ignored until it is removed', () => {
    const s0 = reduce(ready(initial(null), [vid('a.mp4')]), { t: 'send', target: T })
    const c = fxOf(s0, 'create')[0]!
    const s = reduce(s0, { t: 'failed', key: c.key, gen: c.gen, epoch: c.epoch, why: 'size' })
    expect(s.phase).toBe('idle')
    expect(viewState(item(s, 'a.mp4')!)).toBe('refused')
    expect(reduce(s, { t: 'send' })).toBe(s)
  })
  it('send while a Send is going: ignored', () => {
    const s = reduce(ready(initial(null), [vid('a.mp4')]), { t: 'send', target: T })
    expect(reduce(s, { t: 'send', target: T })).toBe(s)
  })
  it('send to another report: no attachment of the saved one is reused', () => {
    const s = reduce(ready(initial(session([saved('a.mp4', H1, att('A'))], OTHER)), [vid('a.mp4')]), { t: 'send', target: T })
    expect(fxOf(s, 'upload')).toEqual([])
    expect(fxOf(s, 'create')).toHaveLength(1)
    expect(s.session).toMatchObject({ code: T.code, files: [{ name: 'a.mp4', attachmentId: null }] })
  })
})

describe('queue: Remove and Send together (rows 1 and 2)', () => {
  it('row 1 (a): Remove mid-upload stops its upload before its DELETE, and nothing starts until that DELETE is answered', () => {
    const s0 = created(reduce(ready(initial(null), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 }), { t: 'send', target: T }), 'A')
    const s1 = reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') })
    expect(s1.fx.map((f) => f.t)).toEqual(['save', 'abort', 'delete'])
    expect(fxOf(s1, 'create')).toEqual([])
    const s2 = deletedFx(s1, true)
    expect(names(s2)).toEqual(['b.mp4'])
    expect(fxOf(s2, 'create')[0]?.body.filename).toBe('b.mp4')
    const s3 = uploaded(created(s2, 'B'))
    expect(s3.phase).toBe('done')
    expect(s3.session).toBeNull()
  })
  it('row 1: Remove while its create is out: the attachment it gets is deleted at once, never uploaded', () => {
    const s0 = reduce(ready(initial(null), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 }), { t: 'send', target: T })
    const s1 = reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') })
    expect(item(s1, 'a.mp4')?.step).toBe('removing')
    // Lead's decision (brief-build-4 item 1): its open line leaves storage at once, so no reload asks for it.
    expect(line(s0, 'a.mp4')).toMatchObject({ attachmentId: null })
    expect(line(s1, 'a.mp4')).toBeUndefined()
    expect(s1.session?.files.map((f) => f.name)).toEqual(['b.mp4'])
    expect(s1.fx).toEqual([{ t: 'save', session: s1.session }])
    const s2 = created(s1, 'A', s0)
    expect(fxOf(s2, 'upload')).toEqual([])
    expect(fxOf(s2, 'delete')[0]).toMatchObject({ id: 'A', by: { k: 'remove', gen: item(s1, 'a.mp4')!.gen + 1 } })
    expect(line(s2, 'a.mp4')).toMatchObject({ attachmentId: 'A', removing: true })
    expect(fxOf(deletedFx(s2, true), 'create')[0]?.body.filename).toBe('b.mp4')
  })
  it('row 1: Remove while its create is out, and the create fails: it leaves, nothing to delete, the next file goes', () => {
    const s0 = reduce(ready(initial(null), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 }), { t: 'send', target: T })
    const c = fxOf(s0, 'create')[0]!
    const s = run(s0, { t: 'remove', key: c.key }, { t: 'failed', key: c.key, gen: c.gen, epoch: c.epoch, why: null })
    expect(names(s)).toEqual(['b.mp4'])
    expect(fxOf(s, 'delete')).toEqual([])
    expect(fxOf(s, 'create')[0]?.body.filename).toBe('b.mp4')
  })
  it('row 1 (c): Send pressed while a DELETE is out waits; answered gone, the others go', () => {
    const s0 = resumed()
    const s1 = reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') })
    const s2 = reduce(s1, { t: 'send', target: T })
    expect(s2.phase).toBe('idle')
    expect(s2.fx).toEqual([])
    const s3 = deletedFx(s2, true, s1)
    expect(s3.phase).toBe('uploading')
    expect(s3.session?.files.map((f) => f.name)).toEqual(['b.mp4'])
    expect(fxOf(s3, 'create')[0]?.body.filename).toBe('b.mp4')
  })
  it('row 1 (b): the DELETE of a file Removed before Send fails: that file stays out of the Send, the others reach done, its line stays marked', () => {
    const s0 = resumed()
    const s1 = reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') })
    const s2 = deletedFx(reduce(s1, { t: 'send', target: T }), false, s1)
    expect(item(s2, 'a.mp4')?.step).toBe('unremoved')
    expect(fxOf(s2, 'upload')).toEqual([])
    expect(fxOf(s2, 'create')[0]?.body.filename).toBe('b.mp4')
    const s3 = uploaded(created(s2, 'B'))
    expect(s3.phase).toBe('done')
    expect(s3.session?.files).toEqual([saved('a.mp4', H1, att('A'), { removing: true })])
  })
  it('row 1 (b): Remove queued behind the hash, then Send: the file never goes up when its DELETE fails', () => {
    const s1 = reduce(initial(session([saved('a.mp4', H1, att('A'))])), pickOf([vid('a.mp4')]))
    const s2 = run(s1, { t: 'remove', key: s1.items[0]!.key }, { t: 'send', target: T })
    const s3 = hashed(s2, {}, s1)
    expect(fxOf(s3, 'delete')).toHaveLength(1)
    const s4 = deletedFx(s3, false)
    expect(fxOf(s4, 'upload')).toEqual([])
    expect(s4.phase).toBe('done')
    expect(line(s4, 'a.mp4')).toMatchObject({ removing: true })
  })
  it('a file whose Remove failed before Send was pressed goes up with the rest, its line no longer marked', () => {
    const s0 = resumed()
    const s1 = deletedFx(reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') }), false)
    const s2 = reduce(s1, { t: 'send', target: T })
    expect(unremoved(s2)).toBe(false)
    expect(line(s2, 'a.mp4')).toEqual(saved('a.mp4', H1, att('A')))
    expect(fxOf(s2, 'upload')[0]).toMatchObject({ att: att('A') })
  })
})

describe('queue: reset and unmount', () => {
  it('reset: a new epoch, every request stopped, the list and the session cleared', () => {
    const s0 = reduce(resumed(), { t: 'send', target: T })
    const s = reduce(s0, { t: 'reset' })
    expect(s).toMatchObject({ epoch: 1, items: [], jobs: [], send: null, session: null, target: null, phase: 'idle' })
    expect(s.fx.map((f) => f.t)).toEqual(['save', 'stop', 'forget', 'forget'])
  })
  it('reset with nothing held still clears storage (another report may be saved there)', () => {
    expect(reduce(initial(null), { t: 'reset' }).fx).toEqual([{ t: 'stop' }, { t: 'save', session: null }])
  })
  it('closed (unmount): a new epoch and every request stopped, the session left as it is', () => {
    const s0 = reduce(resumed(), { t: 'send', target: T })
    const s = reduce(s0, { t: 'closed' })
    expect(s.epoch).toBe(1)
    expect(s.session).toBe(s0.session)
    expect(fxOf(s, 'save')).toEqual([])
    expect(fxOf(s, 'stop')).toHaveLength(1)
  })
  it('row 2: a DELETE answered after unmount writes nothing', () => {
    const s0 = resumed()
    const s1 = reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') })
    const s2 = reduce(s1, { t: 'closed' })
    const d = fxOf(s1, 'delete')[0]!
    for (const gone of [true, false]) expect(reduce(s2, { t: 'deleted', id: d.id, epoch: d.epoch, by: d.by, gone })).toBe(s2)
  })
  it('row 2: a background DELETE of the load answered after unmount writes nothing, its line stays marked', () => {
    const s1 = reduce(initial(session([saved('a.mp4', H1, att('A'), { removing: true })])), { t: 'mount' })
    const s2 = reduce(s1, { t: 'closed' })
    const d = fxOf(s1, 'delete')[0]!
    for (const gone of [true, false]) expect(reduce(s2, { t: 'deleted', id: d.id, epoch: d.epoch, by: d.by, gone })).toBe(s2)
    expect(line(s2, 'a.mp4')).toMatchObject({ removing: true })
  })
})

// Each answer, valid once, then stale three ways. Built after a reset, so the state is at epoch 1 and an answer of
// epoch 0 is one the page asked for before it.
describe('queue: stale answers are dropped (the same state object)', () => {
  type Case = { s: State; ev: Event; gone: (s: State) => State }
  const fresh = () => reduce(initial(null), { t: 'reset' })
  const sending = () => reduce(ready(fresh(), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 }), { t: 'send', target: T })
  const upload = () => created(sending(), 'A')
  // The file leaves the list through a Remove answered gone (its upload stopped first).
  const removeGone = (s: State) => deletedFx(reduce(s, { t: 'remove', key: keyOf(s, 'a.mp4') }), true)
  const cases: Record<string, () => Case> = {
    'hash answered': () => {
      const s = reduce(fresh(), pickOf([vid('a.mp4')]))
      const h = fxOf(s, 'hash')[0]!
      const ev: Event = { t: 'hashed', key: h.key, gen: h.gen, epoch: h.epoch, head: H1 }
      return { s, ev, gone: (x) => reduce(reduce(x, ev), { t: 'remove', key: h.key }) }
    },
    created: () => {
      const s = sending()
      const c = fxOf(s, 'create')[0]!
      const ev: Event = { t: 'created', key: c.key, gen: c.gen, epoch: c.epoch, att: att('A') }
      return { s, ev, gone: (x) => deletedFx(reduce(reduce(x, { t: 'remove', key: c.key }), ev), true) }
    },
    'part done': () => {
      const s = upload()
      const u = fxOf(s, 'upload')[0]!
      return { s, ev: { t: 'confirmed', key: u.key, gen: u.gen, epoch: u.epoch, bytes: MiB }, gone: removeGone }
    },
    completed: () => {
      const s = upload()
      const u = fxOf(s, 'upload')[0]!
      return { s, ev: { t: 'uploaded', key: u.key, gen: u.gen, epoch: u.epoch }, gone: removeGone }
    },
    // Red team r1 (Astra, queue.ts:31): where the uploader says the upload is (here: the network lost).
    stage: () => {
      const s = upload()
      const u = fxOf(s, 'upload')[0]!
      return { s, ev: { t: 'stage', key: u.key, gen: u.gen, epoch: u.epoch, stage: 'paused' }, gone: removeGone }
    },
    // Red team r1 (Astra, test gap): a failed upload, Try again can pass it.
    failed: () => {
      const s = upload()
      const u = fxOf(s, 'upload')[0]!
      return { s, ev: { t: 'failed', key: u.key, gen: u.gen, epoch: u.epoch, why: null }, gone: removeGone }
    },
    'delete answered': () => {
      const u = upload()
      const s = reduce(u, { t: 'remove', key: keyOf(u, 'a.mp4') })
      const d = fxOf(s, 'delete')[0]!
      const ev: Event = { t: 'deleted', id: d.id, epoch: d.epoch, by: d.by, gone: true }
      return { s, ev, gone: (x) => reduce(x, ev) }
    },
  }
  const older = (ev: Event, d: { gen?: number; epoch?: number }): Event => {
    if (ev.t === 'deleted' && ev.by.k === 'remove') {
      return { ...ev, epoch: ev.epoch + (d.epoch ?? 0), by: { ...ev.by, gen: ev.by.gen + (d.gen ?? 0) } }
    }
    if (!('gen' in ev)) throw new Error('not an answer')
    return { ...ev, gen: ev.gen + (d.gen ?? 0), epoch: ev.epoch + (d.epoch ?? 0) }
  }
  describe.each(Object.keys(cases))('%s', (name) => {
    const make = cases[name]!
    it('control: the answer of the current generation and epoch changes the state', () => {
      const { s, ev } = make()
      expect(reduce(s, ev)).not.toBe(s)
    })
    it('another generation: dropped', () => {
      const { s, ev } = make()
      expect(reduce(s, older(ev, { gen: -1 }))).toBe(s)
      expect(reduce(s, older(ev, { gen: 1 }))).toBe(s)
    })
    it('a file no longer listed: dropped', () => {
      const { s, ev, gone } = make()
      const g = gone(s)
      expect(names(g)).not.toContain('a.mp4')
      expect(reduce(g, ev)).toBe(g)
    })
    it('an old epoch (an answer from before reset or unmount): dropped', () => {
      const { s, ev } = make()
      expect(s.epoch).toBe(1)
      expect(reduce(s, older(ev, { epoch: -1 }))).toBe(s)
    })
  })

  // Red team r1 (Astra, test gap): the failure of the attempt before a Try again lands on the retried upload.
  it('failed of an old generation against the retried upload of the same file: dropped, the retry goes on', () => {
    const s0 = upload()
    const u = fxOf(s0, 'upload')[0]!
    const ev: Event = { t: 'failed', key: u.key, gen: u.gen, epoch: u.epoch, why: null }
    const s1 = reduce(s0, ev)
    expect(item(s1, 'a.mp4')?.step).toBe('failed')
    const s2 = reduce(s1, { t: 'send' })
    expect(item(s2, 'a.mp4')).toMatchObject({ step: 'uploading', gen: u.gen + 1 })
    expect(fxOf(s2, 'upload')[0]).toMatchObject({ key: u.key, gen: u.gen + 1 })
    expect(reduce(s2, ev)).toBe(s2)
    // Its refusal too: an old "refused" never turns the retried upload into a refused file.
    expect(reduce(s2, { ...ev, why: 'size' })).toBe(s2)
  })
})

// Red team r1 (bp-web-upload redteam-opus.md, redteam-astra.md; brief-build-4): the transitions that fix adds or
// changes, one case each. completing and paused are the brief's states; the page shows both as uploading.
describe('queue: completing, paused, and Remove wins at once', () => {
  const sending = () => created(reduce(ready(initial(null), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 }), { t: 'send', target: T }), 'A')
  const ticketOf = (s: State) => {
    const u = fxOf(s, 'upload')[0]!
    return { key: u.key, gen: u.gen, epoch: u.epoch }
  }
  const stage = (s: State, t: ReturnType<typeof ticketOf>, st: Stage) => reduce(s, { t: 'stage', ...t, stage: st })

  it('uploading → completing: shown as uploading, nothing else starts; uploaded from there: done, the next file created', () => {
    const s0 = sending()
    const t = ticketOf(s0)
    const s1 = stage(s0, t, 'completing')
    expect(item(s1, 'a.mp4')?.step).toBe('completing')
    expect(viewState(item(s1, 'a.mp4')!)).toBe('uploading')
    expect(s1.fx).toEqual([])
    const s2 = reduce(s1, { t: 'uploaded', ...t })
    expect(item(s2, 'a.mp4')).toMatchObject({ step: 'done', confirmed: SIZE })
    expect(fxOf(s2, 'create')[0]?.body.filename).toBe('b.mp4')
  })
  it('completing → uploading: the parts the server lost go again, the file still uploading', () => {
    const s0 = sending()
    const t = ticketOf(s0)
    const s2 = stage(stage(s0, t, 'completing'), t, 'uploading')
    expect(item(s2, 'a.mp4')?.step).toBe('uploading')
    expect(s2.fx).toEqual([])
  })
  it('uploading → paused → uploading: the network lost and back; shown as uploading, nothing else starts, a part confirmed meanwhile counts', () => {
    const s0 = sending()
    const t = ticketOf(s0)
    const s1 = stage(s0, t, 'paused')
    expect(item(s1, 'a.mp4')?.step).toBe('paused')
    expect(viewState(item(s1, 'a.mp4')!)).toBe('uploading')
    expect(s1.fx).toEqual([])
    expect(item(reduce(s1, { t: 'confirmed', ...t, bytes: MiB }), 'a.mp4')?.confirmed).toBe(MiB)
    expect(item(stage(s1, t, 'uploading'), 'a.mp4')?.step).toBe('uploading')
  })
  it('completing → paused → completing: the network lost while the complete is out comes back to completing', () => {
    const s0 = sending()
    const t = ticketOf(s0)
    const s1 = stage(stage(s0, t, 'completing'), t, 'paused')
    expect(item(s1, 'a.mp4')?.step).toBe('paused')
    expect(item(stage(s1, t, 'completing'), 'a.mp4')?.step).toBe('completing')
  })
  it('paused, the retries spent: failed as before, the error phase, Try again sends it under a new generation', () => {
    const s0 = sending()
    const t = ticketOf(s0)
    const s1 = reduce(stage(s0, t, 'paused'), { t: 'failed', ...t, why: null })
    expect(item(s1, 'a.mp4')?.step).toBe('failed')
    expect(s1.phase).toBe('error')
    expect(fxOf(reduce(s1, { t: 'send' }), 'upload')[0]).toMatchObject({ gen: t.gen + 1 })
  })
  it('a stage for a file whose upload is not going (picked, done) changes nothing', () => {
    const s0 = sending()
    const b = item(s0, 'b.mp4')!
    expect(stage(s0, { key: b.key, gen: b.gen, epoch: 0 }, 'paused')).toBe(s0)
    const t = ticketOf(s0)
    const s1 = reduce(s0, { t: 'uploaded', ...t })
    expect(stage(s1, t, 'completing')).toBe(s1)
  })
  it('Remove while completing: the complete is stopped at once, before the DELETE; its answer is dropped; gone, the next file goes', () => {
    const s0 = sending()
    const t = ticketOf(s0)
    const s1 = stage(s0, t, 'completing')
    const s2 = reduce(s1, { t: 'remove', key: t.key })
    expect(s2.fx.map((f) => f.t)).toEqual(['save', 'abort', 'delete'])
    expect(item(s2, 'a.mp4')?.step).toBe('removing')
    expect(reduce(s2, { t: 'uploaded', ...t })).toBe(s2)
    const s3 = deletedFx(s2, true)
    expect(names(s3)).toEqual(['b.mp4'])
    expect(fxOf(s3, 'create')[0]?.body.filename).toBe('b.mp4')
  })
  it('Remove while paused: the upload is stopped at once and its DELETE goes', () => {
    const s0 = sending()
    const t = ticketOf(s0)
    const s2 = reduce(stage(s0, t, 'paused'), { t: 'remove', key: t.key })
    expect(s2.fx.map((f) => f.t)).toEqual(['save', 'abort', 'delete'])
    expect(item(s2, 'a.mp4')?.step).toBe('removing')
  })

  // a.mp4 and b.mp4 saved with attachments A and B, both picked again and sent: a.mp4 uploading, b.mp4 waiting.
  const bothSent = () =>
    reduce(
      ready(initial(session([saved('a.mp4', H1, att('A')), saved('b.mp4', H2, att('B'))])), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 }),
      { t: 'send', target: T },
    )
  it('Remove of an uploading file while another DELETE is out: aborted at once; its answers are dropped; its DELETE goes once the other is answered', () => {
    const s0 = bothSent()
    const t = ticketOf(s0)
    expect(item(s0, 'a.mp4')?.step).toBe('uploading')
    const s1 = reduce(s0, { t: 'remove', key: keyOf(s0, 'b.mp4') })
    expect(fxOf(s1, 'delete').map((d) => d.id)).toEqual(['B'])
    const s2 = reduce(s1, { t: 'remove', key: t.key })
    expect(s2.fx).toEqual([{ t: 'abort', key: t.key }])
    const answers: Event[] = [
      { t: 'uploaded', ...t },
      { t: 'failed', ...t, why: null },
      { t: 'confirmed', ...t, bytes: MiB },
      { t: 'stage', ...t, stage: 'completing' },
    ]
    for (const ev of answers) expect(reduce(s2, ev)).toBe(s2)
    const s3 = deletedFx(s2, true, s1)
    expect(fxOf(s3, 'delete')).toEqual([{ t: 'delete', id: 'A', token: 'tok', epoch: 0, by: { k: 'remove', key: t.key, gen: t.gen + 1 } }])
    expect(fxOf(s3, 'abort')).toEqual([])
    expect(line(s3, 'a.mp4')).toMatchObject({ removing: true })
    expect(reduce(s3, { t: 'uploaded', ...t })).toBe(s3)
    const s4 = deletedFx(s3, true)
    expect(names(s4)).toEqual([])
    expect(s4.phase).toBe('done')
    expect(s4.session).toBeNull()
  })

  it('Remove while its create is out: its open line leaves the session at once (saved), so a reload never asks for it; the create is not stopped', () => {
    const s0 = reduce(ready(initial(null), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 }), { t: 'send', target: T })
    const s1 = reduce(s0, { t: 'remove', key: keyOf(s0, 'a.mp4') })
    expect(line(s1, 'a.mp4')).toBeUndefined()
    expect(fxOf(s1, 'save')).toEqual([{ t: 'save', session: s1.session }])
    expect(fxOf(s1, 'abort')).toEqual([])
    expect(resumeOf({ session: s1.session, items: [] })?.missing).toEqual([{ name: 'b.mp4', size: SIZE }])
  })

  // b.mp4 saved with attachment B, a.mp4 new; both sent: a.mp4's create out. Remove b.mp4 (its DELETE out), then
  // Remove a.mp4, which waits for it.
  const queuedWhileCreating = () => {
    const s0 = reduce(ready(initial(session([saved('b.mp4', H2, att('B'))])), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 }), { t: 'send', target: T })
    expect(item(s0, 'a.mp4')?.step).toBe('creating')
    const s1 = reduce(s0, { t: 'remove', key: keyOf(s0, 'b.mp4') })
    expect(fxOf(s1, 'delete').map((d) => d.id)).toEqual(['B'])
    const s2 = reduce(s1, { t: 'remove', key: keyOf(s0, 'a.mp4') })
    expect(line(s2, 'a.mp4')).toBeUndefined()
    return { s0, s1, s2 }
  }
  it('created for a file whose Remove waits behind another DELETE: no upload, the attachment written down marked, its turn deletes it', () => {
    const { s0, s1, s2 } = queuedWhileCreating()
    const s3 = created(s2, 'A', s0)
    expect(fxOf(s3, 'upload')).toEqual([])
    expect(fxOf(s3, 'delete')).toEqual([])
    expect(line(s3, 'a.mp4')).toMatchObject({ attachmentId: 'A', removing: true })
    const s4 = deletedFx(s3, true, s1)
    expect(fxOf(s4, 'delete')[0]).toMatchObject({ id: 'A', by: { k: 'remove', key: keyOf(s0, 'a.mp4') } })
    expect(fxOf(s4, 'upload')).toEqual([])
    const s5 = deletedFx(s4, true)
    expect(names(s5)).toEqual([])
    expect(line(s5, 'a.mp4')).toBeUndefined()
  })
  it('the create of a file whose Remove waits behind another DELETE fails: it leaves at once, nothing to delete', () => {
    const { s0, s1, s2 } = queuedWhileCreating()
    const c = fxOf(s0, 'create')[0]!
    const s3 = reduce(s2, { t: 'failed', key: c.key, gen: c.gen, epoch: c.epoch, why: null })
    expect(names(s3)).toEqual(['b.mp4'])
    expect(fxOf(s3, 'delete')).toEqual([])
    expect(names(deletedFx(s3, true, s1))).toEqual([])
  })

  it('page left while a removed file\'s create is out: that create is kept; its answer afterwards sends its DELETE once and writes nothing', () => {
    const s0 = reduce(ready(initial(null), [vid('a.mp4'), vid('b.mp4')], { 'b.mp4': H2 }), { t: 'send', target: T })
    const c = fxOf(s0, 'create')[0]!
    const ans: Event = { t: 'created', key: c.key, gen: c.gen, epoch: c.epoch, att: att('A') }
    // Not removed: the create is stopped and its answer dropped, as before.
    const kept = reduce(s0, { t: 'closed' })
    expect(fxOf(kept, 'stop')).toEqual([{ t: 'stop' }])
    expect(reduce(kept, ans)).toBe(kept)

    const s1 = reduce(s0, { t: 'remove', key: c.key })
    const s2 = reduce(s1, { t: 'closed' })
    expect(fxOf(s2, 'stop')).toEqual([{ t: 'stop', keep: [c.key] }])
    expect(fxOf(s2, 'save')).toEqual([])
    const s3 = reduce(s2, ans)
    expect(s3.fx).toEqual([{ t: 'delete', id: 'A', token: 'tok', epoch: 0, by: { k: 'left' } }])
    expect(s3.session).toBe(s2.session)
    expect(reduce(s3, ans)).toBe(s3)
    for (const gone of [true, false]) expect(reduce(s3, { t: 'deleted', id: 'A', epoch: 0, by: { k: 'left' }, gone })).toBe(s3)
    // A reset keeps it the same way.
    expect(fxOf(reduce(s1, { t: 'reset' }), 'stop')).toEqual([{ t: 'stop', keep: [c.key] }])
  })
})
