import { useId, useRef, useState } from 'react'
import { createReport } from '../api/client'
import type { Device, WhereArea } from '../api/types'
import { Chips, type ChipOption } from '../components/Chips'
import { Err, FilePicker } from '../components/FilePicker'
import { Icon } from '../components/Icons'
import { Shell, Steps } from '../components/Shell'
import { WeHaveIt } from '../components/Tracker'
import { Turnstile, type TurnstileHandle } from '../components/Turnstile'
import { useI18n } from '../i18n'
import { useUpload, type Target } from '../upload/useUpload'

const WHERE_ICONS: Record<WhereArea, ChipOption<WhereArea>['icon']> = {
  match: 'sword',
  lobby: 'home',
  shop: 'shop',
  crates: 'crate',
  clan: 'clan',
  other: 'dots',
}
const DEVICE_ICONS: Record<Device, ChipOption<Device>['icon']> = {
  phone: 'phone',
  tablet: 'tablet',
  computer: 'pc',
  console: 'pad',
}

function options<K extends string>(icons: Record<K, ChipOption<K>['icon']>, labels: Record<K, string>) {
  return (Object.keys(icons) as K[]).map((key) => ({ key, icon: icons[key], label: labels[key] }))
}

export default function Report() {
  const { t, lang } = useI18n()
  const up = useUpload()
  // A saved upload after a reload reopens step 3 on its report: no new report, no new check.
  const [code, setCode] = useState<string | null>(up.resume?.code ?? null)
  const [step, setStep] = useState<1 | 2 | 3>(up.resume ? 3 : 1)
  const [what, setWhat] = useState('')
  const [where, setWhere] = useState<WhereArea>()
  const [device, setDevice] = useState<Device>()
  const [name, setName] = useState('')
  const [token, setToken] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [noWhat, setNoWhat] = useState(false)
  const widget = useRef<TurnstileHandle>(null)
  const whatBox = useRef<HTMLTextAreaElement>(null)
  const ids = { what: useId(), hint1: useId(), name: useId(), hintn: useId() }

  const go = (n: 1 | 2 | 3) => {
    setStep(n)
    window.scrollTo(0, 0)
  }

  const again = () => {
    up.reset()
    setCode(null)
    setWhat('')
    setWhere(undefined)
    setDevice(undefined)
    setName('')
    setFailed(false)
    setNoWhat(false)
    go(1)
  }

  const send = async () => {
    if (sending) return
    setSending(true)
    setFailed(false)
    // The page may be left or reset while createReport is out; its answer then belongs to nobody.
    const still = up.guard()
    try {
      let target: Target | undefined
      // Once the report exists, sending again only continues its upload: never a second report.
      if (!code) {
        if (!token) return
        target = await createReport({
          what: what.trim(),
          where,
          device,
          robloxName: name.trim() || undefined,
          lang,
          turnstileToken: token,
        })
        if (!still()) return
        setCode(target.code)
      }
      // start() keeps its own failures (phase 'error', screen 3e); only createReport throws here.
      await up.start(target)
    } catch {
      if (!still()) return
      // Nothing typed or picked is lost; the used token is not valid twice, so the widget issues a new one.
      setFailed(true)
      widget.current?.reset()
    } finally {
      setSending(false)
    }
  }

  if (up.phase === 'done' && code) {
    return (
      <Shell>
        <WeHaveIt code={code} onAgain={again} />
      </Shell>
    )
  }

  if (step === 1) {
    return (
      <Shell>
        <Steps n={1} />
        <h1 className="gold">{t.h1}</h1>
        <p className="lead">{t.lead}</p>
        <label className="q" htmlFor={ids.what}>
          {t.q1}
        </label>
        <textarea
          ref={whatBox}
          id={ids.what}
          value={what}
          maxLength={2000}
          placeholder={t.ph1}
          aria-describedby={ids.hint1}
          onChange={(e) => setWhat(e.target.value)}
        />
        <div className="hint" id={ids.hint1}>
          <Icon name="info" />
          <span>{t.hint1}</span>
        </div>
        {noWhat && !what.trim() && <Err text={t.errWhat} />}
        {/* Never disabled: a dimmed first button reads as "broken"; an empty press says what is missing instead. */}
        <button
          type="button"
          className="btn gold-btn"
          onClick={() => {
            if (what.trim()) return go(2)
            setNoWhat(true)
            whatBox.current?.focus()
          }}
        >
          {t.next} <Icon name="next" />
        </button>
      </Shell>
    )
  }

  if (step === 2) {
    return (
      <Shell>
        <Steps n={2} />
        <h1 className="gold">{t.h2}</h1>
        <Chips<WhereArea> label={t.q2} options={options(WHERE_ICONS, t.where)} value={where} onChange={setWhere} />
        <Chips<Device> label={t.q3} options={options(DEVICE_ICONS, t.dev)} value={device} onChange={setDevice} />
        <label className="q" htmlFor={ids.name}>
          {t.qn} <span className="opt">{t.opt}</span>
        </label>
        <input
          id={ids.name}
          type="text"
          value={name}
          maxLength={20}
          autoComplete="off"
          spellCheck={false}
          placeholder={t.phn}
          aria-describedby={ids.hintn}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="hint" id={ids.hintn}>
          <Icon name="lock" size={18} />
          <span>{t.hintn}</span>
        </div>
        <button type="button" className="btn gold-btn" onClick={() => go(3)}>
          {t.next} <Icon name="next" />
        </button>
        <div className="gap" />
        <button type="button" className="btn ghost" onClick={() => go(1)}>
          <Icon name="back" /> {t.back}
        </button>
      </Shell>
    )
  }

  // A Remove waiting for the server locks the page as an upload does: the list is about to change.
  const uploading = up.phase === 'uploading' || up.removing
  const missing = up.resume?.missing ?? []
  // A refused file is removed first (FilePicker's Remove), then Send goes on with the rest.
  const canSend = !up.refused && (code ? up.files.length > 0 : !!token && !!what.trim())
  return (
    <Shell>
      <Steps n={3} />
      <h1 className="gold">{t.h3}</h1>
      <p className="lead">{t.lead3}</p>
      {code && missing.length > 0 && up.phase === 'idle' && (
        <div className="hint">
          <Icon name="info" />
          <span>
            {t.resumeHint} <b>{missing.map((m) => m.name).join(', ')}</b>
          </span>
        </div>
      )}
      {failed && <Err text={t.errSend} />}
      <FilePicker up={up} locked={sending} />
      {up.phase === 'error' ? (
        <>
          <div className="gap" />
          <button type="button" className="btn gold-btn" disabled={up.removing} onClick={() => void up.retry()}>
            {t.retry}
          </button>
        </>
      ) : (
        <>
          {!code && <Turnstile ref={widget} onToken={setToken} />}
          <div className="gap" />
          <button
            type="button"
            className="btn gold-btn"
            disabled={sending || uploading || !canSend}
            onClick={() => void send()}
          >
            <Icon name="send" /> {t.send}
          </button>
          <div className="gap" />
          {/* After a reload the earlier steps are gone, so going back means starting a new report. */}
          <button
            type="button"
            className="btn ghost"
            disabled={sending || uploading}
            onClick={() => (code ? again() : go(2))}
          >
            <Icon name="back" /> {t.back}
          </button>
        </>
      )}
    </Shell>
  )
}
