import { useEffect, useState } from 'react'
import { ApiError, getStatus } from '../api/client'
import type { PublicStatus } from '../api/types'
import { Err } from '../components/FilePicker'
import { Shell } from '../components/Shell'
import { Tracker } from '../components/Tracker'
import { useI18n } from '../i18n'
import { matchStatus, useRoute } from '../router'

type Loaded = { code: string; status?: PublicStatus; updatedAt?: number; fail?: 'missing' | 'network' }

const PUBLIC: readonly PublicStatus[] = ['received', 'looking', 'fixed', 'checked']
// Where each tracked state sits: finished steps, and the one being worked on.
const TRACK: Record<Exclude<PublicStatus, 'checked'>, { done: number; now?: number }> = {
  received: { done: 1 },
  looking: { done: 1, now: 1 },
  fixed: { done: 3 },
}

// Public status: the code, one of the four states and when it last changed. Nothing else about the report.
export default function Status() {
  const { t, lang } = useI18n()
  const { path } = useRoute()
  const code = matchStatus(path) ?? ''
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    getStatus(code).then(
      (r) =>
        // A state this page cannot name is shown as a failure, never as an empty tracker.
        live && setLoaded(PUBLIC.includes(r.status) ? { ...r, code } : { code, fail: 'network' }),
      (e: unknown) =>
        live && setLoaded({ code, fail: e instanceof ApiError && e.status === 404 ? 'missing' : 'network' }),
    )
    return () => {
      live = false
    }
  }, [code, attempt])

  // An answer for another code (the address changed while loading) is not this page's answer.
  const r = loaded?.code === code ? loaded : null
  const date =
    typeof r?.updatedAt === 'number' && Number.isFinite(r.updatedAt)
      ? new Date(r.updatedAt).toLocaleDateString(lang, { day: 'numeric', month: 'long', year: 'numeric' })
      : null

  return (
    <Shell>
      <span className="eyebrow">{code}</span>
      <h1 className="gold">{t.statusH}</h1>
      {!r && (
        <p className="lead" role="status">
          {t.loading}
        </p>
      )}
      {r?.fail === 'missing' && <Err text={t.errCode} />}
      {r?.fail === 'network' && (
        <>
          <Err text={t.errLoad} />
          <button
            type="button"
            className="btn gold-btn"
            onClick={() => {
              setLoaded(null)
              setAttempt((n) => n + 1)
            }}
          >
            {t.retry}
          </button>
        </>
      )}
      {r?.status && (
        <>
          <p className="lead">{t.statusLead}</p>
          {r.status !== 'checked' && <Tracker {...TRACK[r.status]} />}
          <p className="state">{t.status[r.status]}</p>
          {date && <p className="small">{t.updated(date)}</p>}
        </>
      )}
    </Shell>
  )
}
