import { useId, useRef, useState } from 'react'
import { ApiError, attachSession } from '../api/client'
import { Err, FilePicker } from '../components/FilePicker'
import { Icon } from '../components/Icons'
import { Shell } from '../components/Shell'
import { WeHaveIt } from '../components/Tracker'
import { Turnstile, type TurnstileHandle } from '../components/Turnstile'
import { useI18n } from '../i18n'
import { navigate, useRoute } from '../router'
import { useUpload } from '../upload/useUpload'

const CODE = /^LUM-\d{6}$/

// Preview screen `c`: add files to a report made in the game or on Discord.
export default function AddVideo() {
  const { t } = useI18n()
  const { query } = useRoute()
  // The code in the address wins: a saved upload is offered only for that same code (or when none is given).
  const [asked] = useState(() => (query.get('code') ?? '').trim().toUpperCase())
  const up = useUpload(asked || undefined)
  // `bound` is the report the upload belongs to; set after a reload too, so the same files continue without a check.
  const [bound, setBound] = useState<string | null>(up.resume?.code ?? null)
  const [code, setCode] = useState(() => asked || up.resume?.code || '')
  const [badCode, setBadCode] = useState(false)
  const [token, setToken] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)
  const widget = useRef<TurnstileHandle>(null)
  const ids = { code: useId(), hint: useId() }

  const add = async () => {
    if (sending) return
    setFailed(false)
    if (bound) {
      await up.start()
      return
    }
    if (!CODE.test(code)) {
      setBadCode(true)
      return
    }
    if (!token) return
    setSending(true)
    try {
      const { reportToken } = await attachSession(code, token)
      setBound(code)
      await up.start({ code, reportToken })
    } catch (e) {
      // 404: the code is wrong, the player can fix it; anything else is the network or the server.
      if (e instanceof ApiError && e.status === 404) setBadCode(true)
      else setFailed(true)
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
    setFailed(false)
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

  const uploading = up.phase === 'uploading'
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
          <button type="button" className="btn gold-btn" onClick={() => void up.retry()}>
            {t.retry}
          </button>
          {backButton}
        </>
      ) : (
        <>
          {!bound && <Turnstile ref={widget} onToken={setToken} />}
          {failed && <Err text={t.errSend} />}
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
