import type { ReactNode } from 'react'
import { strings, useI18n } from '../i18n'

// The preview's shell(): header, the side panel (wide screens only, by CSS), the glass card, the footer.
export function Shell({ children }: { children: ReactNode }) {
  const { lang, t, setLang } = useI18n()
  const other = lang === 'en' ? 'it' : 'en'
  return (
    <>
      <header>
        <img src="/logo.webp" alt={t.site} width={40} height={40} />
        <div className="site">
          {t.site}
          <small>{t.sub}</small>
        </div>
        {/* Shows the language you would switch to, in that language, as the preview's switch does. */}
        <button type="button" className="lang" lang={other} aria-label={t.langAria} onClick={() => setLang(other)}>
          {strings[other].lang}
        </button>
      </header>
      <main>
        <section className="side">
          <span className="eyebrow">{t.sub}</span>
          <h2 className="gold" style={{ marginTop: 12 }}>
            {t.sideH}
          </h2>
          <p>{t.sideP}</p>
          <div className="how">
            {t.how.map((h, i) => (
              <div key={i}>
                <b>{i + 1}</b>
                {h}
              </div>
            ))}
          </div>
          <div className="shot">
            <img src="/gameplay-wave2.jpg" alt="" />
          </div>
        </section>
        <section className="glass card">{children}</section>
      </main>
      <footer>{t.foot}</footer>
    </>
  )
}

export function Steps({ n }: { n: 1 | 2 | 3 }) {
  const { t } = useI18n()
  return (
    <>
      <div className="steps" aria-hidden="true">
        {[1, 2, 3].map((i) => (
          <i key={i} className={i <= n ? 'on' : ''} />
        ))}
      </div>
      <span className="eyebrow">{t.step(n)}</span>
    </>
  )
}
