import { useRef, useState } from 'react'
import { useI18n } from '../i18n'
import type { FileItem, useUpload } from '../upload/useUpload'
import { Icon } from './Icons'

type Upload = ReturnType<typeof useUpload>

// Orange, never red: an error says what happened and what to do, it is not a punishment.
export function Err({ text }: { text: string }) {
  return (
    <div className="err" role="alert">
      <Icon name="info" size={22} />
      <span>{text}</span>
    </div>
  )
}

// Drop zone, file rows and the orange messages of steps 3 and 3e (and the add page).
// `locked`: the page is busy with its own request (create, attach-session) and the list must not change.
export function FilePicker({ up, locked }: { up: Upload; locked: boolean }) {
  const { t } = useI18n()
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const busy = locked || up.phase === 'uploading'

  const take = (list: FileList | null) => {
    if (busy || !list || list.length === 0) return
    const picked = Array.from(list)
    const missing = up.resume?.missing ?? []
    up.addFiles(picked)
    // After a reload, picking the last missing file is the whole action: the upload continues on the same report.
    const allBack = missing.every((m) => picked.some((f) => f.name === m.name && f.size === m.size))
    if (up.resume && missing.length > 0 && allBack) void up.start()
  }

  const why = up.rejection && { type: t.errType, size: t.errSize, count: t.errCount }[up.rejection]

  return (
    <>
      {up.phase === 'error' && <Err text={t.errUp} />}
      {why && up.phase !== 'error' && <Err text={why} />}
      {up.phase !== 'error' && (
        <button
          type="button"
          className={over ? 'drop over' : 'drop'}
          // aria-disabled, not disabled: a disabled button gets no drag events, and a file dropped on it would make
          // the browser open the file in place of the page, mid-upload.
          aria-disabled={busy}
          onClick={() => !busy && input.current?.click()}
          onDragOver={(e) => {
            e.preventDefault()
            if (!busy) setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault()
            setOver(false)
            take(e.dataTransfer.files)
          }}
        >
          <Icon name="video" />
          <span className="big">{t.pick}</span>
          <span className="small">{t.pickSub}</span>
        </button>
      )}
      {/* Outside the button, so its own click never bubbles back into the button's handler. */}
      <input
        ref={input}
        type="file"
        multiple
        accept="video/*,image/*"
        hidden
        tabIndex={-1}
        onChange={(e) => {
          take(e.currentTarget.files)
          // Cleared so choosing the same file again (resume, or after removing it) still fires a change.
          e.currentTarget.value = ''
        }}
      />
      {up.files.map((f) => (
        <FileRow key={f.key} f={f} />
      ))}
    </>
  )
}

function FileRow({ f }: { f: FileItem }) {
  const { t, lang } = useI18n()
  const pct = f.size > 0 ? Math.min(100, Math.floor((f.confirmed / f.size) * 100)) : 100
  // SI megabytes, as the preview's "312 MB"; one decimal under 10 MB so a small picture does not read "0 MB".
  const mb = new Intl.NumberFormat(lang, { maximumFractionDigits: f.size < 1e7 ? 1 : 0 }).format(
    Math.max(f.size / 1e6, 0.1),
  )
  const cls = f.state === 'done' ? 'file done' : f.state === 'error' ? 'file failed' : 'file'
  return (
    <div className={cls}>
      <div className="thumb" style={f.previewUrl ? { backgroundImage: `url("${f.previewUrl}")` } : undefined} />
      <div className="info">
        <div className="name">
          <b title={f.name}>{f.name}</b>
          <span>
            {mb} MB · {f.state === 'done' ? '✓' : `${pct}%`}
          </span>
        </div>
        <div
          className="bar"
          role="progressbar"
          aria-label={f.name}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <i style={{ width: `${pct}%` }} />
        </div>
        {f.state === 'uploading' && <div className="small">{t.up}</div>}
      </div>
    </div>
  )
}
