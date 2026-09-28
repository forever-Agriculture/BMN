// MODULE: session-ports.tsx - a session's listening ports: pane chips and the Session details list (Story 41.2)
import { listeningPortLabel, type ListeningPort, type SessionPorts } from '@bmn/protocol'

/** The pane header shows this many chips; the rest are one "+N" that names them in its tooltip. */
export const PANE_PORT_CHIPS = 3

export const STOPPED_PORT_NOTE = 'still running after the session stopped'

export function paneChips(ports: readonly ListeningPort[], max = PANE_PORT_CHIPS): { shown: ListeningPort[]; more: ListeningPort[] } {
  return { shown: ports.slice(0, max), more: ports.slice(max) }
}

export function portsFor(entries: readonly SessionPorts[], sessionId: string): SessionPorts | null {
  return entries.find((entry) => entry.sessionId === sessionId) ?? null
}

/** What a port's tooltip and list row say about it beyond its address. */
export function portDetail(port: ListeningPort, stopped: boolean): string {
  const bound = listeningPortLabel(port).startsWith('localhost:') ? ` on ${port.address.includes(':') ? `[${port.address}]` : port.address}` : ''
  const program = port.command ? `${port.command} (pid ${port.pid})` : `pid ${port.pid}`
  return `${program}${bound}${stopped ? ` · ${STOPPED_PORT_NOTE}` : ''}`
}

export function PanePorts(props: { entry: SessionPorts | null; onOpen(port: ListeningPort): void }): React.JSX.Element | null {
  if (!props.entry || props.entry.ports.length === 0) return null
  const { shown, more } = paneChips(props.entry.ports)
  const stopped = props.entry.stopped
  return (
    <span className="pane-ports" aria-label="Listening ports">
      {shown.map((port) => (
        <button key={`${port.port}`} type="button" className="port-chip" title={`Open ${listeningPortLabel(port)} · ${portDetail(port, stopped)}`}
          onClick={() => props.onOpen(port)}>{listeningPortLabel(port)}</button>
      ))}
      {more.length > 0 ? (
        <span className="port-chip more" title={more.map((port) => listeningPortLabel(port)).join(', ')}>+{more.length}</span>
      ) : null}
    </span>
  )
}

export function SessionPortsSection(props: { entry: SessionPorts | null; onOpen(port: ListeningPort): void }): React.JSX.Element | null {
  if (!props.entry || props.entry.ports.length === 0) return null
  const stopped = props.entry.stopped
  return (
    <section className="inspector-section session-ports" aria-label="Ports">
      <h3>Ports</h3>
      {stopped ? <p className="meta">Its programs are {STOPPED_PORT_NOTE}.</p> : null}
      <ul>
        {props.entry.ports.map((port) => (
          <li key={`${port.port}`}>
            <button type="button" className="small port-open" title={`Open ${listeningPortLabel(port)} in the browser`}
              onClick={() => props.onOpen(port)}>{listeningPortLabel(port)}</button>
            <span className="port-detail">{portDetail(port, false)}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}
