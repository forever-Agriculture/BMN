import type { ProtocolErrorCode } from '@bmn/protocol'
import type { BridgeError } from '../../preload/bridge'

/** Structural guard for the typed rejection every `window.aiTerminal` invoke produces. */
export function isBridgeError(error: unknown): error is BridgeError {
  if (!error || typeof error !== 'object') return false
  const candidate = error as Partial<BridgeError>
  return (
    candidate.name === 'BridgeError' &&
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string'
  )
}

/** Decides on the protocol code only; message text is never inspected. */
export function hasBridgeErrorCode(error: unknown, code: ProtocolErrorCode): boolean {
  return isBridgeError(error) && error.code === code
}

/** Human-readable detail from a bridge rejection or a local Error, for failure feedback. */
export function failureDetail(error: unknown, fallback: string): string {
  if (isBridgeError(error) || error instanceof Error) {
    return error.message.length > 0 ? error.message : fallback
  }
  return fallback
}
