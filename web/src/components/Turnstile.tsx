import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
import { TURNSTILE_SITE_KEY } from '../config'
import { useI18n } from '../i18n'
import { Err } from './FilePicker'

// Only the part of Cloudflare's widget API this site calls.
type RenderOptions = {
  sitekey: string
  callback(token: string): void
  'expired-callback'(): void
  'error-callback'(): void
  language: string
  theme: 'dark'
  size: 'normal' | 'compact'
}
type TurnstileApi = {
  render(el: HTMLElement, options: RenderOptions): string
  reset(widgetId: string): void
  remove(widgetId: string): void
}
declare global {
  interface Window {
    turnstile?: TurnstileApi
  }
}

export type TurnstileHandle = { reset(): void }

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit'
// The normal widget is 300 px wide; below that (a 320 px phone) only the compact one fits without side scroll.
const NORMAL_WIDTH = 300

let loading: Promise<TurnstileApi> | null = null

// The script is the site's only third-party request, so it is added on first use, never in index.html.
function loadApi(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile)
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script')
    s.src = SRC
    s.async = true
    s.defer = true
    // Forget a failed load, so Try again (or the next page that needs the widget) adds the script again.
    const fail = (why: string) => {
      loading = null
      s.remove()
      reject(new Error(why))
    }
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : fail('turnstile missing'))
    s.onerror = () => fail('turnstile blocked')
    document.head.appendChild(s)
  })
  return loading
}

// `onToken(null)` means "no usable token now": not loaded yet, expired, failed or reset.
export function Turnstile({ onToken, ref }: { onToken(token: string | null): void; ref?: Ref<TurnstileHandle> }) {
  const { t, lang } = useI18n()
  // The script did not load (offline, a school filter, a browser shield): say so and offer to load it again, instead
  // of a Send button that stays grey for no visible reason.
  const [failed, setFailed] = useState(false)
  const [tries, setTries] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const widget = useRef<string | null>(null)
  // The widget keeps the callbacks it was rendered with; reading the latest one through a ref avoids re-rendering it.
  const report = useRef(onToken)
  useEffect(() => {
    report.current = onToken
  })

  useImperativeHandle(ref, () => ({
    reset() {
      // A token is single use: after a refused request the widget must issue a fresh one.
      if (widget.current) window.turnstile?.reset(widget.current)
      report.current(null)
    },
  }))

  useEffect(() => {
    // A build without a site key cannot pass the check; the line below says so (see web/README.md).
    if (!TURNSTILE_SITE_KEY) return
    let live = true
    loadApi().then(
      (api) => {
        const el = box.current
        if (!live || !el) return
        widget.current = api.render(el, {
          sitekey: TURNSTILE_SITE_KEY,
          callback: (token) => report.current(token),
          'expired-callback': () => report.current(null),
          'error-callback': () => report.current(null),
          language: lang,
          theme: 'dark',
          size: el.clientWidth < NORMAL_WIDTH ? 'compact' : 'normal',
        })
      },
      () => {
        if (!live) return
        report.current(null)
        setFailed(true)
      },
    )
    return () => {
      live = false
      if (widget.current) window.turnstile?.remove(widget.current)
      widget.current = null
      report.current(null)
    }
  }, [lang, tries])

  if (!TURNSTILE_SITE_KEY) return <Err text={t.errCheck} />
  return (
    <>
      {failed && (
        <>
          <Err text={t.errCheck} />
          <button
            type="button"
            className="btn ghost"
            onClick={() => {
              setFailed(false)
              setTries((n) => n + 1)
            }}
          >
            {t.retry}
          </button>
          <div className="gap" />
        </>
      )}
      <div className="turnstile" ref={box} hidden={failed} />
    </>
  )
}
