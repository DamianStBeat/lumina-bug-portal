import { useCallback, useEffect, useRef, useState } from 'react'
import { ApiError, createAttachment, deleteAttachment } from '../api/client'
import { clearSession, loadSession, saveSession, type SavedFile, type Session } from './session'
import { retryable, uploadFile } from './uploader'
import { validatePick, type Rejection } from './validate'

// Why the server turned a file down for good: one of the pick-time reasons, or any other refusal ('other').
export type Refusal = Rejection | 'other'
export type FileItem = {
  key: string
  name: string
  size: number
  kind: 'video' | 'image'
  confirmed: number
  // 'error': network or server, Try again can pass it. 'refused': the server would answer the same again, so the
  // only way on is to remove the file.
  state: 'waiting' | 'uploading' | 'done' | 'error' | 'refused'
  why?: Refusal
  previewUrl?: string
}
export type Phase = 'idle' | 'uploading' | 'error' | 'done'
export type Target = { code: string; reportToken: string }
type Resume = { code: string; missing: { name: string; size: number }[] }
type Att = { attachmentId: string; partSize: number; partCount: number }
// The File and its attachment stay out of React state: the upload loop reads and replaces them across awaits.
// `head` (session.ts): undefined while the pick is still being hashed ("not yet", never a match), null when the
// browser could not hash it.
type Entry = Omit<FileItem, 'name' | 'size'> & { file: File; att?: Att; head?: string | null }
type Ident = { name: string; size: number; head: string | null }
// What the identity reads from the start of a file: enough to tell two exports apart, little enough for a phone.
const HEAD_BYTES = 1024 * 1024

let seq = 0

const view = (e: Entry): FileItem => ({
  key: e.key,
  name: e.file.name,
  size: e.file.size,
  kind: e.kind,
  confirmed: e.confirmed,
  state: e.state,
  why: e.why,
  previewUrl: e.previewUrl,
})

// A re-picked file is the same one when name, size and the hash of its first 1 MiB match; the same three values find
// its saved line. lastModified does not decide: iPhone Photos gives the same video a new one on every export. Two
// files the browser could not hash (head null on both) fall back to name and size, all it gives then.
const sameFile = (a: Ident | null, b: Ident) => a !== null && a.name === b.name && a.size === b.size && a.head === b.head
const idOf = (e: Entry): Ident | null => (e.head === undefined ? null : { name: e.file.name, size: e.file.size, head: e.head })
// Name and size alone: two such files may be the same one, which only their hashes can tell.
const twins = (a: { name: string; size: number }, b: { name: string; size: number }) => a.name === b.name && a.size === b.size

// The SHA-256 (hex) of the first 1 MiB. A file the browser cannot read or hash gets null, not a failed pick: it can
// still be sent, it is only known again by name and size.
async function hashHead(f: File): Promise<string | null> {
  try {
    const d = await crypto.subtle.digest('SHA-256', await f.slice(0, HEAD_BYTES).arrayBuffer())
    return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
  } catch {
    return null
  }
}
const attOf = (f: SavedFile): Att | undefined =>
  f.attachmentId === null ? undefined : { attachmentId: f.attachmentId, partSize: f.partSize, partCount: f.partCount }
// A line the player removed whose DELETE is not answered yet (session.ts): no longer one of the report's files, but
// still holding its place (heldBy).
const marked = (f: SavedFile): boolean => f.attachmentId !== null && f.removing === true
const unmark = (f: SavedFile): SavedFile => {
  if (f.attachmentId === null) return f
  const { name, size, head, done, attachmentId, partSize, partCount } = f
  return { name, size, head, done, attachmentId, partSize, partCount }
}
// The saved line of a listed file: by its attachment once it has one, since a removed line may share its name.
const lineOf = (e: Entry) => (f: SavedFile) =>
  e.att ? f.attachmentId === e.att.attachmentId : !marked(f) && sameFile(idOf(e), f)
