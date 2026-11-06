import { useEffect, useState } from 'react'
import type { DeskFilter, DeskListRes, DeskReportRow, ReportStatus, Verdict } from '../../api/types'

const FILTERS: [DeskFilter, string][] = [
  ['all', 'All'],
  ['fix_ready', 'Fix ready'],
  ['needs_person', 'Needs a person'],
  ['duplicate', 'Duplicates'],
  ['not_bug', 'Not a bug'],
  ['waiting', 'Waiting for AI'],
]
const WHERE: Record<string, string> = {
  match: 'Match',
  lobby: 'Lobby',
  shop: 'Shop',
  crates: 'Crates',
  clan: 'Clan',
  other: 'Other',
}
const DEVICE: Record<string, string> = { phone: 'Phone', tablet: 'Tablet', computer: 'Computer', console: 'Console' }
// The chip class and the words of each verdict; the detail's AI panel reads the same words, so both say one thing.
export const VERDICT: Record<Verdict, [string, string]> = {
  simple_fix: ['t-fix', 'Simple fix'],
  needs_person: ['t-human', 'Needs a person'],
  duplicate: ['t-dup', 'Duplicate'],
  not_bug: ['t-not', 'Not a bug'],
  unclear: ['t-human', 'Unclear'],
}
const STATUS: Record<ReportStatus, string> = {
  received: 'Received',
  looking: 'Looking into it',
  fixed: 'Fixed',
  duplicate: 'Linked',
  not_bug: 'Closed',
  closed: 'Closed',
}

export function ago(ms: number, now: number): string {
  const min = Math.floor((now - ms) / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  if (min < 48 * 60) return `${Math.floor(min / 60)} h ago`
  return `${Math.floor(min / 1440)} d ago`
}

// Only a github.com pull request becomes a link: prUrl is written by the agent and must not point anywhere else.
export function githubPr(url: string | undefined): { href: string; n?: string } | null {
  if (!url) return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' || u.hostname !== 'github.com') return null
    return { href: u.href, n: /\/pull\/(\d+)/.exec(u.pathname)?.[1] }
  } catch {
    return null
  }
}

// The list answer counts the player's files without their kind or size; the detail shows which file it is.
function media(files: number, device?: string): string {
  const where = device && DEVICE[device] ? ` · ${DEVICE[device]}` : ''
  if (files > 0) return `${files > 1 ? `${files} files` : '1 file'}${where}`
  return 'No video'
}

function Row({ r, now, sel, onSelect }: { r: DeskReportRow; now: number; sel: boolean; onSelect: () => void }) {
  const [tag, label] = r.verdict ? VERDICT[r.verdict] : ['t-wait', 'Waiting for AI']
  const pr = githubPr(r.prUrl)
  const open = r.status === 'received' || r.status === 'looking'
  const head = pr && open ? `PR #${pr.n ?? ''}`.trim() : STATUS[r.status]
  const tail = pr && open ? STATUS[r.status] : r.updatedAt - r.createdAt > 60_000 ? `updated ${ago(r.updatedAt, now)}` : ''
  return (
    <li>
      <button type="button" className={sel ? 'desk-row sel' : 'desk-row'} aria-current={sel} onClick={onSelect}>
        <span className="c-code">
          <b>{r.code}</b>
          <span className="sub">{ago(r.createdAt, now)}</span>
        </span>
        <span className="c-what">
          {r.title || r.what}
          <span className="sub">{media(r.fileCount, r.device)}</span>
        </span>
        <span className="c-where">{(r.whereArea && WHERE[r.whereArea]) || '—'}</span>
        <span className="c-ai">
          <span className={`tag ${tag}`}>{label}</span>
          {r.verdict === 'duplicate' && r.duplicateOf && <span className="sub">of {r.duplicateOf}</span>}
        </span>
        <span className="c-status">
          {head}
          {tail && <span className="sub">{tail}</span>}
        </span>
      </button>
    </li>
  )
}

type Props = {
  filter: DeskFilter
  onFilter: (f: DeskFilter) => void
  counts: DeskListRes['counts']
  rows: DeskReportRow[]
  state: 'loading' | 'failed' | 'ready'
  selected: string | null
  onSelect: (code: string) => void
  onRetry: () => void
  hasMore: boolean
  loadingMore: boolean
  moreFailed: boolean
  onMore: () => void
}

export function ReportList(p: Props) {
  // Relative times move on their own; a minute tick is as fine as the labels get.
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  return (
    <section className="glass detail desk-list" aria-label="Reports">
      <h2 className="gold">Reports</h2>
      <div className="filters" role="group" aria-label="Filter">
        {FILTERS.map(([f, label]) => {
          const n = p.counts?.[f]
          return (
            <button key={f} type="button" className={f === p.filter ? 'on' : ''} aria-pressed={f === p.filter}
              onClick={() => p.onFilter(f)}>
              {n === undefined ? label : `${label} · ${n}`}
            </button>
          )
        })}
      </div>
      <div className="desk-th" aria-hidden="true">
        <span>Code</span>
        <span>What the player wrote</span>
        <span>Where</span>
        <span>AI verdict</span>
        <span>Status</span>
      </div>
      {p.state === 'loading' && <p className="desk-line">Loading reports…</p>}
      {p.state === 'failed' && (
        <p className="desk-line desk-err">
          The reports did not load.{' '}
          <button type="button" className="desk-link" onClick={p.onRetry}>
            Try again
          </button>
        </p>
      )}
      {p.state === 'ready' && p.rows.length === 0 && <p className="desk-line">No reports here.</p>}
      <ul className="desk-rows">
        {p.rows.map((r) => (
          <Row key={r.code} r={r} now={now} sel={r.code === p.selected} onSelect={() => p.onSelect(r.code)} />
        ))}
      </ul>
      {p.moreFailed && <p className="desk-line desk-err">More reports did not load. Press Load more to try again.</p>}
      {p.hasMore && (
        <button type="button" className="btn ghost desk-more" disabled={p.loadingMore} onClick={p.onMore}>
          {p.loadingMore ? 'Loading…' : 'Load more'}
        </button>
      )}
    </section>
  )
}
