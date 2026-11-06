import { Shell } from '../components/Shell'
import { useI18n } from '../i18n'

// Placeholder: a later stage of the web slice builds this page.
export default function Report() {
  const { t } = useI18n()
  return (
    <Shell>
      <h1 className="gold">{t.h1}</h1>
    </Shell>
  )
}