// Saved lines no listed file stands for. Each holds a place on the server, so it counts against the 3: an open file
// not picked again, and a removed one until its DELETE is answered, as the server still counts its attachment.
const heldBy = (s: Session | null, list: Entry[]) => (s ? s.files.filter((f) => !list.some((e) => lineOf(e)(f))).length : 0)
// The attachments of held removed lines whose DELETE already failed on this load (`failed`): sending it again may free
// their places. A line whose DELETE is still out is not among them, its answer is on the way.
const stuckLines = (s: Session | null, list: Entry[], failed: Set<string>): string[] =>
  (s?.files ?? []).flatMap((f) =>
    f.attachmentId !== null && f.removing === true && failed.has(f.attachmentId) && !list.some((e) => lineOf(e)(f))
      ? [f.attachmentId]
      : [],
  )
// True when the attachment is gone: 2xx { ok: true } (deleteAttachment), or 404, already gone. Any other failure is
// false, never a throw: the line then stays marked and keeps its place.
const deleted = (id: string, token: string): Promise<boolean> =>
  deleteAttachment(id, token).then(
    () => true,
    (err: unknown) => err instanceof ApiError && err.status === 404,
  )

const SERVER_REFUSAL: Record<string, Rejection> = {
  invalid_mime: 'type',
  file_too_large: 'size',
  too_many_files: 'count',
}
// null: Try again can work (the network, the server, parts the server lost). Anything else is a refusal.
function refusalOf(e: unknown): Refusal | null {
  if (!(e instanceof ApiError)) return 'other'
  // Status 0 is also the uploader's own 'bad_parts' (the file does not fit the server's parts): not the network.
  if (e.code === 'missing_parts' || (e.status === 0 ? e.code === 'network' : retryable(e))) return null
  return SERVER_REFUSAL[e.code] ?? 'other'
}

// Shown while a saved session still has unfinished files; `missing` lists the ones not picked again yet.
function resumeOf(s: Session | null, list: Entry[]): Resume | null {
  // A removed file is never asked for again, even while its DELETE is still out.
  const open = s ? s.files.filter((f) => !f.done && !marked(f)) : []
  if (!s || open.length === 0) return null
  const missing = open
    .filter((f) => !list.some((e) => sameFile(idOf(e), f)))
    .map(({ name, size }) => ({ name, size }))
  return { code: s.code, missing }
}

