// The upload queue as one pure state machine, reduce(state, event) → state: no React, no I/O, no timers, no clock.
// The hook dispatches the player's actions and the answers of the requests it ran, and runs the effects of `fx` in
// order; it decides nothing again. Every answer is checked against the state it lands in, so a late one cannot undo
// what happened since (the races of two red team rounds: Remove vs Send, Remove after unmount).
//
// Per file (Item, by client key):
//   picked ─Send→ creating ─created→ uploading ─uploaded→ done · creating|uploading ─failed→ failed (why: a refusal,
//   or none when Try again can pass) · not done ─Remove→ removing ─gone→ leaves the list · ─not gone→ unremoved
//   (orange line, line still marked, holds its place) ─Remove→ removing · unremoved ─Send pressed after→ picked.
//   creating ─Remove→ removing without an attachment: its create answer is awaited and then deleted (an attachment
//   never deleted would hold one of the 3 places); a failed create just leaves.
// Picks, binds and Removes are jobs run in the order they were made. A Send waits while a job is queued or a file is
// removing, starts one file at a time and none while a file is removing; a file removed since it was pressed (or still
// removing then) is never part of it, even when its DELETE fails. It ends done, idle (a saved file not picked again)
// or error. Stale: every answer carries the key, generation and epoch of its effect. The generation moves on Remove, on
// every Send and on a re-pick binding a saved attachment; the epoch on reset and unmount. An answer of another
// generation, for a file no longer listed, or of an old epoch returns the same state object: the hook runs nothing.
//
// Left to the hook: the parts of one file (uploader.ts: 3 in flight, 5 retries, waiting for 'online', complete and its
// missing parts) as one `upload` effect, files one at a time, so 3 parts in flight overall (no paused state here: the
// last failure of a network loss arrives as `failed`); hashing; what a DELETE answer means (`gone`: 2xx { ok: true }
// or 404); refusalOf; storage; previews. Decided here: resume matching and the places held by saved and removed lines.
import type { SavedFile, Session } from './session'
import { validatePick, type Rejection } from './validate'

// Why the server turned a file down for good: one of the pick-time reasons, or any other refusal ('other').
export type Refusal = Rejection | 'other'
export type Att = { attachmentId: string; partSize: number; partCount: number }
export type Target = { code: string; reportToken: string }
export type Phase = 'idle' | 'uploading' | 'error' | 'done'
export type Step = 'picked' | 'creating' | 'uploading' | 'done' | 'failed' | 'removing' | 'unremoved'
// `head` (session.ts): undefined while still being hashed ("not yet", never a match), null when the browser could not
// hash it. `why` only on a failed file the server refused.
export type Item = { key: string; file: File; head?: string | null; att?: Att; gen: number; step: Step; confirmed: number }
  & { why?: Refusal }
type Hashing = { key: string; file: File; gen: number; head?: string | null }
type Free = { at: string; tries: string[]; need: number; freed: number }
// bind: a pick listed at once, matched to saved lines once hashed. pick: listed only once hashed; `free` while the
// DELETE of a held line it needs is out.
type Job =
  | { k: 'bind'; pick: number; files: Hashing[] }
  | { k: 'pick'; pick: number; files: Hashing[]; free?: Free }
  | { k: 'remove'; key: string }
// `keys`: null while waiting, then the files it sends, in order. `out`: files never part of it.
type Send = { target: Target; keys: string[] | null; out: string[] }
export type Ticket = { key: string; gen: number; epoch: number }
export type DeleteBy = { k: 'remove'; key: string; gen: number } | { k: 'load' } | { k: 'held' }
export type Effect =
  | ({ t: 'hash'; file: File } & Ticket)
  | ({ t: 'create'; target: Target; body: { filename: string; size: number; mime: string } } & Ticket)
  | ({ t: 'upload'; file: File; att: Att; token: string } & Ticket)
  // Stops the upload of that file: no part and no complete is sent for it from now on.
  | { t: 'abort'; key: string }
  | { t: 'delete'; id: string; token: string; epoch: number; by: DeleteBy }
  | { t: 'save'; session: Session | null }
  // The pick brought back the last saved file still missing: the hook calls its onBack. forget: revoke the preview.
  | { t: 'back'; pick: number }
  | { t: 'forget'; key: string }
  // reset or unmount: abort every create and upload. A DELETE is let reach the server; its marked line has the next
  // load send it again.
  | { t: 'stop' }
