import { useEffect, useState, useSyncExternalStore } from 'react'
import { ApiError, createAttachment, deleteAttachment } from '../api/client'
import { clearSession, loadSession, saveSession, type Session } from './session'
import { retryable, uploadFile } from './uploader'
import { adoptInto, adoptOut, initial, reduce, resumeOf, unremoved, viewState, type Effect, type Event, type Item, type Refusal, type Stage, type State } from './queue'
import type { Rejection } from './validate'

// The hook only dispatches the player's actions and the answers of the requests it ran to the queue (queue.ts), and
// runs the effects the queue asks for. Whether an answer still counts, what a Remove or a Send may do now, and what
// the session holds are the queue's to decide: every answer goes back with the key, generation and epoch it was asked
// under, and one of an old generation or epoch changes nothing (no state, no storage).
export type { Phase, Refusal, Target } from './queue'
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
// What the identity reads from the start of a file: enough to tell two exports apart, little enough for a phone.
const HEAD_BYTES = 1024 * 1024

let seq = 0
let picks = 0
// The mounted queue: a removed file's create answering after its page was left is adopted by it, so a failed DELETE
// stays tracked there (held place, sent again by a pick that needs it).
let owner: { dispatch: (e: Event) => void; adopts: () => boolean } | null = null
// The page that takes a late create's line. Never one with no session of its own while storage holds one (a report's
// upload `only` hid from it): the session it would make would be saved over that upload. The line goes the no-page way.
const adopter = () => (owner?.adopts() ? owner : null)

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
// True when the attachment is gone: 2xx { ok: true } (deleteAttachment), or 404, already gone. Any other failure is
// false, never a throw: the queue then keeps the line marked and its place held.
const gone = (id: string, token: string): Promise<boolean> =>
  deleteAttachment(id, token).then(
    () => true,
    (err: unknown) => err instanceof ApiError && err.status === 404,
  )

const SERVER_REFUSAL: Record<string, Rejection> = {
  invalid_mime: 'type',
  file_too_large: 'size',
  too_many_files: 'count',
}
// null: Try again can work (the network, the server, parts the server lost). Anything else is a refusal. A network
// lost for good arrives here as status 0 'network' after uploader.ts waited for 'online' and spent its retries: the
// file fails with no reason, the phase is 'error' and Try again carries on (paused is only the wait before that).
function refusalOf(e: unknown): Refusal | null {
  if (!(e instanceof ApiError)) return 'other'
  // Status 0 is also the uploader's own 'bad_parts' (the file does not fit the server's parts): not the network.
  if (e.code === 'missing_parts' || (e.status === 0 ? e.code === 'network' : retryable(e))) return null
  return SERVER_REFUSAL[e.code] ?? 'other'
}

// `only`: the report the page was asked for (useUpload): another report's saved upload is not this page's.
const stored = (only?: string): Session | null => {
  const found = loadSession()
  return found && only && found.code !== only ? null : found
}

// What React reads: replaced as a whole on every change, so a FileItem handed to it never changes under it.
type View = { s: State; files: FileItem[] }
// `taken`: false when the queue changed nothing for the event (a Send while one is going, a Remove of a file gone).
type Inbox = { e: Event; then?: (taken: boolean) => void }

