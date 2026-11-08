// The upload queue as one pure state machine, reduce(state, event) → state: no React, no I/O, no timers, no clock.
// The hook dispatches the player's actions and the answers of the requests it ran, and runs the effects of `fx` in
// order; it decides nothing again. Every answer is checked against the state it lands in, so a late one cannot undo
// what happened since (the races of two red team rounds: Remove vs Send, Remove after unmount).
//
// Per file (Item, by client key):
//   picked ─Send→ creating ─created→ uploading ─uploaded→ done · creating|uploading ─failed→ failed (why: a refusal,
//   or none when Try again can pass) · not done ─Remove→ removing ─gone→ leaves the list · ─not gone→ unremoved
//   (orange line, line still marked, holds its place) ─Remove→ removing · unremoved ─Send pressed after→ picked.
//   uploading ⇄ completing (every part confirmed, the complete out; back while the parts the server lost go again) ·
//   uploading|completing ─network lost→ paused ─network back→ where it was. The page shows both as uploading.
//   creating ─Remove→ removing without an attachment: its open line is marked at once, so no reload asks for it; its
//   create answer is awaited, written into that line and then deleted (an attachment never deleted would hold one of
//   the 3 places), even after the page was left (`adopt`); a failed create just leaves.
// A Remove is saved when it is pressed, before any request it causes (session.ts `removing`, `pending`), and leaves the
// session only when the server says the attachment is gone: a page left in between has the next load finish it.
// Remove wins at once: the upload of the file stops when it is pressed, even while it waits behind another DELETE,
// and from then on no answer of that upload (a part, the complete, a failure) changes the file.
// Picks, binds and Removes are jobs run in the order they were made. A Send waits while a job is queued or a file is
// removing, starts one file at a time and none while a file is removing; a file removed since it was pressed (or still
// removing then) is never part of it, even when its DELETE fails. It ends done, idle (a saved file not picked again)
// or error. Stale: every answer carries the key, generation and epoch of its effect. The generation moves on Remove, on
// every Send and on a re-pick binding a saved attachment; the epoch on reset and unmount. An answer of another
// generation, for a file no longer listed, or of an old epoch returns the same state object: the hook runs nothing.
//
// Left to the hook: the parts of one file (uploader.ts: 3 in flight, 5 retries, waiting for 'online', complete and its
// missing parts) as one `upload` effect, files one at a time, so 3 parts in flight overall (the uploader reports
// completing and paused as `stage`; the last failure of a network loss still arrives as `failed`); hashing; what a
// DELETE answer means (`gone`: 2xx { ok: true } or 404); refusalOf; storage; previews. Decided here: resume matching
// and the places held by saved and removed lines.
import type { SavedFile, Session } from './session'
import { validatePick, type Rejection } from './validate'

// Why the server turned a file down for good: one of the pick-time reasons, or any other refusal ('other').
export type Refusal = Rejection | 'other'
export type Att = { attachmentId: string; partSize: number; partCount: number }
export type Target = { code: string; reportToken: string }
export type Phase = 'idle' | 'uploading' | 'error' | 'done'
// Where the uploader says an upload is (uploader.ts `onStage`).
export type Stage = 'uploading' | 'completing' | 'paused'
export type Step = 'picked' | 'creating' | Stage | 'done' | 'failed' | 'removing' | 'unremoved'
// `head` (session.ts): undefined while still being hashed ("not yet", never a match), null when the browser could not
// hash it. `why` only on a failed file the server refused.
// `was`: the step when Remove was pressed; the row shows it until the DELETE answers.
export type Item = { key: string; file: File; head?: string | null; att?: Att; gen: number; step: Step; confirmed: number }
  & { why?: Refusal; was?: Step }
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
// `left`: the attachment a removed file's create got after the page was left; its answer changes nothing.
export type DeleteBy = { k: 'remove'; key: string; gen: number } | { k: 'load' } | { k: 'held' } | { k: 'left' }
export type MarkedFile = Extract<SavedFile, { attachmentId: string }>
// The attachment of a removed file whose create answered after its page was left or reset, marked: an effect of the old
// page, an event of the mounted one (useUpload.ts). A server fact, applied only to the session of its report.
export type Adopt = { t: 'adopt'; code: string; token: string; line: MarkedFile }
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
  // reset or unmount: abort every create and upload but the creates of `keep` (removed files: their answer is needed
  // to delete what they made). A DELETE is let reach the server; its marked line has the next load send it again.
  | { t: 'stop'; keep?: string[] }
  | Adopt