export type Event =
  | { t: 'mount' }
  | { t: 'reset' }
  | { t: 'closed' }
  | { t: 'pick'; pick: number; files: { key: string; file: File }[] }
  | { t: 'remove'; key: string }
  | { t: 'send'; target?: Target }
  | ({ t: 'hashed'; head: string | null } & Ticket)
  | ({ t: 'created'; att: Att } & Ticket)
  | ({ t: 'confirmed'; bytes: number } & Ticket)
  | ({ t: 'uploaded' } & Ticket)
  | ({ t: 'failed'; why: Refusal | null } & Ticket)
  | { t: 'deleted'; id: string; epoch: number; by: DeleteBy; gone: boolean }
// `failed`: attachments of removed lines whose DELETE failed on this load. `fx`: what the last transition asks for.
export type State = { epoch: number; session: Session | null; target: Target | null; items: Item[]; jobs: Job[] }
  & { send: Send | null; phase: Phase; rejection: Rejection | null; failed: string[]; fx: Effect[] }
export type Resume = { code: string; missing: { name: string; size: number }[] }
type Ident = { name: string; size: number; head: string | null }

// `session`: the saved upload the page may use (the hook drops another report's first).
export const initial = (session: Session | null): State => ({
  epoch: 0, session, target: null, items: [], jobs: [], send: null, phase: 'idle', rejection: null, failed: [], fx: [],
})

// The same file: name, size and the hash of its first 1 MiB (lastModified changes on every iPhone export). An
// unhashable file never binds to a line with an attachment: name and size cannot tell two videos apart, and resuming
// would put one video's parts after another's. A line with no attachment has no bytes on the server, so it may match.
const sameFile = (a: Ident | null, b: Ident & { attachmentId?: string | null }) =>
  a !== null && a.name === b.name && a.size === b.size && a.head === b.head && (a.head !== null || !b.attachmentId)
const idOf = (e: { file: File; head?: string | null }): Ident | null =>
  e.head === undefined ? null : { name: e.file.name, size: e.file.size, head: e.head }
// Name and size alone: maybe the same file, which only the hashes can tell.
const twins = (a: { name: string; size: number }, b: { name: string; size: number }) =>
  a.name === b.name && a.size === b.size
// Removed, its DELETE not answered gone yet: no longer one of the report's files, still holding a place.
const marked = (f: SavedFile): boolean => f.attachmentId !== null && f.removing === true
const unmark = (f: SavedFile): SavedFile => {
  if (f.attachmentId === null) return f
  const { name, size, head, done, attachmentId, partSize, partCount } = f
  return { name, size, head, done, attachmentId, partSize, partCount }
}
const attOf = (f: SavedFile): Att | undefined =>
  f.attachmentId === null ? undefined : { attachmentId: f.attachmentId, partSize: f.partSize, partCount: f.partCount }
// An open line no re-pick can bind to (above): a listed file of its name and size answers it in the resume hint and in
// Send's "done"; it goes up as a new file while the old attachment holds its place.
const blind = (f: SavedFile) => f.head === null && f.attachmentId !== null && !f.done && f.removing !== true
const answered = (f: SavedFile, list: Item[]) => blind(f) && list.some((e) => twins(e.file, f))
// The line of a listed file: by its attachment once it has one, since a removed line may share its name.
const lineOf = (e: Item) => (f: SavedFile) =>
  e.att ? f.attachmentId === e.att.attachmentId : !marked(f) && sameFile(idOf(e), f)
// Lines no listed file stands for: each holds a place on the server, so it counts against the 3.
const heldBy = (s: Session | null, list: Item[]) =>
  s ? s.files.filter((f) => !list.some((e) => lineOf(e)(f))).length : 0
