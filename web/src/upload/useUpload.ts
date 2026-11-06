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
type Entry = Omit<FileItem, 'name' | 'size'> & { file: File; att?: Att }
type Ident = { name: string; size: number; lastModified: number }

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

// The browser gives a re-picked file no other identity; the same three values also find its saved line.
const sameFile = (a: Ident, b: Ident) => a.name === b.name && a.size === b.size && a.lastModified === b.lastModified
const attOf = (f: SavedFile): Att | undefined =>
  f.attachmentId === null ? undefined : { attachmentId: f.attachmentId, partSize: f.partSize, partCount: f.partCount }
// A line the player removed whose DELETE is not answered yet (session.ts): no longer one of the report's files.
const marked = (f: SavedFile): boolean => f.attachmentId !== null && f.removing === true
const unmark = (f: SavedFile): SavedFile => {
  if (f.attachmentId === null) return f
  const { name, size, lastModified, done, attachmentId, partSize, partCount } = f
  return { name, size, lastModified, done, attachmentId, partSize, partCount }
}
// The saved line of a listed file: by its attachment once it has one, since a removed line may share its name.
const lineOf = (e: Entry) => (f: SavedFile) =>
  e.att ? f.attachmentId === e.att.attachmentId : !marked(f) && sameFile(f, e.file)

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
    .filter((f) => !list.some((e) => sameFile(e.file, f)))
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
  // in the background: 200 or 404 drops its line; any other failure keeps it marked for the next load. Picks and
  // Send are not held up by it, and nothing is written after reset() or unmount.
  useEffect(() => {
    const s = saved.current
    if (!s) return
    let live = true
    const at = epoch.current
    const gone = (id: string) => {
      if (!live || epoch.current !== at) return
      dropped.current.add(id)
      if (saved.current) store(saved.current)
    }
    for (const f of s.files) {
      if (f.attachmentId === null || !f.removing) continue
      const id = f.attachmentId
      deleteAttachment(id, s.reportToken).then(
        () => gone(id),
        (err: unknown) => {
          if (err instanceof ApiError && err.status === 404) gone(id)
        },
      )
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

  const addFiles = useCallback(
    (picked: File[]) => {
      if (run.current) return
      const s = saved.current
      const known: Entry[] = []
      const fresh: File[] = []
      for (const f of picked) {
        // The same file twice would upload twice and spend one of the 3 places.
        if ([...entries.current, ...known].some((e) => sameFile(f, e.file))) continue
        // A removed line is not this file's any more: picked again, it is a new file with a new attachment.
        const m = s?.files.find((sf) => !marked(sf) && sameFile(f, sf))
        if (!m) {
          fresh.push(f)
          continue
        }
        known.push(entry(f, m.done ? 'done' : 'waiting', m.done ? f.size : 0, attOf(m)))
      }
      const list = [...entries.current, ...known]
      // Saved files not picked again hold a place on the server (or will on resume), so they count against the 3.
      const held = s ? s.files.filter((sf) => !marked(sf) && !list.some((e) => sameFile(e.file, sf))).length : 0
      const { ok, rejection: why } = validatePick(list.length + held, fresh)
      setRejection(why)
      entries.current = [...list, ...ok.map((f) => entry(f, 'waiting', 0))]
      sync()
      setResume(resumeOf(s, entries.current))
    },
    [sync],
  )

  const removeFile = useCallback(
    async (key: string): Promise<void> => {
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
      const prev = saved.current
      const tgt = t ?? target.current ?? (prev ? { code: prev.code, reportToken: prev.reportToken } : null)
      if (!tgt) return false
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
      const added = entries.current
        .filter((e) => !kept.some((f) => !marked(f) && sameFile(f, e.file)))
        .map(({ file: f }): SavedFile => ({ name: f.name, size: f.size, lastModified: f.lastModified, done: false, attachmentId: null }))
      let s: Session = { v: 2, code: tgt.code, reportToken: tgt.reportToken, files: [...kept, ...added] }
      target.current = tgt
      store(s)
      const ac = new AbortController()
      // After reset() or unmount nothing may be written: no storage, no state.
      const live = () => !ac.signal.aborted
      run.current = ac
      setPhase('uploading')
      // The file whose delete failed goes up with the rest: it is no longer a file waiting to be removed.
      setUnremoved(false)
      sync()
      let current: string | null = null
      try {
        // Files go one after the other (see the pool note in uploader.ts); the list cannot change while `run` is set.
        for (const { key, file: f, att: known } of entries.current.filter((e) => e.state !== 'done')) {
          current = key
          let att = known
          if (!att) {
            const body = { filename: f.name, size: f.size, mime: f.type }
            const r = await createAttachment(tgt.code, tgt.reportToken, body, ac.signal)
            if (!live()) return false
            const made: Att = { attachmentId: r.attachmentId, partSize: r.partSize, partCount: r.partCount }
            att = made
            s = { ...s, files: s.files.map((x) => (!marked(x) && sameFile(x, f) ? { ...x, ...made } : x)) }
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
          s = { ...s, files: s.files.map((x) => (!marked(x) && sameFile(x, f) ? { ...x, done: true } : x)) }
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

function entry(file: File, state: Entry['state'], confirmed: number, att?: Att): Entry {
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
  }
}
