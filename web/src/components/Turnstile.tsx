import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { TURNSTILE_SITE_KEY } from '../config'
import { useI18n } from '../i18n'

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
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile missing')))
    s.onerror = () => {
      // Forget the failed load, so the next page that needs the widget tries again.
      loading = null
      s.remove()
      reject(new Error('turnstile blocked'))
    }
    document.head.appendChild(s)
  })
  return loading
}

// `onToken(null)` means "no usable token now": not loaded yet, expired, failed or reset.
export function Turnstile({ onToken, ref }: { onToken(token: string | null): void; ref?: Ref<TurnstileHandle> }) {
  const { lang } = useI18n()
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
      () => live && report.current(null),
    )
    return () => {
      live = false
      if (widget.current) window.turnstile?.remove(widget.current)
      widget.current = null
      report.current(null)
    }
  }, [lang])

  return <div className="turnstile" ref={box} />
}