// Held removed lines whose DELETE failed on this load: sending it again may free their places.
const stuck = (s: Session | null, list: Item[], failed: string[]): string[] =>
  (s?.files ?? []).flatMap((f) =>
    marked(f) && f.attachmentId !== null && failed.includes(f.attachmentId) && !list.some((e) => lineOf(e)(f))
      ? [f.attachmentId]
      : [],
  )

// Shown while the session has unfinished files; `missing`: the ones not picked again. A removed one is never asked for.
export function resumeOf({ session: s, items }: Pick<State, 'session' | 'items'>): Resume | null {
  const open = s ? s.files.filter((f) => !f.done && !marked(f)) : []
  if (!s || open.length === 0) return null
  const missing = open.filter((f) => !answered(f, items) && !items.some((e) => sameFile(idOf(e), f)))
  return { code: s.code, missing: missing.map(({ name, size }) => ({ name, size })) }
}
// While true the page takes no pick: a Send is going (or waiting) or a file's DELETE is out.
export const busy = (s: State) => s.send !== null || s.items.some((x) => x.step === 'removing')
export const unremoved = (s: State) => s.items.some((x) => x.step === 'unremoved')
// What the list shows ('error': Try again can pass it; 'refused': only Remove can).
export function viewState(it: Item): 'waiting' | 'uploading' | 'done' | 'error' | 'refused' {
  if (it.step === 'uploading' || it.step === 'done') return it.step
  if (it.step === 'failed') return it.why ? 'refused' : 'error'
  return it.step === 'unremoved' ? 'error' : 'waiting'
}

const setItem = (s: State, key: string, p: Partial<Item>): State =>
  ({ ...s, items: s.items.map((x) => (x.key === key ? { ...x, ...p } : x)) })
const lines = (s: State, f: (l: SavedFile[]) => SavedFile[]): Session | null =>
  s.session && { ...s.session, files: f(s.session.files) }
const live = (s: State, t: Ticket): Item | undefined =>
  t.epoch === s.epoch ? s.items.find((x) => x.key === t.key && x.gen === t.gen) : undefined
const removing = (s: State) => s.items.some((x) => x.step === 'removing')
// The file leaves the list and its line the session.
function leave(s: State, it: Item, fx: Effect[]): State {
  fx.push({ t: 'forget', key: it.key })
  const session = lines(s, (l) => l.filter((f) => !lineOf(it)(f)))
  return { ...s, items: s.items.filter((x) => x.key !== it.key), session }
}

export function reduce(s: State, e: Event): State {
  const fx: Effect[] = []
  const n = apply(s, e, fx)
  if (n === s) return s
  const out = advance(n, fx)
  // One writer of the session: every change is saved, before the requests it was written down for.
  if (out.session !== s.session && !fx.some((f) => f.t === 'save')) fx.unshift({ t: 'save', session: out.session })
  return { ...out, fx }
}

