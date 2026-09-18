import { ERROR_CODES, isProtocolErrorCode, type ProtocolErrorCode } from '@bmn/protocol'
import type { BridgeError } from './bridge'

export function bridgeError(code: ProtocolErrorCode, message: string): BridgeError {
  return { name: 'BridgeError', code, message }
}

/**
 * The single preload unwrap for every `aiterm:*` invoke: resolves the envelope's result or rejects
 * with a plain-object BridgeError carrying the protocol code (contextBridge copies plain objects
 * intact, but strips custom fields from Error instances).
 */
export async function unwrapBridgeInvoke<Result>(invoke: () => Promise<unknown>): Promise<Result> {
  let envelope: unknown
  try {
    envelope = await invoke()
  } catch (error) {
    throw bridgeError(
      ERROR_CODES.ioError,
      error instanceof Error && error.message.length > 0 ? error.message : 'The bridge request failed'
    )
  }
  if (envelope && typeof envelope === 'object') {
    const candidate = envelope as { ok?: unknown; result?: unknown; code?: unknown; message?: unknown }
    if (candidate.ok === true) return candidate.result as Result
    if (
      candidate.ok === false &&
      isProtocolErrorCode(candidate.code) &&
      typeof candidate.message === 'string'
    ) {
      throw bridgeError(candidate.code, candidate.message)
    }
  }
  throw bridgeError(
    ERROR_CODES.protocolMismatch,
    'The main process returned a malformed bridge response'
  )
}

/** Human-readable detail from a bridge rejection or a local Error, for failure feedback. */
export function failureDetail(error: unknown, fallback: string): string {
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string' && message.length > 0) return message
  }
  return fallback
}
