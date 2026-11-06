// What survives a reload: enough to find the same attachments again, never the bytes (the player re-picks the file).
// sessionStorage, not localStorage: the report token should not outlive the tab.
export type SavedFile = {
  attachmentId: string
  name: string
  size: number
  lastModified: number
  partSize: number
  partCount: number
  done: boolean
}
export type Session = { v: 1; code: string; reportToken: string; files: SavedFile[] }

const KEY = 'lumina-bug-upload'

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0
const isNat = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0

function isSavedFile(v: unknown): v is SavedFile {
  const f = v as Partial<SavedFile> | null
  return (
    !!f &&
    isStr(f.attachmentId) &&
    typeof f.name === 'string' &&
    isNat(f.size) &&
    isNat(f.lastModified) &&
    isNat(f.partSize) &&
    f.partSize > 0 &&
    isNat(f.partCount) &&
    f.partCount > 0 &&
    typeof f.done === 'boolean'
  )
}

function isSession(v: unknown): v is Session {
  const s = v as Partial<Session> | null
  return !!s && s.v === 1 && isStr(s.code) && isStr(s.reportToken) && Array.isArray(s.files) && s.files.every(isSavedFile)
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
