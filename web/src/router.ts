import { useMemo, useSyncExternalStore } from 'react'

// No router library (slice decision): the address bar is the state, pushState writes it, popstate reads it back.
const NAVIGATE_EVENT = 'lumina:navigate'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(NAVIGATE_EVENT, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(NAVIGATE_EVENT, onChange)
  }
}

// A string snapshot, so React sees "unchanged" until the URL really changes.
function snapshot(): string {
  return location.pathname + location.search
}

export function useRoute(): { path: string; query: URLSearchParams } {
  const href = useSyncExternalStore(subscribe, snapshot)
  return useMemo(() => {
    const url = new URL(href, location.origin)
    // "/add/" and "/add" are the same page.
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname
    return { path, query: url.searchParams }
  }, [href])
}

export function navigate(to: string): void {
  if (to === snapshot()) return
  history.pushState(null, '', to)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
  window.scrollTo(0, 0)
}

// Corrects the address of the page shown, without a new history entry: Back still leads where it led before.
export function replaceAddress(to: string): void {
  if (to === snapshot()) return
  history.replaceState(null, '', to)
  window.dispatchEvent(new Event(NAVIGATE_EVENT))
}

const STATUS_PATH = /^\/status\/(LUM-\d{6})\/?$/i

export function matchStatus(path: string): string | null {
  const m = STATUS_PATH.exec(path)
  // Codes are stored upper case; a hand-typed "lum-482193" is the same report.
  return m?.[1] ? m[1].toUpperCase() : null
}