function apply(s: State, e: Event, fx: Effect[]): State {
  switch (e.t) {
    case 'mount': {
      // A Remove whose answer the last visit never saw is sent again in the background (picks and Send go on).
      const ids = (s.session?.files ?? []).flatMap((f) => (marked(f) && f.attachmentId !== null ? [f.attachmentId] : []))
      if (!s.session || ids.length === 0) return s
      for (const id of ids) fx.push({ t: 'delete', id, token: s.session.reportToken, epoch: s.epoch, by: { k: 'load' } })
      return { ...s }
    }
    case 'pick':
      return pick(s, e.pick, e.files, fx)
    case 'remove': {
      const it = s.items.find((x) => x.key === e.key)
      if (!it || it.step === 'removing' || s.jobs.some((j) => j.k === 'remove' && j.key === e.key)) return s
      const send = s.send && { ...s.send, out: [...s.send.out, e.key] }
      return { ...s, send, jobs: [...s.jobs, { k: 'remove', key: e.key }] }
    }
    case 'send': {
      // A refused file would be refused again: it has to be removed first.
      if (s.send || s.items.some((x) => x.step === 'failed' && x.why)) return s
      const saved = s.session && { code: s.session.code, reportToken: s.session.reportToken }
      const target = e.target ?? s.target ?? saved
      if (!target) return s
      const leaving = (k: string) => s.jobs.some((j) => j.k === 'remove' && j.key === k)
      const out = s.items.filter((x) => x.step === 'removing' || leaving(x.key)).map((x) => x.key)
      return { ...s, send: { target, keys: null, out } }
    }
    case 'reset':
    case 'closed': {
      fx.push({ t: 'stop' })
      s.items.forEach((x) => fx.push({ t: 'forget', key: x.key }))
      const base = { ...s, epoch: s.epoch + 1, items: [], jobs: [], send: null }
      if (e.t === 'closed') return base
      // Cleared even when nothing is held here: storage may hold another report's upload, as before.
      if (s.session === null) fx.push({ t: 'save', session: null })
      return { ...base, session: null, target: null, phase: 'idle', rejection: null }
    }
    case 'hashed': {
      if (e.epoch !== s.epoch) return s
      const mine = (h: Hashing) => h.key === e.key && h.gen === e.gen && h.head === undefined
      const ji = s.jobs.findIndex((j) => j.k !== 'remove' && j.files.some(mine))
      const j = s.jobs[ji]
      if (!j || j.k === 'remove') return s
      const files = j.files.map((h) => (h.key === e.key ? { ...h, head: e.head } : h))
      return { ...s, jobs: s.jobs.map((x, i) => (i === ji ? { ...j, files } : x)) }
    }
    case 'created': {
      const it = live(s, e)
      // A create is only out during a Send, which wrote the session first.
      if (!it || it.att || !s.session || (it.step !== 'creating' && it.step !== 'removing')) return s
      const id = idOf(it)
      const gone = it.step === 'removing'
      // Only a line with no attachment yet takes the new one; from here on the line is known by it.
      const bound = (x: SavedFile): SavedFile =>
        x.attachmentId !== null || !sameFile(id, x) ? x : gone ? { ...x, ...e.att, removing: true } : { ...x, ...e.att }
      const session = lines(s, (l) => l.map(bound))
      if (!gone) {
        if (!s.send) return s
        const token = s.send.target.reportToken
        fx.push({ t: 'upload', key: it.key, gen: it.gen, epoch: s.epoch, file: it.file, att: e.att, token })
        return { ...setItem(s, it.key, { att: e.att, step: 'uploading' }), session }
      }
      // Removed while its create was out: the attachment it got is deleted at once, under a new generation.
      const by: DeleteBy = { k: 'remove', key: it.key, gen: it.gen + 1 }
      fx.push({ t: 'delete', id: e.att.attachmentId, token: s.session.reportToken, epoch: s.epoch, by })
      return { ...setItem(s, it.key, { att: e.att, gen: by.gen }), session }
    }
    case 'confirmed': {
      const it = live(s, e)
      return it?.step === 'uploading' ? setItem(s, it.key, { confirmed: e.bytes }) : s
    }
    case 'uploaded': {
      const it = live(s, e)
      if (it?.step !== 'uploading' || !it.att) return s
      const sent = it.att.attachmentId
      const session = lines(s, (l) => l.map((x) => (x.attachmentId === sent ? { ...x, done: true } : x)))
      return { ...setItem(s, it.key, { step: 'done', confirmed: it.file.size }), session }
    }
    case 'failed': {
      const it = live(s, e)
      if (!it) return s
      // A create failed for a file removed meanwhile: nothing holds a place on the server, it just leaves.
      if (it.step === 'removing' && !it.att) return leave(s, it, fx)
      if (it.step !== 'creating' && it.step !== 'uploading') return s
      // The Send ends here: the file shows why, and Try again (or Remove) is the player's.
      const failed = setItem(s, it.key, { step: 'failed', why: e.why ?? undefined })
      return { ...failed, send: null, phase: e.why ? 'idle' : 'error' }
    }
    case 'deleted':
      return deleted(s, e, fx)
  }
}

