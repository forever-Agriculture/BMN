// MODULE: ports.ts - how a session's listening port is named and reached (Stories 41.1, 41.2)
import type { ListeningPort } from './companion'

/** 127.0.0.1, ::1 and the wildcard binds: a browser on this machine reaches each of them as localhost. */
export function isLocalPortAddress(address: string): boolean {
  // Only these answer at localhost: a server bound to 127.0.1.1 alone is reached at that address, not at 127.0.0.1.
  return ['127.0.0.1', '0.0.0.0', '::1', '::', '::ffff:127.0.0.1', '::ffff:0.0.0.0'].includes(address)
}

/** "localhost:5173", or the bound address itself when the server listens on one interface only. */
export function listeningPortLabel(port: Pick<ListeningPort, 'port' | 'address'>): string {
  if (isLocalPortAddress(port.address)) return `localhost:${port.port}`
  return `${port.address.includes(':') ? `[${port.address}]` : port.address}:${port.port}`
}

/** The address BMN opens in the default browser: plain http, the root path. */
export function listeningPortUrl(port: Pick<ListeningPort, 'port' | 'address'>): string {
  return `http://${listeningPortLabel(port)}/`
}
