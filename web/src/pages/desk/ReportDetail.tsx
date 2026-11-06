import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { ApiError, deskReport, deskSetStatus, deskStreamUrl } from '../../api/client'
import type { DeskReport, DeskReportRow, DeskTriage } from '../../api/types'
import { Icon } from '../../components/Icons'
import { githubPr } from './ReportList'

// Cloudflare Access sits in front of /desk; a 401/403 means the session is missing, never "no reports".
export const isDenied = (e: unknown) => e instanceof ApiError && (e.status === 401 || e.status === 403)

type Loaded = { code: string; report?: DeskReport; missing?: boolean }

// The triage JSON is free-form: a field counts only when it really is text, whatever the type says.
const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

// `x` in the AI's text is a code reference; it is shown as a code span, still as plain text (never as HTML).
function spans(s: string): ReactNode[] {
  const parts = s.split('`')
  return parts.map((part, i) => {
    const closed = i % 2 === 1 && i < parts.length - 1
    if (closed) return <code key={i}>{part}</code>
    return i % 2 === 1 ? `\`${part}` : part
  })
}

function lines(t: DeskTriage): [string, string][] {
  const same = Array.isArray(t.sameAs) ? t.sameAs.filter((c): c is string => typeof c === 'string') : []
  const all: [string, string | undefined][] = [
    ['What it is', text(t.summary)],
    ['Likely cause', text(t.cause)],
    ['Risk path', text(t.riskPath)],
    ['Same bug', same.length ? same.join(', ') : undefined],
    ['Fix', text(t.fix)],
  ]
  return all.filter((l): l is [string, string] => l[1] !== undefined)
}

function clock(secs: number): string {
  const s = Math.floor(secs)
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60))
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${mm.padStart(2, '0')}:${ss}` : `${mm}:${ss}`
}

type Props = {
  ref?: Ref<HTMLElement>
  code: string | null
  onDenied: () => void
  onChanged: (row: Partial<DeskReportRow> & { code: string }) => void
}

export function ReportDetail({ ref, code, onDenied, onChanged }: Props) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [nonce, setNonce] = useState(0)
  const [dur, setDur] = useState<{ id: string; secs: number } | null>(null)
  const [big, setBig] = useState<{ code: string; id: string; alt: string } | null>(null)
  const [sending, setSending] = useState<string | null>(null)
  const [failedFor, setFailedFor] = useState<string | null>(null)
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    if (!code) return
    let live = true
    deskReport(code).then(
      (r) => {
        if (!live) return
        setLoaded({ code, report: r })
        // The row in the list is refreshed from every detail answer, so both always show the same state.
        const { status, updatedAt, prUrl, verdict, duplicateOf } = r
        onChanged({ code, status, updatedAt, prUrl, verdict, duplicateOf })
      },
      (e: unknown) => {
        if (!live) return
        if (isDenied(e)) onDenied()
        setLoaded({ code, missing: e instanceof ApiError && e.status === 404 })
      },
    )
    return () => {
      live = false
    }
  }, [code, nonce, onChanged, onDenied])

  const shown = big && big.code === code ? big : null
  useEffect(() => {
    if (shown && dialog.current && !dialog.current.open) dialog.current.showModal()
  }, [shown])

  async function markFixed() {
    if (!code || sending) return
    setSending(code)
    setFailedFor(null)
    try {
      await deskSetStatus(code, { status: 'fixed' })
      setNonce((n) => n + 1)
    } catch (e) {
      if (isDenied(e)) onDenied()
      setFailedFor(code)
    } finally {
      setSending(null)
    }
  }

  const frame = (body: ReactNode) => (
    <section ref={ref} className="glass detail desk-detail" aria-label="Selected report">
      {body}
    </section>
  )
  if (!code) return frame(null)
  // A refresh of the same report keeps the old one on screen, so the video does not restart.
  if (!loaded || loaded.code !== code) return frame(<p className="desk-line">Loading the report…</p>)
  const r = loaded.report
  if (!r) {
    const why = loaded.missing ? 'No report with this code.' : 'This report did not load.'
    return frame(<p className="desk-line desk-err">{why}</p>)
  }

  const files = r.attachments.filter((a) => a.status === 'complete')
  const media = files.find((a) => a.kind === 'video') ?? files.find((a) => a.kind === 'image')
  const frames = r.frames.filter((a) => a.status === 'complete')
  const hits = new Set(Array.isArray(r.triage?.frameHits) ? r.triage.frameHits : [])
  const ai = r.triage ? lines(r.triage) : []
  const pr = githubPr(r.prUrl)
  const secs = media && dur?.id === media.id ? dur.secs : undefined

  return frame(
    <>
      <h2>{r.code}</h2>
      {media ? (
        <>
          <div className="video live">
            {media.kind === 'video' ? (
              <video key={media.id} controls preload="metadata" src={deskStreamUrl(media.id)}
                onLoadedMetadata={(e) => setDur({ id: media.id, secs: e.currentTarget.duration })} />
            ) : (
              <img src={deskStreamUrl(media.id)} alt={`Picture ${media.filename}`} />
            )}
          </div>
          <p className="desk-meta">
            {[media.filename, secs !== undefined && Number.isFinite(secs) ? clock(secs) : null, media.kind === 'video' ? 'plays from private storage' : 'from private storage']
              .filter(Boolean)
              .join(' · ')}
          </p>
        </>
      ) : (
        <p className="desk-line">No video or picture.</p>
      )}
      {frames.length > 0 && (
        <div className="frames">
          {frames.map((f, i) => {
            const alt = hits.has(i + 1) ? `Frame ${i + 1}, marked by the AI` : `Frame ${i + 1}`
            return (
              <button key={f.id} type="button" aria-label={`Open ${alt.toLowerCase()}`}
                onClick={() => setBig({ code: r.code, id: f.id, alt })}>
                <img src={deskStreamUrl(f.id)} alt="" loading="lazy" className={hits.has(i + 1) ? 'hit' : ''} />
              </button>
            )
          })}
        </div>
      )}
      <div className="ai">
        <h4>AI triage · read-only</h4>
        {ai.length ? (
          <ul>
            {ai.map(([k, v]) => (
              <li key={k}>
                <b>{k}:</b> {spans(v)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="desk-line">The AI has not looked at this report yet.</p>
        )}
      </div>
      <div className="actions">
        {pr && (
          <a className="btn gold-btn" href={pr.href} target="_blank" rel="noopener noreferrer">
            {pr.n ? `Open PR #${pr.n}` : 'Open PR'}
          </a>
        )}
        <button type="button" className="btn" disabled={!!sending || r.status === 'fixed'} onClick={markFixed}>
          {r.status === 'fixed' ? 'Fixed' : sending === r.code ? 'Marking…' : 'Mark fixed'}
        </button>
      </div>
      {failedFor === r.code && <p className="desk-line desk-err">It was not marked fixed. Try again.</p>}
      <div className="lock">
        <Icon name="lock" />
        <span>The AI read the code on Valor1. The player's text was treated as data. No code left the server.</span>
      </div>
      {shown && (
        <dialog ref={dialog} className="desk-big" aria-label={shown.alt} onClose={() => setBig(null)}
          onClick={(e) => e.target === e.currentTarget && e.currentTarget.close()}>
          <img src={deskStreamUrl(shown.id)} alt={shown.alt} />
          <button type="button" className="btn ghost" onClick={() => dialog.current?.close()}>
            Close
          </button>
        </dialog>
      )}
    </>,
  )
}
