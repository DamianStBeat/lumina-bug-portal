import { useEffect, useId, useRef, useState } from 'react'
import { attachSession } from '../api/client'
import { Err, FilePicker } from '../components/FilePicker'
import { Icon } from '../components/Icons'
import { Shell } from '../components/Shell'
import { WeHaveIt } from '../components/Tracker'
import { Turnstile, type TurnstileHandle } from '../components/Turnstile'
import { useI18n } from '../i18n'
import { navigate, replaceAddress, useRoute } from '../router'
import { useUpload } from '../upload/useUpload'
import { sendLine, type SendLine } from './refusal'

const CODE = /^LUM-\d{6}$/

// Preview screen `c`: add files to a report made in the game or on Discord.
export default function AddVideo() {
  const { t } = useI18n()
  const { query } = useRoute()
  const addr = (query.get('code') ?? '').trim().toUpperCase()
  // The code in the address wins: a saved upload is offered only for that same code (or when none is given).
  const [asked] = useState(addr)
  const up = useUpload(asked || undefined)
  // `bound` is the report the upload belongs to; set after a reload too, so the same files continue without a check.
  const [bound, setBound] = useState<string | null>(up.resume?.code ?? null)
  const [code, setCode] = useState(() => asked || up.resume?.code || '')
  const [badCode, setBadCode] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  // The line of the last refused Add to report (decided B4); null before it and while a new one is out.
  const [failed, setFailed] = useState<SendLine | null>(null)
  const widget = useRef<TurnstileHandle>(null)
  const ids = { code: useId(), hint: useId() }

  // Browser Back and Forward change the address under this same page. The field follows it while no upload owns the
  // form; once bound (or sending, or uploading) it keeps the report the files go to, and Back is the way out.
  const [seen, setSeen] = useState(addr)
  if (addr !== seen) {
    setSeen(addr)
    if (!bound && !sending && up.phase !== 'uploading') {
      setCode(addr)
      setBadCode(false)
    }
  }
  // Decided B2: once bound, the screen, the address and the upload all name the bound report. Back or Forward to
  // another code (or to none) puts its address back in place instead of showing one report under another's address.
  useEffect(() => {
    if (bound && addr !== bound) replaceAddress(`/add?code=${encodeURIComponent(bound)}`)
  }, [addr, bound])

  const add = async () => {
    if (sending) return
    setFailed(null)
    if (bound) {
      await up.start()
      return
    }
    if (!CODE.test(code)) {
      setBadCode(true)
      return
    }
    if (!token) return
    // A line from an earlier answer is not about this request.
    setBadCode(false)
    setSending(true)
    // The page may be left or reset while attachSession is out; its answer then belongs to nobody.
    const still = up.guard()
    try {
      const { reportToken } = await attachSession(code, token)
      if (!still()) return
      setBound(code)
      await up.start({ code, reportToken })
    } catch (e) {
      if (!still()) return
      // 404: the code is wrong, the player can fix it in its field; the other lines go under the check.
      const line = sendLine(e, true)
      if (line === 'errCode') setBadCode(true)
      else setFailed(line)
      widget.current?.reset()
    } finally {
      setSending(false)
    }
  }

  // The way out of any state (a refused file, a code bound by mistake): an empty form, nothing kept.
  const back = () => {
    up.reset()
    setBound(null)
    setCode('')
    setBadCode(false)
    setFailed(null)
    navigate('/add')
  }

  if (up.phase === 'done' && bound) {
    return (
      <Shell>
        <WeHaveIt
          code={bound}
          onAgain={() => {
            up.reset()
            navigate('/')
          }}
        />
      </Shell>
    )
  }

  // A Remove waiting for the server locks the page as an upload does: the list is about to change.
  const uploading = up.phase === 'uploading' || up.removing
  const missing = up.resume?.missing ?? []
  // Only when there is something to undo: a code typed or prefilled stays editable in its field.
  const backButton = (bound || up.files.length > 0) && (
    <>
      <div className="gap" />
      <button type="button" className="btn ghost" disabled={sending || uploading} onClick={back}>
        <Icon name="back" /> {t.back}
      </button>
    </>
  )
  return (
    <Shell>
      {CODE.test(code) && <span className="eyebrow">{code}</span>}
      <h1 className="gold">{t.addH}</h1>
      <p className="lead">{t.addLead}</p>
      <label className="q" htmlFor={ids.code}>
        {t.addCodeL}
      </label>
      <input
        id={ids.code}
        type="text"
        value={code}
        // Room for spaces around a pasted code; they are trimmed on every change.
        maxLength={16}
        readOnly={!!bound || sending}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        aria-invalid={badCode}
        aria-describedby={ids.hint}
        onChange={(e) => {
          setCode(e.target.value.trim().toUpperCase())
          setBadCode(false)
        }}
      />
      <div className="hint" id={ids.hint}>
        <Icon name="info" />
        <span>{t.addHint}</span>
      </div>
      {badCode && <Err text={t.errCode} />}
      {bound && missing.length > 0 && up.phase === 'idle' && (
        <div className="hint">
          <Icon name="info" />
          <span>
            {t.resumeHint} <b>{missing.map((m) => m.name).join(', ')}</b>
          </span>
        </div>
      )}
      <FilePicker up={up} locked={sending} />
      {up.phase === 'error' ? (
        <>
          <button type="button" className="btn gold-btn" disabled={up.removing} onClick={() => void up.retry()}>
            {t.retry}
          </button>
          {backButton}
        </>
      ) : (
        <>
          {!bound && <Turnstile ref={widget} onToken={setToken} />}
          {failed && <Err text={t[failed]} />}
          <div className="gap" />
          <button
            type="button"
            className="btn gold-btn"
            disabled={sending || uploading || up.files.length === 0 || !!up.refused || (!bound && !token)}
            onClick={() => void add()}
          >
            <Icon name="send" /> {t.addSend}
          </button>
          {backButton}
        </>
      )}
    </Shell>
  )
}