// mount: `stored`, storage read at mount, for what a late create wrote after the page read it at boot.
export type Event =
  | { t: 'mount'; stored?: Session | null }
  | Adopt
  | { t: 'reset' }
  | { t: 'closed' }
  | { t: 'pick'; pick: number; files: { key: string; file: File }[] }
  | { t: 'remove'; key: string }
  | { t: 'send'; target?: Target }
  | ({ t: 'hashed'; head: string | null } & Ticket)
  | ({ t: 'created'; att: Att } & Ticket)
  | ({ t: 'confirmed'; bytes: number } & Ticket)
  | ({ t: 'stage'; stage: Stage } & Ticket)
  | ({ t: 'uploaded' } & Ticket)
  | ({ t: 'failed'; why: Refusal | null } & Ticket)
  | { t: 'deleted'; id: string; epoch: number; by: DeleteBy; gone: boolean }
// `failed`: attachments of removed lines whose DELETE failed on this load. `fx`: what the last transition asks for.
// `left`: creates of removed files still out when the page was left or reset (their epoch is gone). `loading`: DELETEs
// the load sent, not answered yet; no Send starts before the places they hold are known. `unsaved`: `initial` struck
// lines in memory that storage still holds as the last visit left them; the mount saves them.
type Left = Ticket & { code: string; token: string; id: Ident }
export type State = { epoch: number; session: Session | null; target: Target | null; items: Item[]; jobs: Job[] }
  & { send: Send | null; phase: Phase; rejection: Rejection | null; failed: string[]; left: Left[]; fx: Effect[] }
  & { loading: string[]; unsaved: boolean }
export type Resume = { code: string; missing: { name: string; size: number }[] }
type Ident = { name: string; size: number; head: string | null }

// `boot`: the saved upload the page may use (the hook drops another report's first). What the last visit removed is
// struck here and not at mount: the first render reads `resume` from this state, before any effect, and the pages keep
// what it says (Report.tsx and AddVideo.tsx open on that report). Storage is written at mount, render stays pure.
export function initial(boot: Session | null): State {
  const session = replay(boot, null)
  return {
    epoch: 0, session, target: null, items: [], jobs: [], send: null, phase: 'idle', rejection: null, failed: [], left: [],
    fx: [], loading: [], unsaved: session !== boot,
  }
}

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
const marked = (f: SavedFile): f is MarkedFile => f.attachmentId !== null && f.removing === true
// Removed, with or without an attachment: never bound, resumed or asked for again.
const struck = (f: SavedFile): boolean => f.removing === true
const mark = (f: SavedFile): SavedFile => ({ ...f, removing: true })
// A session without `pending` when nothing is left in it, so a saved session never carries an empty one.
function withPending(s: Session, pending: Session['pending']): Session {
  const { v, code, reportToken, files } = s
  return pending && pending.length > 0 ? { v, code, reportToken, files, pending } : { v, code, reportToken, files }
}
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
// The line of a listed file: by its attachment once it has one, since a removed line may share its name. Without one,
// its own id-less removing line is still its line (only one listed file has that identity).
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
  const open = s ? s.files.filter((f) => !f.done && !struck(f)) : []
  if (!s || open.length === 0) return null
  const missing = open.filter((f) => !answered(f, items) && !items.some((e) => sameFile(idOf(e), f)))
  return { code: s.code, missing: missing.map(({ name, size }) => ({ name, size })) }
}
// Its upload effect is running.
const going = (step: Step): step is Stage => step === 'uploading' || step === 'completing' || step === 'paused'
// While true the page takes no pick: a Send is going (or waiting) or a file's DELETE is out.
export const busy = (s: State) => s.send !== null || s.items.some((x) => x.step === 'removing')
// The orange line stays while an unremoved file's DELETE is sent again: only its answer changes the row.
export const unremoved = (s: State) => s.items.some((x) => (x.step === 'removing' ? x.was : x.step) === 'unremoved')
// What the list shows ('error': Try again can pass it; 'refused': only Remove can). A removing file shows the step it
// had when Remove was pressed, so a refused row keeps its colour and refusal line until the DELETE answers.
export function viewState(it: Item): 'waiting' | 'uploading' | 'done' | 'error' | 'refused' {
  const step = it.step === 'removing' && it.was ? it.was : it.step
  if (going(step)) return 'uploading'
  if (step === 'done') return 'done'
  if (step === 'failed') return it.why ? 'refused' : 'error'
  return step === 'unremoved' ? 'error' : 'waiting'
}

