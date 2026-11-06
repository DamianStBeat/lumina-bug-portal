import { useEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { ApiError, deskReport, deskSetStatus, deskStreamUrl } from '../../api/client'
import type { DeskReport, DeskReportRow, DeskTriage, Verdict } from '../../api/types'
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

// The stages and each likely file count only as objects; anything else is a stage or a file with no answer.
const record = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

// The list's words for each verdict (ReportList VERDICT), so the panel says what the row says.
const VERDICT: Record<Verdict, string> = {
  simple_fix: 'Simple fix',
  needs_person: 'Needs a person',
  duplicate: 'Duplicate',
  not_bug: 'Not a bug',
  unclear: 'Unclear',
}

// `path:line` then why: line 0 is a line, a null line leaves the path alone, an item without a text path is dropped.
function likelyFiles(v: unknown): ReactNode[] {
  return (Array.isArray(v) ? v : []).flatMap((item) => {
    const f = record(item)
    const path = text(f?.path)
    if (!f || !path) return []
    const at = typeof f.line === 'number' && Number.isInteger(f.line) && f.line >= 0 ? `:${f.line}` : ''
    const why = text(f.why)
    return [<><code>{path + at}</code>{why && <> {spans(why)}</>}</>]
  })
}

// The verdict is the report's and has no label in the preview's panel: when the agent failed or the triage was too
// large for the worker both stages are null, but the AI did read the report.
function lines(verdict: unknown, t: DeskTriage | undefined): [string | null, ReactNode][] {
  const a = record(t?.stage_a)
  const b = record(t?.stage_b)
  const what = text(a?.what)
  const cause = text(b?.summary)
  const why = [...(cause ? [spans(cause)] : []), ...likelyFiles(b?.likely_files)]
  const risks = Array.isArray(b?.risk_paths) ? b.risk_paths.map(text).filter((s) => s !== undefined) : []
  const fix = b?.fix_size
  const all: [string | null, ReactNode | undefined][] = [
    [null, typeof verdict === 'string' && Object.hasOwn(VERDICT, verdict) ? VERDICT[verdict as Verdict] : undefined],
    ['What it is', what && spans(what)],
    ['Likely cause', why.length ? why.map((n, i) => <span key={i}>{i > 0 && '; '}{n}</span>) : undefined],
    ['Risk path', risks.length ? risks.join(', ') : undefined],
    ['Same bug', text(b?.duplicate_of)],
    ['Fix', typeof fix === 'string' && ['small', 'medium', 'large', 'unknown'].includes(fix) ? fix : undefined],
  ]
  return all.filter((l): l is [string | null, ReactNode] => l[1] !== undefined)
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
  // Nothing to play yet is not the same as nothing sent: a file still arriving says so.
  const pending = r.attachments.some((a) => a.status === 'uploading' && (a.kind === 'video' || a.kind === 'image'))
  const frames = r.frames.filter((a) => a.status === 'complete')
  const ai = lines(r.verdict, r.triage)
  const pr = githubPr(r.prUrl)
  const secs = media && dur?.id === media.id ? dur.secs : undefined

  return frame(
    <>
      <h2>{r.code}</h2>
      {media ? (
        <>
          <div className="video live">
            {media.kind === 'video' ? (
              // The first frame as poster: without it the player is a black box until play.
              <video key={media.id} controls preload="metadata" src={deskStreamUrl(media.id)}
                poster={frames[0] ? deskStreamUrl(frames[0].id) : undefined}
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
        <p className="desk-line">{pending ? 'Still uploading.' : 'No video or picture.'}</p>
      )}
      {frames.length > 0 && (
        <div className="frames">
          {frames.map((f, i) => {
            // The agent's triage names no frame, so none is marked as the AI's.
            const alt = `Frame ${i + 1}`
            return (
              <button key={f.id} type="button" aria-label={`Open ${alt.toLowerCase()}`}
                onClick={() => setBig({ code: r.code, id: f.id, alt })}>
                <img src={deskStreamUrl(f.id)} alt="" loading="lazy" />
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
              <li key={k ?? 'verdict'}>
                {k ? <><b>{k}:</b> {v}</> : <b>{v}</b>}
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
