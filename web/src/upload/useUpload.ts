import { useCallback, useEffect, useRef, useState } from 'react'
import { createAttachment, deleteAttachment } from '../api/client'
import { clearSession, loadSession, saveSession, type SavedFile, type Session } from './session'
import { uploadFile } from './uploader'
import { validatePick, type Rejection } from './validate'

export type FileItem = {
  key: string
  name: string
  size: number
  kind: 'video' | 'image'
  confirmed: number
  state: 'waiting' | 'uploading' | 'done' | 'error'
  previewUrl?: string
}
export type Phase = 'idle' | 'uploading' | 'error' | 'done'
export type Target = { code: string; reportToken: string }
type Resume = { code: string; missing: { name: string; size: number }[] }
type Att = Pick<SavedFile, 'attachmentId' | 'partSize' | 'partCount'>
// The File and its attachment stay out of React state: the upload loop reads and replaces them across awaits.
type Entry = Omit<FileItem, 'name' | 'size'> & { file: File; att?: Att }

let seq = 0

const boundIds = (list: Entry[]) => new Set(list.flatMap((e) => (e.att ? [e.att.attachmentId] : [])))

const view = (e: Entry): FileItem => ({
  key: e.key,
  name: e.file.name,
  size: e.file.size,
  kind: e.kind,
  confirmed: e.confirmed,
  state: e.state,
  previewUrl: e.previewUrl,
})

const sameFile = (f: File, s: { name: string; size: number; lastModified: number }) =>
  f.name === s.name && f.size === s.size && f.lastModified === s.lastModified

// Shown while a saved session still has unfinished files; `missing` lists the ones not picked again yet.
function resumeOf(s: Session | null, bound: Set<string>): Resume | null {
  if (!s || s.files.every((f) => f.done)) return null
  const missing = s.files.filter((f) => !f.done && !bound.has(f.attachmentId)).map(({ name, size }) => ({ name, size }))
  return { code: s.code, missing }
}