const setItem = (s: State, key: string, p: Partial<Item>): State =>
  ({ ...s, items: s.items.map((x) => (x.key === key ? { ...x, ...p } : x)) })
const lines = (s: State, f: (l: SavedFile[]) => SavedFile[]): Session | null =>
  s.session && { ...s.session, files: f(s.session.files) }
const live = (s: State, t: Ticket): Item | undefined =>
  t.epoch === s.epoch ? s.items.find((x) => x.key === t.key && x.gen === t.gen) : undefined
const removing = (s: State) => s.items.some((x) => x.step === 'removing')
// Pressed Remove, its turn not come yet (a hash or another file's DELETE before it): already not one of the files.
const queued = (s: State, key: string) => s.jobs.some((j) => j.k === 'remove' && j.key === key)
// The file leaves the list and its line the session.
function leave(s: State, it: Item, fx: Effect[]): State {
  fx.push({ t: 'forget', key: it.key })
  const session = lines(s, (l) => l.filter((f) => !lineOf(it)(f)))
  return { ...s, items: s.items.filter((x) => x.key !== it.key), session }
}
const identOf = (x: Item): Ident => ({ name: x.file.name, size: x.file.size, head: x.head ?? null })
const lineAt = (id: Ident, att: Att): MarkedFile => ({ ...id, done: false, ...att, removing: true })
// The marked line of an attachment into a session: its id-less removing twin filled (the line Remove marked while the
// create was out), or appended.
function fill(sess: Session, line: MarkedFile): Session {
  if (sess.files.some((f) => f.attachmentId === line.attachmentId)) return sess
  const i = sess.files.findIndex((f) => f.attachmentId === null && struck(f) && sameFile(line, f))
  return { ...sess, files: i < 0 ? [...sess.files, line] : sess.files.map((f, j) => (j === i ? line : f)) }
}
// An adopted line goes only into a session of its report (or makes one); undefined: another report's, write nothing.
export function adoptInto(sess: Session | null, a: Omit<Adopt, 't'>): Session | undefined {
  if (!sess) return { v: 3, code: a.code, reportToken: a.token, files: [a.line] }
  return sess.code === a.code && sess.reportToken === a.token ? fill(sess, a.line) : undefined
}

// What Remove writes when it is pressed, before any request it causes. Nothing for a done file (Remove leaves it).
function pressed(s: State, it: Item): Session | null {
  const sess = s.session
  if (!sess || it.step === 'done') return sess
  const att = it.att
  if (att) return lines(s, (l) => l.map((f) => (f.attachmentId === att.attachmentId ? mark(f) : f)))
  // Its create is out: the open line is marked, not dropped, so the create's answer finds where to write its id.
  if (it.step === 'creating') return lines(s, (l) => l.map((f) => (lineOf(it)(f) ? mark(f) : f)))
  if (s.jobs.some((j) => j.k === 'bind' && j.files.some((h) => h.key === it.key))) {
    // Still hashed, so known only by name and size: written only when an open saved line may be it.
    const open = sess.files.some((f) => !f.done && !struck(f) && twins(f, it.file))
    const { name, size } = it.file
    return open ? withPending(sess, [...(sess.pending ?? []), { name, size }]) : sess
  }
  // No attachment: nothing on the server, its line (if any) goes now.
  return sess.files.some(lineOf(it)) ? lines(s, (l) => l.filter((f) => !lineOf(it)(f))) : sess
}