// One upload queue: its state, the effects it asks for, and who waits on start() and removeFile(). No React here, so
// a callback the page keeps (addFiles, start, ...) is the same function for the life of the page.
function machine(boot: Session | null, only?: string) {
  let s = initial(boot)
  let view: View = { s, files: [] }
  const watchers = new Set<() => void>()
  const inbox: Inbox[] = []
  let looping = false
  // Only to stop the requests of a file (abort) or of all (stop); whether an answer counts is the queue's.
  const ctl = new Map<string, AbortController>()
  const previews = new Map<string, string>()
  const backs = new Map<number, () => void>()
  const sends: ((ok: boolean) => void)[] = []
  const removals: { key: string; done: () => void }[] = []

  const self = { dispatch: (e: Event) => dispatch(e), adopts: () => s.session !== null || loadSession() === null }
  const ticket = (f: { key: string; gen: number; epoch: number }) => ({ key: f.key, gen: f.gen, epoch: f.epoch })
  const controller = (key: string) => {
    const ac = new AbortController()
    ctl.set(key, ac)
    return ac
  }
  const release = (key: string, ac: AbortController) => {
    if (ctl.get(key) === ac) ctl.delete(key)
  }

  function run(f: Effect): void {
    switch (f.t) {
      case 'hash':
        void hashHead(f.file).then((head) => dispatch({ t: 'hashed', ...ticket(f), head }))
        return
      case 'create': {
        const ac = controller(f.key)
        createAttachment(f.target.code, f.target.reportToken, f.body, ac.signal).then(
          (r) => {
            release(f.key, ac)
            const att = { attachmentId: r.attachmentId, partSize: r.partSize, partCount: r.partCount }
            dispatch({ t: 'created', ...ticket(f), att })
          },
          (err: unknown) => {
            release(f.key, ac)
            dispatch({ t: 'failed', ...ticket(f), why: refusalOf(err) })
          },
        )
        return
      }
      case 'upload': {
        const ac = controller(f.key)
        const onConfirmed = (bytes: number) => dispatch({ t: 'confirmed', ...ticket(f), bytes })
        const onStage = (stage: Stage) => dispatch({ t: 'stage', ...ticket(f), stage })
        uploadFile({ file: f.file, ...f.att, token: f.token, signal: ac.signal, onConfirmed, onStage }).then(
          () => {
            release(f.key, ac)
            dispatch({ t: 'uploaded', ...ticket(f) })
          },
          (err: unknown) => {
            release(f.key, ac)
            dispatch({ t: 'failed', ...ticket(f), why: refusalOf(err) })
          },
        )
        return
      }
      case 'abort':
        ctl.get(f.key)?.abort()
        ctl.delete(f.key)
        return
      case 'stop':
        // `keep`: creates of removed files, let answer so the queue can delete what they made.
        ctl.forEach((ac, key) => {
          if (f.keep?.includes(key)) return
          ac.abort()
          ctl.delete(key)
        })
        return
      case 'delete':
        void gone(f.id, f.token).then((g) => dispatch({ t: 'deleted', id: f.id, epoch: f.epoch, by: f.by, gone: g }))
        return
      case 'adopt': {
        const page = adopter()
        if (page) return page.dispatch(f)
        // No page that can take it: the line goes into storage (of its report only, or empty) before the DELETE leaves.
        // A reload ends this tab's callback, so whatever waited for the DELETE's answer would be lost with the id, and
        // the next load could not send it again. A gone answer takes the line out again, from a session of its report
        // only, so storage ends as the close left it. A failed one stays written down: the next load sends it again, and
        // a page opened since read it and sent its own. Only when storage lost it meanwhile is it handed on or written again.
        const before = loadSession()
        const written = adoptInto(before, f)
        if (written) saveSession(written)
        void gone(f.line.attachmentId, f.token).then((g) => {
          if (g) {
            const back = adoptOut(loadSession(), f, before)
            if (back) saveSession(back)
            else if (back === null) clearSession()
            return
          }
          const now = loadSession()
          if (now?.files.some((l) => l.attachmentId === f.line.attachmentId)) return
          const since = adopter()
          if (since) return since.dispatch(f)
          const next = adoptInto(now, f)
          if (next) saveSession(next)
        })
        return
      }
      case 'save':
        if (f.session) saveSession(f.session)
        else clearSession()
        return
      case 'back': {
        const cb = backs.get(f.pick)
        backs.delete(f.pick)
        cb?.()
        return
      }
      case 'forget': {
        const url = previews.get(f.key)
        if (url) URL.revokeObjectURL(url)
        previews.delete(f.key)
        return
      }
    }
  }

  // Waiters: a Send settles when the queue has no Send any more; a Remove when its job ran and its DELETE was answered.
  function wake(): void {
    if (!s.send) sends.splice(0).forEach((done) => done(s.phase === 'done'))
    for (let i = removals.length - 1; i >= 0; i--) {
      const { key, done } = removals[i] as (typeof removals)[number]
      const queued = s.jobs.some((j) => j.k === 'remove' && j.key === key)
      if (queued || s.items.find((x) => x.key === key)?.step === 'removing') continue
      removals.splice(i, 1)
      done()
    }
  }

  const fileOf = (it: Item): FileItem => {
    const kind = it.file.type.startsWith('image/') ? 'image' : 'video'
    // Only pictures get a thumbnail; a video's object URL would pin a 2 GB file for nothing.
    if (kind === 'image' && !previews.has(it.key)) previews.set(it.key, URL.createObjectURL(it.file))
    const { key, file, confirmed, why } = it
    return { key, name: file.name, size: file.size, kind, confirmed, state: viewState(it), why, previewUrl: previews.get(key) }
  }

  // Events are handled one at a time, in order: one dispatched by an effect (onBack starting the upload, a request
  // answered at once) waits for the effects before it. Effects run only when the queue returned a new state.
  function dispatch(e: Event, then?: (taken: boolean) => void): void {
    inbox.push({ e, then })
    if (looping) return
    looping = true
    const before = s
    try {
      for (let next = inbox.shift(); next; next = inbox.shift()) {
        const prev = s
        s = reduce(prev, next.e)
        if (s !== prev) s.fx.forEach(run)
        next.then?.(s !== prev)
        wake()
      }
    } finally {
      looping = false
    }
    // A pick's onBack is kept while the pick is queued; a pick decided without it has nothing to call.
    for (const p of backs.keys()) if (!s.jobs.some((j) => j.k !== 'remove' && j.pick === p)) backs.delete(p)
    if (s === before) return
    view = { s, files: s.items.map(fileOf) }
    watchers.forEach((w) => w())
  }

  return {
    get: () => view,
    watch(w: () => void) {
      watchers.add(w)
      return () => {
        watchers.delete(w)
      }
    },
    dispatch,
    // Taken by a page before its own await (createReport, attachSession): false afterwards when the page was left or
    // reset meanwhile, so a late answer never starts an upload nor overwrites the session of the one made since.
    guard() {
      const at = s.epoch
      return () => s.epoch === at
    },
    // `onBack`: called when the pick turns out to bring back the last saved file still missing, which after a reload
    // is the whole action (FilePicker then starts the upload). Returns nothing on purpose: a pick whose outcome no hash
    // can change is listed within this call, so the page (and React's act) sees the list at once.
    addFiles(picked: File[], onBack?: () => void): void {
      const pick = ++picks
      if (onBack) backs.set(pick, onBack)
      dispatch({ t: 'pick', pick, files: picked.map((file) => ({ key: `f${++seq}`, file })) })
    },
    // Resolves once the Remove took effect: the file left, or its DELETE failed and its line stays (unremoved).
    removeFile(key: string): Promise<void> {
      return new Promise((done) => dispatch({ t: 'remove', key }, (taken) => (taken ? removals.push({ key, done }) : done())))
    },
    // Resolves once the upload settles: true when every file is done, false on a failure, a refusal or a reset.
    start(t?: { code: string; reportToken: string }): Promise<boolean> {
      return new Promise((done) => dispatch({ t: 'send', target: t }, (taken) => (taken ? sends.push(done) : done(false))))
    },
    reset: () => dispatch({ t: 'reset' }),
    mount() {
      owner = self
      dispatch({ t: 'mount', stored: stored(only) })
    },
    close() {
      if (owner === self) owner = null
      dispatch({ t: 'closed' })
    },
  }
}

