// Mirrors CONTRACT.md "Limits", checked before any byte leaves the device (acceptance row 6).
export type Rejection = 'type' | 'size' | 'count'
export const MAX_FILES = 3
export const MAX_BYTES = 2 * 1024 ** 3

// The mime the browser reports is what the worker sees declared; an empty one (unknown extension) is refused too.
function isMedia(f: File): boolean {
  return f.type.startsWith('video/') || f.type.startsWith('image/')
}

// Good files are kept even when others in the same pick are refused; `rejection` names the first refusal, so the
// page can say why something is missing from the list.
export function validatePick(existing: number, picked: File[]): { ok: File[]; rejection: Rejection | null } {
  const ok: File[] = []
  let rejection: Rejection | null = null
  for (const f of picked) {
    let why: Rejection | null = null
    if (!isMedia(f)) why = 'type'
    else if (f.size > MAX_BYTES) why = 'size'
    else if (existing + ok.length >= MAX_FILES) why = 'count'
    if (why) rejection ??= why
    else ok.push(f)
  }
  return { ok, rejection }
}