function deleted(s: State, e: Extract<Event, { t: 'deleted' }>, fx: Effect[]): State {
  if (e.epoch !== s.epoch) return s
  if (e.by.k === 'remove') {
    const it = live(s, { key: e.by.key, gen: e.by.gen, epoch: e.epoch })
    if (it?.step !== 'removing' || it.att?.attachmentId !== e.id) return s
    return e.gone ? leave(s, it, fx) : setItem(s, it.key, { step: 'unremoved' })
  }
  const line = s.session?.files.find((f) => f.attachmentId === e.id && marked(f))
  const head = s.jobs[0]
  const freeing = head?.k === 'pick' && head.free?.at === e.id ? head : null
  if (!line && !freeing) return s
  let n = s
  const dropped = !!line && e.gone
  if (dropped) n = { ...n, session: lines(n, (l) => l.filter((f) => f !== line)), failed: n.failed.filter((x) => x !== e.id) }
  else if (line && e.by.k === 'load' && !n.failed.includes(e.id)) n = { ...n, failed: [...n.failed, e.id] }
  if (!freeing?.free) return n
  // The pick that sent it again goes on: the next held line, or its decision once enough places are free.
  const f = freeing.free
  const freed = f.freed + (dropped ? 1 : 0)
  const id = f.tries[0]
  if (freed >= f.need || id === undefined || !n.session) return list({ ...n, jobs: n.jobs.slice(1) }, freeing, fx)
  fx.push({ t: 'delete', id, token: n.session.reportToken, epoch: n.epoch, by: { k: 'held' } })
  const job = { ...freeing, free: { at: id, tries: f.tries.slice(1), need: f.need, freed } }
  return { ...n, jobs: [job, ...n.jobs.slice(1)] }
}

// Listed at once when no hash can change the outcome; otherwise listed once hashed, after the picks before it.
function pick(s: State, at: number, picked: { key: string; file: File }[], fx: Effect[]): State {
  if (busy(s)) return s
  const { items: list, session: sess } = s
  const files = picked.map((p) => p.file)
  const twinned = files.some((f, i) => list.some((e) => twins(e.file, f)) || files.slice(0, i).some((g) => twins(g, f)))
  // Saved lines this pick, or a listed file not hashed yet, may turn out to stand for (each frees a place then).
  const unhashed = [...files, ...list.filter((e) => e.head === undefined).map((e) => e.file)]
  const open = sess ? sess.files.filter((f) => !marked(f) && !list.some((e) => lineOf(e)(f))) : []
  const maybe = open.filter((f) => unhashed.some((x) => twins(x, f))).length
  const taken = list.length + heldBy(sess, list)
  const worst = validatePick(taken, files)
  const best = validatePick(taken - maybe, files)
  // A place held by a removed line whose DELETE failed: the pick waits for that DELETE to be sent again.
  const freed = validatePick(taken - stuck(sess, list, s.failed).length, files)
  const hashing = (p: { key: string; file: File }): Hashing => {
    fx.push({ t: 'hash', key: p.key, gen: 0, epoch: s.epoch, file: p.file })
    return { key: p.key, file: p.file, gen: 0 }
  }
  const sure = worst.ok.length === best.ok.length && worst.rejection === best.rejection && worst.ok.length === freed.ok.length
  if (s.jobs.some((j) => j.k === 'pick') || twinned || !sure) {
    return { ...s, jobs: [...s.jobs, { k: 'pick', pick: at, files: picked.map(hashing) }] }
  }
  const added = picked.filter((p) => worst.ok.includes(p.file))
  const items: Item[] = added.map((p) => ({ key: p.key, file: p.file, gen: 0, step: 'picked', confirmed: 0 }))
  const jobs: Job[] = added.length > 0 ? [...s.jobs, { k: 'bind', pick: at, files: added.map(hashing) }] : s.jobs
  return { ...s, items: [...list, ...items], rejection: worst.rejection, jobs }
}