// `only`: the report the page was asked for. A saved upload of another report is not offered here and never used for
// this one; it stays in storage until an upload to this report replaces it.
export function useUpload(only?: string) {
  const [m] = useState(() => machine(stored(only), only))
  const { s, files } = useSyncExternalStore(m.watch, m.get)

  // The load sends again the DELETE of a Remove the last visit never saw answered; leaving the page stops every
  // create and upload (but a removed file's create, whose attachment is then deleted), and moves the epoch so nothing
  // answered afterwards writes state or storage. Storage is read again at mount for what a late create wrote since boot.
  useEffect(() => {
    m.mount()
    return m.close
  }, [m])

  const total = files.reduce((n, f) => n + f.size, 0)
  const progress = total > 0 ? files.reduce((n, f) => n + f.confirmed, 0) / total : s.phase === 'done' ? 1 : 0

  return {
    files,
    phase: s.phase,
    rejection: s.rejection,
    refused: files.find((f) => f.state === 'refused')?.why ?? null,
    progress,
    resume: resumeOf(s),
    // A removed file whose attachment is being deleted; and one whose delete failed, which stays in the list.
    removing: s.items.some((x) => x.step === 'removing'),
    unremoved: unremoved(s),
    addFiles: m.addFiles,
    removeFile: m.removeFile,
    start: m.start,
    retry: m.start,
    reset: m.reset,
    guard: m.guard,
  }
}
