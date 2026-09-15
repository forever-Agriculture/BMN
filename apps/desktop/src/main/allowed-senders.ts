// MODULE: allowed-senders.ts - tracks which web contents may use the privileged bridge
/** The part of Electron's WebContents that sender tracking needs. */
export interface TrackedSender {
  readonly id: number
  once(event: 'destroyed', listener: () => void): unknown
}

/**
 * Allows the contents until they are destroyed. The id is read up front: when 'destroyed' fires the owning window
 * may already be gone, and reading through it throws into Electron's uncaught-exception dialog, which blocks quit.
 */
export function trackAllowedSender(senders: Set<number>, contents: TrackedSender): void {
  const id = contents.id
  senders.add(id)
  contents.once('destroyed', () => senders.delete(id))
}
