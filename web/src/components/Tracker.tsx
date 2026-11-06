import { useState } from 'react'
import { useI18n } from '../i18n'
import { Icon } from './Icons'

const STEP_ICONS = ['check', 'eye', 'wrench'] as const

// Steps before `done` are finished (green), step `now` is the current one (gold ring), the rest wait.
export function Tracker({ done, now }: { done: number; now?: number }) {
  const { t } = useI18n()
  return (
    <ol className="track">
      {t.track.map((label, i) => (
        <li key={i} className={i < done ? 'done' : i === now ? 'now' : undefined}>
          <b>
            <Icon name={STEP_ICONS[i] ?? 'check'} />
          </b>
          {label}
        </li>
      ))}
    </ol>
  )
}

// Preview screen 4, shared by the report and the add-a-video pages.
export function WeHaveIt({ code, onAgain }: { code: string; onAgain(): void }) {
  const { t } = useI18n()
  const [copied, setCopied] = useState(false)
  const copy = () => {
    // No clipboard (old browser, insecure origin): the code stays selectable, so nothing is lost.
    navigator.clipboard?.writeText(code).then(
      () => setCopied(true),
      () => setCopied(false),
    )
  }
  return (
    <>
      <span className="eyebrow" aria-hidden="true">
        ✓
      </span>
      <h1 className="gold">{t.h4}</h1>
      <p className="lead">{t.lead4}</p>
      <div className="code">
        <div className="label">{t.codeL}</div>
        <div className="val gold">{code}</div>
        <button type="button" className="btn ghost copy" onClick={copy} aria-live="polite">
          {copied ? t.copied : t.copy}
        </button>
      </div>
      <Tracker done={1} now={1} />
      <button type="button" className="btn gold-btn" onClick={onAgain}>
        {t.again}
      </button>
    </>
  )
}