// The jobs at the head of the queue that can run now, then the Send.
function advance(s: State, fx: Effect[]): State {
  for (let j = s.jobs[0]; j; j = s.jobs[0]) {
    if (j.k === 'remove') {
      if (removing(s)) break
      s = drop({ ...s, jobs: s.jobs.slice(1) }, j.key, fx)
      continue
    }
    if ((j.k === 'pick' && j.free) || j.files.some((h) => h.head === undefined)) break
    s = j.k === 'bind' ? bind(s, j, fx) : decide(s, j, fx)
  }
  return run(s, fx)
}

function bind(s: State, j: Extract<Job, { k: 'bind' }>, fx: Effect[]): State {
  let back = false
  const items = s.items.map((e): Item => {
    const head = j.files.find((x) => x.key === e.key)?.head
    if (head === undefined) return e
    // A removed line is not this file's any more: picked again, it is a new file with a new attachment.
    const m = s.session?.files.find((f) => !marked(f) && sameFile({ name: e.file.name, size: e.file.size, head }, f))
    if (!m) return { ...e, head }
    back ||= !m.done
    const done = m.done ? { step: 'done' as const, confirmed: e.file.size } : { step: 'picked' as const, confirmed: 0 }
    return { ...e, ...done, head, att: attOf(m), gen: e.gen + 1 }
  })
  const rest = s.jobs.slice(1)
  const r = resumeOf({ session: s.session, items })
  // A file the player already removed is not back: its Remove goes first, nothing starts the upload.
  const leaving = rest.some((x) => x.k === 'remove' && j.files.some((h) => h.key === x.key))
  if (back && r !== null && r.missing.length === 0 && !leaving) fx.push({ t: 'back', pick: j.pick })
  return { ...s, items, jobs: rest }
}

// A hashed pick: a file already listed is dropped, a saved one binds to its line (which already holds its place), the
// rest count against the 3. Refused as `count` while a failed removed line holds a place: its DELETE goes again first.
function plan(s: State, got: Hashing[]) {
  const ids = s.items.map(idOf)
  let count = s.items.length + heldBy(s.session, s.items)
  let why: Rejection | null = null
  let back = false
  let short = 0
  const adds: Item[] = []
  for (const h of got) {
    const id: Ident = { name: h.file.name, size: h.file.size, head: h.head ?? null }
    // The same file twice would upload twice and spend one of the 3 places.
    if (ids.some((x) => sameFile(x, id))) continue
    const m = s.session?.files.find((sf) => !marked(sf) && sameFile(id, sf))
    const v = m ? null : validatePick(count, [h.file])
    if (v) {
      why ??= v.rejection
      if (v.rejection === 'count') short++
      if (v.ok.length === 0) continue
      count++
    } else back ||= !m?.done
    const done = m?.done === true
    const confirmed = done ? h.file.size : 0
    adds.push({ key: h.key, file: h.file, head: id.head, gen: 0, step: done ? 'done' : 'picked', confirmed, att: m && attOf(m) })
    ids.push(id)
  }
  return { adds, why, back, short }
}
function decide(s: State, j: Extract<Job, { k: 'pick' }>, fx: Effect[]): State {
  const ids = stuck(s.session, s.items, s.failed)
  const first = ids[0]
  const need = plan(s, j.files).short
  if (need === 0 || first === undefined || !s.session) return list({ ...s, jobs: s.jobs.slice(1) }, j, fx)
  fx.push({ t: 'delete', id: first, token: s.session.reportToken, epoch: s.epoch, by: { k: 'held' } })
  const job = { ...j, free: { at: first, tries: ids.slice(1), need, freed: 0 } }
  return { ...s, jobs: [job, ...s.jobs.slice(1)] }
}
function list(s: State, j: Extract<Job, { k: 'pick' }>, fx: Effect[]): State {
  const p = plan(s, j.files)
  const items = [...s.items, ...p.adds]
  const r = resumeOf({ session: s.session, items })
  if (p.back && r !== null && r.missing.length === 0) fx.push({ t: 'back', pick: j.pick })
  return { ...s, items, rejection: p.why }
}

