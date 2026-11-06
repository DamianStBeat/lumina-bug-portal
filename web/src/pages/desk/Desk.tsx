import { useCallback, useEffect, useRef, useState } from 'react'
import { deskList } from '../../api/client'
import type { DeskFilter, DeskListRes, DeskReportRow } from '../../api/types'
import { Icon } from '../../components/Icons'
import { useRoute } from '../../router'
import { ReportList } from './ReportList'
import { isDenied, ReportDetail } from './ReportDetail'
import './desk.css'

// Desk text is English only (team only), so it stays inline instead of in i18n.
const CODE = /^LUM-\d{6}$/

type List = { key: string; rows: DeskReportRow[]; cursor?: string; counts?: DeskListRes['counts']; failed?: boolean }

export default function Desk() {
  const { query } = useRoute()
  const [filter, setFilter] = useState<DeskFilter>('all')
  const [reload, setReload] = useState(0)
  const [list, setList] = useState<List>({ key: '', rows: [] })
  const [more, setMore] = useState(false)
  // The list key a Load more failed for: the rows already shown stay, one orange line says the next page did not come.
  const [moreFailed, setMoreFailed] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const detailRef = useRef<HTMLElement>(null)
  const key = `${filter}#${reload}`

  // Stable callbacks: ReportDetail refetches when they change, so a new function each render would loop.
  const deny = useCallback(() => setDenied(true), [])
  const fail = useCallback((e: unknown) => {
    if (isDenied(e)) setDenied(true)
  }, [])

  useEffect(() => {
    let live = true
    deskList(filter).then(
      (res) => live && setList({ key, rows: res.reports, cursor: res.cursor, counts: res.counts }),
      (e: unknown) => {
        if (!live) return
        fail(e)
        setList({ key, rows: [], failed: true })
      },
    )
    // A slow answer for a filter the reader already left must not overwrite the current one.
    return () => {
      live = false
    }
  }, [filter, key, fail])

  const loading = list.key !== key
  const rows = loading ? [] : list.rows
  const asked = query.get('code')?.toUpperCase() ?? ''
  // Without ?code= the newest report is shown, as in the preview; the URL is only written on a real choice.
  const code = CODE.test(asked) ? asked : (rows[0]?.code ?? null)

  function select(next: string) {
    // router.navigate() scrolls to the top, which would throw the reader off the list; the router also listens to
    // popstate, so a replaced URL plus that event keeps ?code= the single source of the selection.
    history.replaceState(null, '', `/desk?code=${encodeURIComponent(next)}`)
    window.dispatchEvent(new PopStateEvent('popstate'))
    if (window.matchMedia('(max-width: 1023px)').matches) detailRef.current?.scrollIntoView({ behavior: 'smooth' })
  }

  async function loadMore() {
    if (!list.cursor || more) return
    setMore(true)
    setMoreFailed(null)
    try {
      const res = await deskList(filter, list.cursor)
      setList((l) => {
        if (l.key !== key) return l
        const seen = new Set(l.rows.map((r) => r.code))
        return { ...l, rows: [...l.rows, ...res.reports.filter((r) => !seen.has(r.code))], cursor: res.cursor }
      })
    } catch (e) {
      fail(e)
      if (!isDenied(e)) setMoreFailed(key)
    } finally {
      setMore(false)
    }
  }

  // Mark fixed changed one report: its row takes the fresh fields, the attachment summary stays the list's.
  const patchRow = useCallback((next: Partial<DeskReportRow> & { code: string }) => {
    setList((l) => ({ ...l, rows: l.rows.map((r) => (r.code === next.code ? { ...r, ...next } : r)) }))
  }, [])

  return (
    <div className="desk">
      <header>
        <img src="/logo.webp" alt="" width={40} height={40} />
        <div className="site">
          Lumina bug desk
          <small>Team only</small>
        </div>
        <div className="lang">
          <Icon name="lock" /> Cloudflare Access
        </div>
      </header>
      {denied ? (
        <div className="dash one">
          <section className="glass detail">
            <p className="desk-line">Sign in through Cloudflare Access.</p>
          </section>
        </div>
      ) : (
        <div className="dash">
          <ReportList
            filter={filter}
            onFilter={setFilter}
            counts={list.counts}
            rows={rows}
            state={loading ? 'loading' : list.failed ? 'failed' : 'ready'}
            selected={code}
            onSelect={select}
            onRetry={() => setReload((n) => n + 1)}
            hasMore={!loading && !!list.cursor}
            loadingMore={more}
            moreFailed={moreFailed === key}
            onMore={loadMore}
          />
          <ReportDetail ref={detailRef} code={code} onDenied={deny} onChanged={patchRow} />
        </div>
      )}
    </div>
  )
}