// The Removes the last visit pressed but never saw answered: from the boot read (`initial`), then from what storage
// holds at mount.
function replay(own: Session | null, stored: Session | null): Session | null {
  let s = own
  // Marked lines a late create wrote to storage after this page read it at boot (useUpload.ts `adopt`).
  for (const f of stored?.files ?? []) {
    if (stored && marked(f)) s = adoptInto(s, { code: stored.code, token: stored.reportToken, line: f }) ?? s
  }
  if (!s) return s
  // Re-picked files Removed while still hashed: every open line of that name and size is struck.
  const pending = s.pending ?? []
  const hit = (f: SavedFile) => !f.done && !struck(f) && pending.some((p) => twins(p, f))
  // A removing line without an attachment: its create died with the old tab, the id is unknowable.
  const kept = (f: SavedFile) => !(f.attachmentId === null && (struck(f) || hit(f)))
  if (pending.length === 0 && s.files.every(kept)) return s
  return withPending({ ...s, files: s.files.filter(kept).map((f) => (hit(f) ? mark(f) : f)) }, undefined)
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
      // A Remove whose answer the last visit never saw is sent again in the background: picks go on, a Send waits for
      // the answers (`loading`). The first transition of a load: one save, before those DELETEs.
      const session = replay(s.session, e.stored ?? null)
      const ids = (session?.files ?? []).flatMap((f) => (marked(f) ? [f.attachmentId] : []))
      if (!session || (session === s.session && ids.length === 0 && !s.unsaved)) return session === s.session ? s : { ...s, session }
      if (s.unsaved) fx.push({ t: 'save', session })
      for (const id of ids) fx.push({ t: 'delete', id, token: session.reportToken, epoch: s.epoch, by: { k: 'load' } })
      return { ...s, session, loading: ids, unsaved: false }
    }
    case 'adopt': {
      // Another report's session is never written (row 2); the attachment is still deleted, untracked.
      const session = adoptInto(s.session, e)
      const by: DeleteBy = session ? { k: 'load' } : { k: 'left' }
      fx.push({ t: 'delete', id: e.line.attachmentId, token: e.token, epoch: s.epoch, by })
      return { ...s, session: session ?? s.session }
    }
    case 'pick':
      return pick(s, e.pick, e.files, fx)
    case 'remove': {
      const it = s.items.find((x) => x.key === e.key)
      if (!it || it.step === 'removing' || queued(s, e.key)) return s
      const send = s.send && { ...s.send, out: [...s.send.out, e.key] }
      // Its upload stops now, not when its turn comes: behind another file's DELETE it could be completed meanwhile.
      if (going(it.step)) fx.push({ t: 'abort', key: e.key })
      // A done file's Remove changes nothing (drop leaves it), so nothing is written for it either.
      const items = it.step === 'done' ? s.items : s.items.map((x) => (x.key === e.key ? { ...x, was: it.step } : x))
      return { ...s, items, send, session: pressed(s, it), jobs: [...s.jobs, { k: 'remove', key: e.key }] }
    }
    case 'send': {
      // A refused file would be refused again: it has to be removed first.
      if (s.send || s.items.some((x) => x.step === 'failed' && x.why)) return s
      const saved = s.session && { code: s.session.code, reportToken: s.session.reportToken }
      const target = e.target ?? s.target ?? saved
      if (!target) return s
      const out = s.items.filter((x) => x.step === 'removing' || queued(s, x.key)).map((x) => x.key)
      return { ...s, send: { target, keys: null, out } }
    }
    case 'reset':
    case 'closed': {
      // A removed file whose create is out keeps it: what it made is adopted when it answers (written marked to the
      // session of its report, then deleted). A tab closed for good loses that answer: the attachment then stays on
      // the server, holding one of the report's 3 places (known, not fixable from here; the next load drops its line).
      const target = s.send?.target
      const left = s.items.flatMap((x): Left[] =>
        target && !x.att && (x.step === 'removing' || (x.step === 'creating' && queued(s, x.key)))
          ? [{ key: x.key, gen: x.gen, epoch: s.epoch, code: target.code, token: target.reportToken, id: identOf(x) }]
          : [],
      )
      fx.push(left.length > 0 ? { t: 'stop', keep: left.map((x) => x.key) } : { t: 'stop' })
      s.items.forEach((x) => fx.push({ t: 'forget', key: x.key }))
      const base = { ...s, epoch: s.epoch + 1, items: [], jobs: [], send: null, left: [...s.left, ...left], loading: [] }
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
      if (e.epoch !== s.epoch) return leftCreated(s, e, fx)
      const it = live(s, e)
      // A create is only out during a Send, which wrote the session first.
      if (!it || it.att || !s.session || (it.step !== 'creating' && it.step !== 'removing')) return s
      if (it.step === 'creating' && !queued(s, it.key)) {
        if (!s.send) return s
        const id = idOf(it)
        // Only a line with no attachment yet takes the new one; from here on the line is known by it.
        const bound = (x: SavedFile): SavedFile =>
          x.attachmentId !== null || struck(x) || !sameFile(id, x) ? x : { ...x, ...e.att }
        const session = lines(s, (l) => l.map(bound))
        const token = s.send.target.reportToken
        fx.push({ t: 'upload', key: it.key, gen: it.gen, epoch: s.epoch, file: it.file, att: e.att, token })
        return { ...setItem(s, it.key, { att: e.att, step: 'uploading' }), session }
      }
      // Removed while its create was out (its open line marked then): its id goes into that line, so a page left
      // before its DELETE is answered has the next load send it again.
      const session = fill(s.session, lineAt(identOf(it), e.att))
      // Its Remove still waits for its turn (another DELETE is out): that turn sends the DELETE.
      if (it.step === 'creating') return { ...setItem(s, it.key, { att: e.att }), session }
      // Its Remove's turn came already: the attachment is deleted at once, under a new generation.
      const by: DeleteBy = { k: 'remove', key: it.key, gen: it.gen + 1 }
      fx.push({ t: 'delete', id: e.att.attachmentId, token: s.session.reportToken, epoch: s.epoch, by })
      return { ...setItem(s, it.key, { att: e.att, gen: by.gen }), session }
    }
    case 'confirmed': {
      const it = live(s, e)
      return it && going(it.step) && !queued(s, it.key) ? setItem(s, it.key, { confirmed: e.bytes }) : s
    }
    case 'stage': {
      // Where the uploader is now (uploading, completing, paused): only an upload still going, never a removed file's.
      const it = live(s, e)
      if (!it || !going(it.step) || it.step === e.stage || queued(s, it.key)) return s
      return setItem(s, it.key, { step: e.stage })
    }
    case 'uploaded': {
      const it = live(s, e)
      // A file whose Remove was pressed is not completed into the report, whatever the server answered.
      if (!it || !going(it.step) || !it.att || queued(s, it.key)) return s
      const sent = it.att.attachmentId
      const session = lines(s, (l) => l.map((x) => (x.attachmentId === sent ? { ...x, done: true } : x)))
      return { ...setItem(s, it.key, { step: 'done', confirmed: it.file.size }), session }
    }
    case 'failed': {
      const it = live(s, e)
      if (!it) return s
      const removed = it.step === 'removing' || queued(s, it.key)
      // A create failed for a file removed meanwhile: nothing holds a place on the server, it just leaves.
      if (removed && !it.att) return leave(s, it, fx)
      // The upload of a removed file answers its abort here: its Remove's DELETE settles it.
      if (removed || (it.step !== 'creating' && !going(it.step))) return s
      // The Send ends here: the file shows why, and Try again (or Remove) is the player's.
      const failed = setItem(s, it.key, { step: 'failed', why: e.why ?? undefined })
      return { ...failed, send: null, phase: e.why ? 'idle' : 'error' }
    }
    case 'deleted':
      return deleted(s, e, fx)
  }
}