// `only`: the report the page was asked for. A saved upload of another report is not offered here and never used for
// this one; it stays in storage until an upload to this report replaces it.
export function useUpload(only?: string) {
  const [boot] = useState(() => {
    const found = loadSession()
    const s = found && only && found.code !== only ? null : found
    return { s, resume: resumeOf(s, []) }
  })
  const saved = useRef<Session | null>(boot.s)
  const target = useRef<Target | null>(null)
  const entries = useRef<Entry[]>([])
  // Non-null while a run (an upload, or the delete of a removed file) is going; also how reset() and unmount stop it.
  const run = useRef<AbortController | null>(null)
  // Moves on at reset() and at unmount, so a page's own request answered after either is told apart (guard()).
  const epoch = useRef(0)
  const [files, setFiles] = useState<FileItem[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [rejection, setRejection] = useState<Rejection | null>(null)
  const [resume, setResume] = useState<Resume | null>(boot.resume)
  // A removed file whose attachment is being deleted; and one whose delete failed, which stays in the list.
  const [removing, setRemoving] = useState(false)
  const [unremoved, setUnremoved] = useState(false)
  // Attachments whose removal the server confirmed after the run that holds an older copy of the session began.
  const dropped = useRef(new Set<string>())
  // Attachments whose background DELETE (below) failed on this load: a pick that needs their place sends it again.
  const failed = useRef(new Set<string>())
  // Picks waiting for their hashes, one after the other, so they are decided in the order they were made. start()
  // and removeFile() wait for it; `waiting` counts the picks queued whole, which every later pick must wait behind.
  const queue = useRef<Promise<void>>(Promise.resolve())
  const waiting = useRef(0)

  const sync = useCallback(() => setFiles(entries.current.map(view)), [])
  const store = useCallback((s: Session | null) => {
    // start() writes back its own copy of the session after every file: a line dropped meanwhile stays dropped.
    const next = s && {
      ...s,
      files: s.files.filter((f) => !(f.attachmentId !== null && f.removing && dropped.current.has(f.attachmentId))),
    }
    saved.current = next
    if (next) saveSession(next)
    else clearSession()
    setResume(resumeOf(next, entries.current))
  }, [])
  // Entries are replaced, never edited in place, so a FileItem handed to React never changes under it.
  const patch = useCallback(
    (key: string, p: Partial<Entry>) => {
      entries.current = entries.current.map((x) => (x.key === key ? { ...x, ...p } : x))
      sync()
    },
    [sync],
  )

  useEffect(() => {
    const list = entries
    const ctl = run
    const ep = epoch
    return () => {
      ep.current++
      ctl.current?.abort()
      list.current.forEach((e) => e.previewUrl && URL.revokeObjectURL(e.previewUrl))
    }
  }, [])

  // A Remove whose answer the last visit never saw (the page was left while its DELETE was out) is sent again here,
  // in the background: 200 or 404 drops its line; any other failure keeps it marked (for a pick that needs its place,
  // then for the next load). Picks and Send are not held up by it, and nothing is written after reset() or unmount.
  useEffect(() => {
    const s = saved.current
    if (!s) return
    let live = true
    const at = epoch.current
    for (const f of s.files) {
      if (f.attachmentId === null || !f.removing) continue
      const id = f.attachmentId
      void deleted(id, s.reportToken).then((gone) => {
        if (!live || epoch.current !== at) return
        if (!gone) {
          failed.current.add(id)
          return
        }
        dropped.current.add(id)
        if (saved.current) store(saved.current)
      })
    }
    return () => {
      live = false
    }
  }, [store])

  // Taken by a page before its own await (createReport, attachSession): false afterwards when the page was left or
  // reset meanwhile, so a late answer never starts an upload nor overwrites the session of the one made since.
  const guard = useCallback(() => {
    const at = epoch.current
    return () => epoch.current === at
  }, [])

  // Runs `job` after every pick queued before it. A job does not throw (hashHead turns a failure into null); if one
  // ever did, its rejection is left unhandled, so the browser reports it, and the queue still goes on.
  const enqueue = useCallback((job: () => Promise<void>): Promise<void> => {
    const p = queue.current.then(job)
    queue.current = p.then(
      () => undefined,
      () => undefined,
    )
    return p
  }, [])

  // Sends again the DELETE of up to `need` held removed lines whose background DELETE failed, one after the other;
  // each one answered gone drops its line, which frees its place. True when at least one place was freed. Stops,
  // writing nothing, once reset() or unmount came.
  const retryHeld = useCallback(
    async (need: number, at: number): Promise<boolean> => {
      const s = saved.current
      if (!s) return false
      let freed = 0
      for (const id of stuckLines(s, entries.current, failed.current)) {
        if (freed >= need) break
        const gone = await deleted(id, s.reportToken)
        if (epoch.current !== at) return false
        if (!gone) continue
        failed.current.delete(id)
        dropped.current.add(id)
        if (saved.current) store(saved.current)
        freed++
      }
      return freed > 0
    },
    [store],
  )

  // A pick whose files are hashed: a file already listed is dropped, a saved one is bound to its line (it already
  // holds its place), the rest count against the 3. Files keep the order they were picked in. True when the pick
  // brought back a saved file and none is missing any more. When files are refused as `count` while a removed line
  // whose DELETE failed holds a place, that DELETE is sent again first and the pick decided on its answer.
  const decide = useCallback(
    async (got: { file: File; head: string | null }[], at: number): Promise<boolean> => {
      // Written nowhere and making no Entry (an Entry's preview URL would leak): a pick may be planned twice.
      const plan = (s: Session | null) => {
        const ids = entries.current.map(idOf)
        let count = entries.current.length + heldBy(s, entries.current)
        let why: Rejection | null = null
        let back = false
        let short = 0
        const adds: { f: File; head: string | null; m?: SavedFile }[] = []
        for (const { file: f, head } of got) {
          const id: Ident = { name: f.name, size: f.size, head }
          // The same file twice would upload twice and spend one of the 3 places.
          if (ids.some((x) => sameFile(x, id))) continue
          // A removed line is not this file's any more: picked again, it is a new file with a new attachment.
          const m = s?.files.find((sf) => !marked(sf) && sameFile(id, sf))
          if (m) {
            adds.push({ f, head, m })
            ids.push(id)
            back ||= !m.done
            continue
          }
          const v = validatePick(count, [f])
          why ??= v.rejection
          if (v.rejection === 'count') short++
          if (v.ok.length === 0) continue
          adds.push({ f, head })
          ids.push(id)
          count++
        }
        return { adds, why, back, short }
      }
      let p = plan(saved.current)
      if (p.short > 0 && (await retryHeld(p.short, at))) p = plan(saved.current)
      // reset() or unmount came while the DELETE was out: the list is no longer this pick's to change.
      if (epoch.current !== at) return false
      const s = saved.current
      const list = [
        ...entries.current,
        ...p.adds.map(({ f, head, m }) =>
          m ? entry(f, m.done ? 'done' : 'waiting', m.done ? f.size : 0, attOf(m), head) : entry(f, 'waiting', 0, undefined, head),
        ),
      ]
      setRejection(p.why)
      entries.current = list
      sync()
      const r = resumeOf(s, list)
      setResume(r)
      return p.back && r !== null && r.missing.length === 0
    },
    [sync, retryHeld],
  )

  // `onBack`: called when the pick turns out to bring back the last saved file still missing, which after a reload is
  // the whole action (FilePicker then starts the upload). Returns nothing on purpose: a pick whose outcome no hash
  // can change is listed within this call, so the page (and React's act) sees the list at once, and only the binding
  // to a saved line waits for the hash; any other pick is listed once hashed, in the order the picks were made.
  const addFiles = useCallback(
    (picked: File[], onBack?: () => void) => {
      if (run.current) return
      const at = epoch.current
      const s = saved.current
      const list = entries.current
      // Name and size alike may be the same file: listing or dropping it needs the hashes.
      const twinned = picked.some((f, i) => list.some((e) => twins(e.file, f)) || picked.slice(0, i).some((g) => twins(g, f)))
      // Saved lines this pick, or a listed file not hashed yet, may turn out to stand for (each frees a place then).
      const unhashed = [...picked, ...list.filter((e) => e.head === undefined).map((e) => e.file)]
      const maybe = s
        ? s.files.filter((f) => !marked(f) && !list.some((e) => lineOf(e)(f)) && unhashed.some((x) => twins(x, f))).length
        : 0
      const held = heldBy(s, list)
      const worst = validatePick(list.length + held, picked)
      const best = validatePick(list.length + held - maybe, picked)
      // A place held by a removed line whose DELETE failed on this load: when freeing it would let more of the pick in,
      // the pick waits for that DELETE to be sent again (decide) instead of being refused as `count` at once.
      const freed = validatePick(list.length + held - stuckLines(s, list, failed.current).length, picked)
      if (
        waiting.current > 0 ||
        twinned ||
        worst.ok.length !== best.ok.length ||
        worst.rejection !== best.rejection ||
        worst.ok.length !== freed.ok.length
      ) {
        waiting.current++
        void enqueue(async () => {
          try {
            const got = await Promise.all(picked.map(async (file) => ({ file, head: await hashHead(file) })))
            // reset() or unmount came first: the list is no longer this pick's to change.
            if (epoch.current === at && (await decide(got, at))) onBack?.()
          } finally {
            waiting.current--
          }
        })
        return
      }
      setRejection(worst.rejection)
      const added = worst.ok.map((f) => entry(f, 'waiting', 0))
      entries.current = [...list, ...added]
      sync()
      setResume(resumeOf(s, entries.current))
      if (added.length === 0) return
      // Each file is hashed once, now; its head goes into its saved line, and a saved file is bound to its line.
      const hashed = Promise.all(added.map(async (e) => ({ key: e.key, head: await hashHead(e.file) })))
      void enqueue(async () => {
        const got = await hashed
        if (epoch.current !== at) return
        const now = saved.current
        let back = false
        entries.current = entries.current.map((e) => {
          const head = got.find((g) => g.key === e.key)?.head
          if (head === undefined) return e
          // A removed line is not this file's any more: picked again, it is a new file with a new attachment.
          const m = now?.files.find((f) => !marked(f) && sameFile({ name: e.file.name, size: e.file.size, head }, f))
          if (!m) return { ...e, head }
          back ||= !m.done
          return { ...e, head, state: m.done ? 'done' : 'waiting', confirmed: m.done ? e.file.size : 0, att: attOf(m) }
        })
        sync()
        const r = resumeOf(now, entries.current)
        setResume(r)
        if (back && r !== null && r.missing.length === 0) onBack?.()
      })
    },
    [sync, enqueue, decide],
  )

  const removeFile = useCallback(
    async (key: string): Promise<void> => {
      if (run.current || !entries.current.some((x) => x.key === key)) return
      // A file still being hashed may turn out to be a saved one with an attachment: Remove then has a DELETE to send.
      await queue.current
      const e = entries.current.find((x) => x.key === key)
      if (!e || run.current || e.state === 'done') return
      const before = saved.current
      const att = e.att
      if (att && before) {
        // Its attachment holds one of the report's 3 places, so the file leaves the list (and the session) only once
        // the server has let it go; a failed delete keeps both, and pressing Remove again retries it. The line is
        // marked first, so a page left before the answer has the next load finish the removal.
        const ac = new AbortController()
        run.current = ac
        setRemoving(true)
        setUnremoved(false)
        store({ ...before, files: before.files.map((f) => (f.attachmentId === att.attachmentId ? { ...f, removing: true } : f)) })
        try {
          await deleteAttachment(att.attachmentId, before.reportToken)
        } catch (err) {
          // 404: the attachment is already gone, which is what removing it asked for.
          if (!(err instanceof ApiError && err.status === 404)) {
            if (!ac.signal.aborted) {
              patch(key, { state: 'error' })
              setUnremoved(true)
            }
            return
          }
        } finally {
          if (run.current === ac) run.current = null
          if (!ac.signal.aborted) setRemoving(false)
        }
        // reset() or unmount came first: the list and the session are no longer this one's to change.
        if (ac.signal.aborted) return
      }
      if (e.previewUrl) URL.revokeObjectURL(e.previewUrl)
      entries.current = entries.current.filter((x) => x.key !== key)
      const s = saved.current
      const mine = lineOf(e)
      if (s) store({ ...s, files: s.files.filter((f) => !mine(f)) })
      sync()
    },
    [sync, store, patch],
  )

  const start = useCallback(
    async (t?: Target): Promise<boolean> => {
      // A refused file would be refused again: it has to be removed first.
      if (run.current || entries.current.some((e) => e.state === 'refused')) return false
      const tgt = t ?? target.current ?? (saved.current ? { code: saved.current.code, reportToken: saved.current.reportToken } : null)
      if (!tgt) return false
      const ac = new AbortController()
      // After reset() or unmount nothing may be written: no storage, no state.
      const live = () => !ac.signal.aborted
      // Set before the wait below, so no pick, Remove or second Send slips in while the last picks are hashed.
      run.current = ac
      let current: string | null = null
      try {
        // Resume or new is decided on what the picked files are: the picks still being hashed are settled first.
        await queue.current
        if (!live()) return false
        const prev = saved.current
        // Attachments bound to another report's session cannot be reused for this one.
        const same = prev?.code === tgt.code
        entries.current = entries.current.map((e) =>
          !same ? { ...e, att: undefined, state: 'waiting', confirmed: 0 } : e.state === 'done' ? e : { ...e, state: 'waiting' },
        )
        // Every file is written down before its attachment is asked for, so a reload from here on resumes this report.
        // A listed file whose delete failed goes up with the rest, so its line is no longer marked; a line removed
        // from the list stays marked for its DELETE (sent again on the next load) and is not part of this upload.
        const kept = same
          ? prev.files.map((f) => (marked(f) && entries.current.some((e) => e.att && lineOf(e)(f)) ? unmark(f) : f))
          : []
        // After the wait every listed file is hashed, so `?? null` never stands in for a head not known yet.
        const added = entries.current
          .filter((e) => !kept.some((f) => !marked(f) && sameFile(idOf(e), f)))
          .map((e): SavedFile => ({ name: e.file.name, size: e.file.size, head: e.head ?? null, done: false, attachmentId: null }))
        let s: Session = { v: 3, code: tgt.code, reportToken: tgt.reportToken, files: [...kept, ...added] }
        target.current = tgt
        store(s)
        setPhase('uploading')
        // The file whose delete failed goes up with the rest: it is no longer a file waiting to be removed.
        setUnremoved(false)
        sync()
        // Files go one after the other (see the pool note in uploader.ts); the list cannot change while `run` is set.
        for (const e of entries.current.filter((x) => x.state !== 'done')) {
          const { key, file: f, att: known } = e
          const id = idOf(e)
          current = key
          let att = known
          if (!att) {
            const body = { filename: f.name, size: f.size, mime: f.type }
            const r = await createAttachment(tgt.code, tgt.reportToken, body, ac.signal)
            if (!live()) return false
            const made: Att = { attachmentId: r.attachmentId, partSize: r.partSize, partCount: r.partCount }
            att = made
            s = { ...s, files: s.files.map((x) => (!marked(x) && sameFile(id, x) ? { ...x, ...made } : x)) }
            patch(key, { att })
            store(s)
          }
          patch(key, { state: 'uploading' })
          await uploadFile({
            file: f,
            ...att,
            token: tgt.reportToken,
            signal: ac.signal,
            onConfirmed: (b) => {
              if (live()) patch(key, { confirmed: b })
            },
          })
          if (!live()) return false
          s = { ...s, files: s.files.map((x) => (!marked(x) && sameFile(id, x) ? { ...x, done: true } : x)) }
          patch(key, { state: 'done', confirmed: f.size })
          store(s)
        }
        // Done only when every saved file is: one not picked again after a reload still waits for its bytes, and the
        // page shows the resume hint for it.
        if (s.files.every((x) => x.done || marked(x))) {
          // A removed line still waiting for its DELETE outlives the upload, so the next load can finish it.
          const left = s.files.filter(marked)
          store(left.length > 0 ? { ...s, files: left } : null)
          // Those lines may have been dropped meanwhile (store() filters them): nothing is left to keep then.
          if (saved.current?.files.length === 0) store(null)
          setPhase('done')
          return true
        }
        setPhase('idle')
        return false
      } catch (e) {
        // A stop asked by reset() or unmount is not an error to show.
        if (!live()) return false
        const why = refusalOf(e)
        if (current) patch(current, why ? { state: 'refused', why } : { state: 'error' })
        setPhase(why ? 'idle' : 'error')
        return false
      } finally {
        if (run.current === ac) run.current = null
      }
    },
    [sync, store, patch],
  )

  const retry = useCallback(() => start(target.current ?? undefined), [start])

  const reset = useCallback(() => {
    epoch.current++
    run.current?.abort()
    run.current = null
    entries.current.forEach((e) => e.previewUrl && URL.revokeObjectURL(e.previewUrl))
    entries.current = []
    target.current = null
    store(null)
    sync()
    setPhase('idle')
    setRejection(null)
    setRemoving(false)
    setUnremoved(false)
  }, [sync, store])

  const total = files.reduce((n, f) => n + f.size, 0)
  const progress = total > 0 ? files.reduce((n, f) => n + f.confirmed, 0) / total : phase === 'done' ? 1 : 0

  const refused = files.find((f) => f.state === 'refused')?.why ?? null

  return {
    files,
    phase,
    rejection,
    refused,
    progress,
    resume,
    removing,
    unremoved,
    addFiles,
    removeFile,
    start,
    retry,
    reset,
    guard,
  }
}

function entry(file: File, state: Entry['state'], confirmed: number, att?: Att, head?: string | null): Entry {
  const kind = file.type.startsWith('image/') ? 'image' : 'video'
  return {
    key: `f${++seq}`,
    file,
    kind,
    confirmed,
    state,
    // Only pictures get a thumbnail; a video's object URL would pin a 2 GB file for nothing.
    previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
    att,
    head,
  }
}
