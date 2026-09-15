import { ERROR_CODES, type ProtocolErrorCode } from '@ai-terminal/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import type { BridgeInvokeResult } from '../preload/bridge'
import { PtyHostRemoteError } from './pty-host-client'
import { MainIpcError } from './workspace-ipc'

type BridgeFailure = Extract<BridgeInvokeResult<never>, { ok: false }>

export type BridgeInvokeListener = (event: IpcMainInvokeEvent, ...args: never[]) => unknown

export interface BridgeInvokeRegistration {
  channel: `aiterm:${string}`
  invoke(event: IpcMainInvokeEvent, ...args: unknown[]): Promise<BridgeInvokeResult<unknown>>
}

/** The registrar every `aiterm:*` invoke channel is installed through; there is no other path. */
export interface BridgeInvokeRegistrar {
  handle(channel: `aiterm:${string}`, listener: BridgeInvokeListener): void
  registrations(): readonly BridgeInvokeRegistration[]
}

interface InvokeHandlerTarget {
  handle(
    channel: string,
    listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<unknown>
  ): void
}

function failure(code: ProtocolErrorCode, message: string): BridgeFailure {
  return { ok: false, code, message }
}

/**
 * Maps a main-process failure to the typed bridge failure. The protocol code travels as a field,
 * never inside the message: Electron would otherwise deliver only a prefixed message string.
 */
export function bridgeFailure(error: unknown): BridgeFailure {
  if (error instanceof MainIpcError) return failure(error.code, error.message)
  if (error instanceof PtyHostRemoteError) {
    return failure(error.protocolError.data.code, error.protocolError.message)
  }
  return failure(
    ERROR_CODES.ioError,
    error instanceof Error && error.message.length > 0
      ? error.message
      : 'The main process request failed'
  )
}

/** Wraps an invoke target so every handler resolves the discriminated bridge envelope. */
export function bridgeInvokeRegistrar(ipc: InvokeHandlerTarget): BridgeInvokeRegistrar {
  const registrations: BridgeInvokeRegistration[] = []
  return {
    handle(channel, listener) {
      const invoke = listener as (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown
      const wrapped = async (
        event: IpcMainInvokeEvent,
        ...args: unknown[]
      ): Promise<BridgeInvokeResult<unknown>> => {
        try {
          return { ok: true, result: await invoke(event, ...args) }
        } catch (error) {
          return bridgeFailure(error)
        }
      }
      ipc.handle(channel, wrapped)
      registrations.push({ channel, invoke: wrapped })
    },
    registrations() {
      return registrations.map((registration) => ({ ...registration }))
    }
  }
}