// The create of a removed file answered after the page was left or reset: what it made is adopted (useUpload.ts: by
// the mounted page of its report, or written to storage), so a failed DELETE is still sent again. Any other answer of
// an old epoch is dropped.
function leftCreated(s: State, e: Extract<Event, { t: 'created' }>, fx: Effect[]): State {
  const o = s.left.find((x) => x.key === e.key && x.gen === e.gen && x.epoch === e.epoch)
  if (!o) return s
  fx.push({ t: 'adopt', code: o.code, token: o.token, line: lineAt(o.id, e.att) })
  return { ...s, left: s.left.filter((x) => x !== o) }
}

function deleted(s: State, e: Extract<Event, { t: 'deleted' }>, fx: Effect[]): State {
  if (e.epoch !== s.epoch) return s
  if (e.by.k === 'remove') {
    const it = live(s, { key: e.by.key, gen: e.by.gen, epoch: e.epoch })
    if (it?.step !== 'removing' || it.att?.attachmentId !== e.id) return s
    return e.gone ? leave(s, it, fx) : setItem(s, it.key, { step: 'unremoved' })
  }
  // A load DELETE answered, whatever it says: the Send may count the places now.
  const heard = e.by.k === 'load' && s.loading.includes(e.id)
  const base = heard ? { ...s, loading: s.loading.filter((x) => x !== e.id) } : s
  const line = s.session?.files.find((f) => f.attachmentId === e.id && marked(f))
  const head = s.jobs[0]
  const freeing = head?.k === 'pick' && head.free?.at === e.id ? head : null
  if (!line && !freeing) return base
  let n = base
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
  const open = sess ? sess.files.filter((f) => !struck(f) && !list.some((e) => lineOf(e)(f))) : []
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
  const rest = s.jobs.slice(1)
  const out = j.files.filter((h) => rest.some((x) => x.k === 'remove' && x.key === h.key)).map((h) => h.file)
  // Lines of files Removed while hashed: struck here, in the save that drops their `pending`, never one without the
  // other (a reload in between would resume the file, or strike its twins).
  const hits: SavedFile[] = []
  const items = s.items.map((e): Item => {
    const head = j.files.find((x) => x.key === e.key)?.head
    if (head === undefined) return e
    // A removed line is not this file's any more: picked again, it is a new file with a new attachment.
    const m = s.session?.files.find((f) => !struck(f) && sameFile({ name: e.file.name, size: e.file.size, head }, f))
    if (!m) return { ...e, head }
    back ||= !m.done
    if (!m.done && out.includes(e.file)) hits.push(m)
    const done = m.done ? { step: 'done' as const, confirmed: e.file.size } : { step: 'picked' as const, confirmed: 0 }
    return { ...e, ...done, head, att: attOf(m), gen: e.gen + 1 }
  })
  const r = resumeOf({ session: s.session, items })
  // A file the player already removed is not back: its Remove goes first, nothing starts the upload.
  if (back && r !== null && r.missing.length === 0 && out.length === 0) fx.push({ t: 'back', pick: j.pick })
  const sess = s.session
  if (!sess || (hits.length === 0 && !sess.pending)) return { ...s, items, jobs: rest }
  const files = sess.files.flatMap((f) => (!hits.includes(f) ? [f] : f.attachmentId === null ? [] : [mark(f)]))
  const pending = sess.pending?.filter((p) => !out.some((f) => twins(p, f)))
  const session = hits.length === 0 && pending?.length === sess.pending?.length ? sess : withPending({ ...sess, files }, pending)
  return { ...s, items, jobs: rest, session }
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
    const m = s.session?.files.find((sf) => !struck(sf) && sameFile(id, sf))
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
  // Its create is out: the answer is awaited (created, failed). One that answered while this Remove waited has its
  // attachment already, deleted below.
  if (it.step === 'creating' && !it.att) return setItem(n, key, { step: 'removing' })
  if (!it.att || !n.session) return leave(n, it, fx)
  // Its attachment holds one of the 3 places: the file leaves only once the server let it go. The line was marked when
  // Remove was pressed (marked again here, a no-op), so a page left before the answer has the next load finish the
  // removal. Its upload was stopped then, and nothing started it again since (no upload starts while it is queued).
  const id = it.att.attachmentId
  const gen = it.gen + 1
  fx.push({ t: 'delete', id, token: n.session.reportToken, epoch: n.epoch, by: { k: 'remove', key, gen } })
  const session = lines(n, (l) => l.map((f) => (f.attachmentId === id ? mark(f) : f)))
  return { ...setItem(n, key, { step: 'removing', gen }), session }
}

function run(s: State, fx: Effect[]): State {
  if (!s.send || s.jobs.length > 0 || removing(s) || s.loading.length > 0) return s
  const n = s.send.keys === null ? begin(s, s.send) : s
  const send = n.send
  if (!send || n.items.some((x) => x.step === 'creating' || going(x.step))) return n
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
  if (!sess || !sess.files.every((x) => x.done || struck(x) || answered(x, n.items))) {
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