// A Remove whose turn came (the picks before it are hashed, no other DELETE is out).
function drop(s: State, key: string, fx: Effect[]): State {
  const it = s.items.find((x) => x.key === key)
  if (!it || it.step === 'done') return s
  const n = { ...s, send: s.send && { ...s.send, keys: s.send.keys && s.send.keys.filter((k) => k !== key) } }
  if (it.step === 'creating') return setItem(n, key, { step: 'removing' })
  if (!it.att || !n.session) return leave(n, it, fx)
  // Its attachment holds one of the 3 places: the file leaves only once the server let it go. The line is marked
  // first, so a page left before the answer has the next load finish the removal.
  const id = it.att.attachmentId
  const gen = it.gen + 1
  if (it.step === 'uploading') fx.push({ t: 'abort', key })
  fx.push({ t: 'delete', id, token: n.session.reportToken, epoch: n.epoch, by: { k: 'remove', key, gen } })
  const session = lines(n, (l) => l.map((f) => (f.attachmentId === id ? { ...f, removing: true } : f)))
  return { ...setItem(n, key, { step: 'removing', gen }), session }
}

function run(s: State, fx: Effect[]): State {
  if (!s.send || s.jobs.length > 0 || removing(s)) return s
  const n = s.send.keys === null ? begin(s, s.send) : s
  const send = n.send
  if (!send || n.items.some((x) => x.step === 'creating' || x.step === 'uploading')) return n
  const next = n.items.find((x) => x.step === 'picked' && send.keys?.includes(x.key))
  if (next) {
    const t = { key: next.key, gen: next.gen, epoch: n.epoch }
    if (next.att) {
      fx.push({ t: 'upload', ...t, file: next.file, att: next.att, token: send.target.reportToken })
      return setItem(n, next.key, { step: 'uploading' })
    }
    const body = { filename: next.file.name, size: next.file.size, mime: next.file.type }
    fx.push({ t: 'create', ...t, target: send.target, body })
    return setItem(n, next.key, { step: 'creating' })
  }
  // Done only when every saved file is: one not picked again after a reload still waits for its bytes (resume hint).
  const sess = n.session
  if (!sess || !sess.files.every((x) => x.done || marked(x) || answered(x, n.items))) {
    return { ...n, send: null, phase: 'idle' }
  }
  // A removed line still waiting for its DELETE outlives the upload, so the next load can finish it.
  const left = sess.files.filter(marked)
  return { ...n, send: null, phase: 'done', session: left.length > 0 ? { ...sess, files: left } : null }
}

function begin(s: State, send: Send): State {
  const { target } = send
  const prev = s.session
  // Attachments bound to another report's session cannot be reused for this one.
  const same = prev?.code === target.code
  const keys = s.items.filter((x) => !send.out.includes(x.key)).map((x) => x.key)
  const items = s.items.map((x): Item => {
    if (!same) return { ...x, att: undefined, step: 'picked', confirmed: 0, why: undefined, gen: x.gen + 1 }
    return keys.includes(x.key) && x.step !== 'done' ? { ...x, step: 'picked', why: undefined, gen: x.gen + 1 } : x
  })
  const mine = items.filter((x) => keys.includes(x.key))
  // Every file is written down before its attachment is asked for, so a reload from here on resumes this report. A
  // file whose Remove failed before Send goes up with the rest, so its line is no longer marked.
  const kept = same ? prev.files.map((f) => (marked(f) && mine.some((e) => e.att && lineOf(e)(f)) ? unmark(f) : f)) : []
  const added = mine
    .filter((e) => !kept.some(lineOf(e)))
    .map((e): SavedFile => ({ name: e.file.name, size: e.file.size, head: e.head ?? null, done: false, attachmentId: null }))
  const session: Session = { v: 3, code: target.code, reportToken: target.reportToken, files: [...kept, ...added] }
  return { ...s, items, session, target, phase: 'uploading', send: { ...send, keys } }
}