export function useUpload() {
  const [boot] = useState(() => {
    const s = loadSession()
    return { s, resume: resumeOf(s, new Set()) }
  })
  const saved = useRef<Session | null>(boot.s)
  const target = useRef<Target | null>(null)
  const entries = useRef<Entry[]>([])
  // Non-null while a run is going; also how reset() and unmount stop it.
  const run = useRef<AbortController | null>(null)
  const [files, setFiles] = useState<FileItem[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [rejection, setRejection] = useState<Rejection | null>(null)
  const [resume, setResume] = useState<Resume | null>(boot.resume)

  const sync = useCallback(() => setFiles(entries.current.map(view)), [])
  const store = useCallback((s: Session | null) => {
    saved.current = s
    if (s) saveSession(s)
    else clearSession()
    setResume(resumeOf(s, boundIds(entries.current)))
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
    return () => {
      ctl.current?.abort()
      list.current.forEach((e) => e.previewUrl && URL.revokeObjectURL(e.previewUrl))
    }
  }, [])

  const addFiles = useCallback(
    (picked: File[]) => {
      if (run.current) return
      const s = saved.current
      const taken = boundIds(entries.current)
      const known: Entry[] = []
      const fresh: File[] = []
      for (const f of picked) {
        // The same file twice would upload twice and spend one of the 3 places.
        if (entries.current.some((e) => sameFile(f, e.file))) continue
        const m = s?.files.find((sf) => !taken.has(sf.attachmentId) && sameFile(f, sf))
        if (!m) {
          fresh.push(f)
          continue
        }
        taken.add(m.attachmentId)
        known.push(entry(f, m.done ? 'done' : 'waiting', m.done ? f.size : 0, m))
      }
      // Saved attachments not picked again still hold a place on the server, so they count against the 3.
      const held = s ? s.files.filter((sf) => !taken.has(sf.attachmentId)).length : 0
      const { ok, rejection: why } = validatePick(entries.current.length + known.length + held, fresh)
      setRejection(why)
      entries.current = [...entries.current, ...known, ...ok.map((f) => entry(f, 'waiting', 0))]
      sync()
      setResume(resumeOf(s, boundIds(entries.current)))
    },
    [sync],
  )

  const removeFile = useCallback(
    (key: string) => {
      const e = entries.current.find((x) => x.key === key)
      if (!e || run.current || e.state === 'done') return
      if (e.previewUrl) URL.revokeObjectURL(e.previewUrl)
      entries.current = entries.current.filter((x) => x !== e)
      const s = saved.current
      const token = target.current?.reportToken ?? s?.reportToken
      if (e.att && token) {
        // Best effort: an attachment left behind is aborted by the worker's daily cleanup after 7 days.
        deleteAttachment(e.att.attachmentId, token).catch(() => {})
        if (s) store({ ...s, files: s.files.filter((f) => f.attachmentId !== e.att?.attachmentId) })
      }
      sync()
    },
    [sync, store],
  )

  const start = useCallback(
    async (t?: Target): Promise<boolean> => {
      if (run.current) return false
      const prev = saved.current
      const tgt = t ?? target.current ?? (prev ? { code: prev.code, reportToken: prev.reportToken } : null)
      if (entries.current.length === 0 || !tgt) {
        if (entries.current.length > 0) return false
        store(null)
        setPhase('done')
        return true
      }
      // Attachments bound to another report's session cannot be reused for this one.
      const same = prev?.code === tgt.code
      entries.current = entries.current.map((e) =>
        !same ? { ...e, att: undefined, state: 'waiting', confirmed: 0 } : e.state === 'done' ? e : { ...e, state: 'waiting' },
      )
      let s: Session = { v: 1, code: tgt.code, reportToken: tgt.reportToken, files: same ? prev.files : [] }
      target.current = tgt
      store(s)
      const ac = new AbortController()
      run.current = ac
      setPhase('uploading')
      sync()
      let current: string | null = null
      try {
        // Files go one after the other (see the pool note in uploader.ts); the list cannot change while `run` is set.
        for (const { key, file: f, att: known } of entries.current.filter((e) => e.state !== 'done')) {
          current = key
          let att = known
          if (!att) {
            const r = await createAttachment(tgt.code, tgt.reportToken, { filename: f.name, size: f.size, mime: f.type })
            // reset() may have come during the await: its cleared session must not be written back.
            if (ac.signal.aborted) return false
            att = { attachmentId: r.attachmentId, partSize: r.partSize, partCount: r.partCount }
            s = { ...s, files: [...s.files, { ...att, name: f.name, size: f.size, lastModified: f.lastModified, done: false }] }
            patch(key, { att })
            store(s)
          }
          patch(key, { state: 'uploading' })
          await uploadFile({
            file: f,
            ...att,
            token: tgt.reportToken,
            signal: ac.signal,
            onConfirmed: (b) => patch(key, { confirmed: b }),
          })
          const doneId = att.attachmentId
          s = { ...s, files: s.files.map((x) => (x.attachmentId === doneId ? { ...x, done: true } : x)) }
          patch(key, { state: 'done', confirmed: f.size })
          store(s)
        }
        store(null)
        setPhase('done')
        return true
      } catch {
        // A stop asked by reset() or unmount is not an error to show.
        if (ac.signal.aborted) return false
        if (current) patch(current, { state: 'error' })
        setPhase('error')
        return false
      } finally {
        if (run.current === ac) run.current = null
      }
    },
    [sync, store, patch],
  )

  const retry = useCallback(() => start(target.current ?? undefined), [start])

  const reset = useCallback(() => {
    run.current?.abort()
    run.current = null
    entries.current.forEach((e) => e.previewUrl && URL.revokeObjectURL(e.previewUrl))
    entries.current = []
    target.current = null
    store(null)
    sync()
    setPhase('idle')
    setRejection(null)
  }, [sync, store])

  const total = files.reduce((n, f) => n + f.size, 0)
  const progress = total > 0 ? files.reduce((n, f) => n + f.confirmed, 0) / total : phase === 'done' ? 1 : 0

  return { files, phase, rejection, progress, resume, addFiles, removeFile, start, retry, reset }
}

function entry(file: File, state: Entry['state'], confirmed: number, att?: SavedFile): Entry {
  const kind = file.type.startsWith('image/') ? 'image' : 'video'
  return {
    key: `f${++seq}`,
    file,
    kind,
    confirmed,
    state,
    // Only pictures get a thumbnail; a video's object URL would pin a 2 GB file for nothing.
    previewUrl: kind === 'image' ? URL.createObjectURL(file) : undefined,
    att: att && { attachmentId: att.attachmentId, partSize: att.partSize, partCount: att.partCount },
  }
}
