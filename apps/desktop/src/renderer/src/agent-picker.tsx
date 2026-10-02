// MODULE: agent-picker.tsx - one-click agent choice for a new session: a radiogroup of cards with roving focus
import { useRef } from 'react'

export interface PickerOption {
  id: string
  label: string
  hint: string
  disabledReason?: string | undefined
}

export function AgentPicker(props: {
  options: readonly PickerOption[]
  selectedId: string | null
  onPick(option: PickerOption): void
}): React.JSX.Element {
  const group = useRef<HTMLDivElement>(null)
  const enabled = props.options.filter((option) => !option.disabledReason)
  const focusIndex = Math.max(0, enabled.findIndex((option) => option.id === props.selectedId))
  const move = (index: number): void => {
    const next = enabled[(index + enabled.length) % enabled.length]
    if (!next) return
    props.onPick(next)
    group.current?.querySelector<HTMLButtonElement>(`[data-option="${CSS.escape(next.id)}"]`)?.focus()
  }
  return (
    <div ref={group} className="agent-picker" role="radiogroup" aria-label="Agent">
      {props.options.map((option) => {
        const index = enabled.indexOf(option)
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            data-option={option.id}
            aria-checked={option.id === props.selectedId}
            disabled={!!option.disabledReason}
            title={option.disabledReason ?? option.hint}
            tabIndex={index === focusIndex ? 0 : -1}
            onClick={() => props.onPick(option)}
            onKeyDown={(event) => {
              const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
              const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp'
              if (forward || back) move(index + (forward ? 1 : -1))
              else if (event.key === 'Home') move(0)
              else if (event.key === 'End') move(enabled.length - 1)
              else return
              event.preventDefault()
            }}
          >
            <span className="agent-name">{option.label}</span>
            <span className="agent-hint">{option.disabledReason ?? option.hint}</span>
          </button>
        )
      })}
    </div>
  )
}
