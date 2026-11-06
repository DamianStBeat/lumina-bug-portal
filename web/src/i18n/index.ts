import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { en } from './en'
import { it } from './it'

export type Lang = 'en' | 'it'
// Plain object literal in en.ts, so its strings are already widened to `string` and `it` can hold other words.
export type Strings = typeof en

export const strings: Record<Lang, Strings> = { en, it }

const STORE_KEY = 'lumina-bug-lang'

function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'it'
}

export function detectLang(): Lang {
  try {
    const stored = localStorage.getItem(STORE_KEY)
    if (isLang(stored)) return stored
  } catch {
    // Storage blocked (private mode, sandboxed frame): the browser's language still decides.
  }
  const prefs = navigator.languages?.length ? navigator.languages : [navigator.language]
  // The first preference we can serve wins, so a browser set to German then Italian gets Italian, not English.
  for (const p of prefs) {
    const tag = (p ?? '').toLowerCase()
    if (tag.startsWith('it')) return 'it'
    if (tag.startsWith('en')) return 'en'
  }
  return 'en'
}

type I18n = { lang: Lang; t: Strings; setLang(l: Lang): void }

const I18nContext = createContext<I18n | null>(null)

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(detectLang)

  // Keeps <html lang> true from the first paint on, so screen readers pronounce the right language.
  useEffect(() => {
    document.documentElement.lang = lang
  }, [lang])

  const setLang = useCallback((l: Lang) => {
    try {
      localStorage.setItem(STORE_KEY, l)
    } catch {
      // Without storage the choice lasts for this visit only.
    }
    document.documentElement.lang = l
    setLangState(l)
  }, [])

  const value = useMemo<I18n>(() => ({ lang, t: strings[lang], setLang }), [lang, setLang])
  return createElement(I18nContext.Provider, { value }, children)
}

export function useI18n(): I18n {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n outside I18nProvider')
  return ctx
}
