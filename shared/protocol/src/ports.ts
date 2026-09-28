// MODULE: ports.ts - how a session's listening port is named and reached (Stories 41.1, 41.2)
import type { ListeningPort } from './companion'

/** Loopback and wildcard binds: a browser on this machine reaches each of them as localhost. */
export function isLocalPortAddress(address: string): boolean {
  return address === '0.0.0.0' || address === '::' || address === '::1' ||
    /^127\.\d+\.\d+\.\d+$/.test(address) || /^::ffff:(?:127\.\d+\.\d+\.\d+|0\.0\.0\.0)$/.test(address)
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
