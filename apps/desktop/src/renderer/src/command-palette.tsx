// MODULE: command-palette.tsx - searchable app commands, workspaces and sessions with explicit context
import { useMemo, useState } from 'react'
import { Dialog } from './dialog'

export interface PaletteCommand {
  id: string
  group: 'Sessions' | 'Workspaces' | 'Commands'
  label: string
  context?: string | undefined
  shortcut?: string | undefined
  disabled?: boolean | undefined
  run(): void
}

/** Every query word must appear in the label or context; nothing runs from a partial match without Enter. */
export function filterCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const words = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
  return commands.filter((command) => {
    if (command.disabled) return false
    const haystack = `${command.label} ${command.context ?? ''} ${command.group}`.toLocaleLowerCase()
    return words.every((word) => haystack.includes(word))
  })
}

export function CommandPalette(props: { commands: PaletteCommand[]; onClose(): void }): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const results = useMemo(() => filterCommands(props.commands, query), [props.commands, query])
  const activeIndex = Math.min(active, Math.max(0, results.length - 1))

  const invoke = (command: PaletteCommand | undefined): void => {
    if (!command) return
    props.onClose()
    // Run after the dialog closes so focus restoration never lands on top of the command's own focus.
    setTimeout(() => command.run(), 0)
  }

  let lastGroup = ''
  return (
    <Dialog label="Command palette" className="command-palette" onClose={props.onClose}>
      <input
        autoFocus
        aria-label="Search commands, workspaces and sessions"
        aria-controls="palette-results"
        aria-activedescendant={results[activeIndex] ? `palette-${results[activeIndex].id}` : undefined}
        placeholder="Type a command, workspace or session"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value)
          setActive(0)
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            const step = event.key === 'ArrowDown' ? 1 : -1
            setActive((activeIndex + step + results.length) % Math.max(1, results.length))
          } else if (event.key === 'Enter') {
            event.preventDefault()
            invoke(results[activeIndex])
          }
        }}
      />
      <ul id="palette-results" className="palette-results" role="listbox" aria-label="Results">
        {results.length === 0 ? <li className="popover-empty">No matching commands.</li> : null}
        {results.map((command, index) => {
          const heading = command.group !== lastGroup ? command.group : null
          lastGroup = command.group
          return [
            heading ? <li key={`group-${heading}`} className="group eyebrow" role="presentation">{heading}</li> : null,
            <li
              key={command.id}
              id={`palette-${command.id}`}
              role="option"
              aria-selected={index === activeIndex}
              onMouseMove={() => setActive(index)}
              onClick={() => invoke(command)}
            >
              <span>{command.label}</span>
              {command.context ? <span className="context">{command.context}</span> : null}
              {command.shortcut ? <span className="shortcut">{command.shortcut}</span> : null}
            </li>
          ]
        })}
      </ul>
    </Dialog>
  )
}
