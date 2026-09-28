// MODULE: session-ports.test.ts - port labels, chip overflow and the details list (Story 41.2)
import { listeningPortLabel, listeningPortUrl, type ListeningPort, type SessionPorts } from '@bmn/protocol'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PanePorts, SessionPortsSection, STOPPED_PORT_NOTE, paneChips, portDetail, portsFor } from './session-ports'

const port = (portNumber: number, address = '127.0.0.1', command: string | null = 'node'): ListeningPort =>
  ({ port: portNumber, address, pid: 4242, command })
const entry = (ports: ListeningPort[], stopped = false): SessionPorts => ({ sessionId: 'session-a', stopped, ports })

describe('port labels and addresses (Story 41.2)', () => {
  it('names every loopback and wildcard bind localhost, and any other address as bound', () => {
    for (const address of ['127.0.0.1', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1', '127.0.1.1']) {
      expect(listeningPortLabel(port(5173, address))).toBe('localhost:5173')
      expect(listeningPortUrl(port(5173, address))).toBe('http://localhost:5173/')
    }
    expect(listeningPortLabel(port(8080, '192.168.1.10'))).toBe('192.168.1.10:8080')
    expect(listeningPortUrl(port(8080, 'fe80::1'))).toBe('http://[fe80::1]:8080/')
  })

  it('says which program holds the port, where it is bound, and when its session has stopped', () => {
    expect(portDetail(port(5173), false)).toBe('node (pid 4242) on 127.0.0.1')
    expect(portDetail(port(4000, '::', null), true)).toBe(`pid 4242 on [::] · ${STOPPED_PORT_NOTE}`)
    expect(portDetail(port(8080, '192.168.1.10', 'python3'), false)).toBe('python3 (pid 4242)')
  })
})

describe('pane chips', () => {
  it('shows at most three chips, then one "+N" naming the rest', () => {
    const ports = [3000, 4000, 5173, 8000, 9229].map((each) => port(each))
    expect(paneChips(ports.slice(0, 3))).toEqual({ shown: ports.slice(0, 3), more: [] })
    expect(paneChips(ports)).toEqual({ shown: ports.slice(0, 3), more: ports.slice(3) })
    const markup = renderToStaticMarkup(createElement(PanePorts, { entry: entry(ports), onOpen: () => undefined }))
    expect(markup.match(/<button/g)).toHaveLength(3)
    expect(markup).toContain('>localhost:3000</button>')
    expect(markup).toContain('title="localhost:8000, localhost:9229">+2</span>')
  })

  it('renders nothing for a session without ports', () => {
    expect(renderToStaticMarkup(createElement(PanePorts, { entry: null, onOpen: () => undefined }))).toBe('')
    expect(renderToStaticMarkup(createElement(PanePorts, { entry: entry([]), onOpen: () => undefined }))).toBe('')
    expect(portsFor([entry([port(1)])], 'session-b')).toBeNull()
  })
})

describe('Session details list', () => {
  it('lists every port with its program, and says once when the session has stopped', () => {
    const ports = [3000, 4000, 5173, 8000].map((each) => port(each))
    const live = renderToStaticMarkup(createElement(SessionPortsSection, { entry: entry(ports), onOpen: () => undefined }))
    expect(live.match(/<li>/g)).toHaveLength(4)
    expect(live).toContain('localhost:8000</button><span class="port-detail">node (pid 4242) on 127.0.0.1</span>')
    expect(live).not.toContain(STOPPED_PORT_NOTE)
    const stopped = renderToStaticMarkup(createElement(SessionPortsSection, { entry: entry(ports, true), onOpen: () => undefined }))
    expect(stopped.split(STOPPED_PORT_NOTE)).toHaveLength(2)
  })
})
