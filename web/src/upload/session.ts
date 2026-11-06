// What survives a reload: enough to find the same attachments again, never the bytes (the player re-picks the file).
// sessionStorage, not localStorage: the report token should not outlive the tab.
// A file is saved before its attachment is asked for, so a reload at any moment finds it: `attachmentId: null` means
// "not created yet" (create it on resume), never "failed".
// `head`: SHA-256 (hex) of the file's first 1 MiB. With name and size it is how a re-picked file is known again;
// lastModified is not kept, since iPhone Photos gives the same video a new one on every export. null: the browser
// could not hash it (no crypto.subtle, file unreadable), so name and size are all there is (useUpload.ts, sameFile).
// `removing: true`: the player pressed Remove and the DELETE of its attachment has not been answered 2xx { ok: true }
// or 404 yet. Such a line is never offered for resume; it still holds one of the 3 places, as the server still counts
// its attachment, and the next load sends the DELETE again.
export type SavedFile = { name: string; size: number; head: string | null; done: boolean } & (
  | { attachmentId: null }
  | { attachmentId: string; partSize: number; partCount: number; removing?: true }
)
// v3: lines carry `head` in place of lastModified. A v2 session is dropped on load like any value we cannot trust.
export type Session = { v: 3; code: string; reportToken: string; files: SavedFile[] }

const KEY = 'lumina-bug-upload'

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNat = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isHead = (v: unknown): v is string | null => v === null || (typeof v === 'string' && /^[0-9a-f]{64}$/.test(v))

function isSavedFile(v: unknown): v is SavedFile {
  const f = v as Record<string, unknown> | null
  if (!f || typeof f.name !== 'string' || !isNat(f.size) || !isHead(f.head) || typeof f.done !== 'boolean') {
    return false
  }
  // Not created yet cannot be done, nor be removing (it goes at once, with no DELETE); created needs the part layout
  // the server gave.
  if (f.attachmentId === null) return !f.done && f.removing === undefined
  if (f.removing !== undefined && f.removing !== true) return false
  return isStr(f.attachmentId) && isNat(f.partSize) && f.partSize > 0 && isNat(f.partCount) && f.partCount > 0
}

function isSession(v: unknown): v is Session {
  const s = v as Partial<Session> | null
  return !!s && s.v === 3 && isStr(s.code) && isStr(s.reportToken) && Array.isArray(s.files) && s.files.every(isSavedFile)
}

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (isSession(parsed)) return parsed
    // A value we cannot trust would bind a re-picked file to the wrong attachment: drop it.
    sessionStorage.removeItem(KEY)
  } catch {
    // Storage blocked or JSON broken: behave as a fresh visit.
    clearSession()
  }
  return null
}

export function saveSession(s: Session): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    // Without storage the upload still works; only resume after a reload is lost.
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // Nothing stored, nothing to clear.
  }
}
