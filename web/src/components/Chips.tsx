import { useId } from 'react'
import { Icon, type IconName } from './Icons'

export type ChipOption<K extends string> = { key: K; icon: IconName; label: string }

// Single choice that can be undone: both questions are optional, so tapping the chosen chip again clears it.
export function Chips<K extends string>(props: {
  label: string
  options: ChipOption<K>[]
  value: K | undefined
  onChange(value: K | undefined): void
}) {
  const id = useId()
  return (
    <>
      <div className="q" id={id}>
        {props.label}
      </div>
      <div className="chips" role="group" aria-labelledby={id}>
        {props.options.map((o) => {
          const on = props.value === o.key
          return (
            <button
              key={o.key}
              type="button"
              className={on ? 'chip on' : 'chip'}
              aria-pressed={on}
              onClick={() => props.onChange(on ? undefined : o.key)}
            >
              <Icon name={o.icon} />
              {o.label}
            </button>
          )
        })}
      </div>
    </>
  )
}
