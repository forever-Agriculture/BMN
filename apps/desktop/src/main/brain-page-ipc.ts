// MODULE: brain-page-ipc.ts - The Brain page's one window channel: the brain switch's sender and frame checks, then a read on the private parent port (Epic 128 D5)
import { ERROR_CODES, METHOD_REGISTRY } from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'
import { MainIpcError } from './workspace-ipc'

export const BRAIN_PAGE_CHANNEL = 'aiterm:brain:page'

export interface BrainPageIpcOptions {
  /** The same check every window channel uses: a known sender, from its main frame. */
  senderIsAllowed(event: IpcMainInvokeEvent): boolean
  /** The sender is BMN's own application window. */
  fromApplicationWindow(event: IpcMainInvokeEvent): boolean
  /** In the installed app, the sending frame is the packaged page (as the brain switch requires). */
  fromPackagedPage(event: IpcMainInvokeEvent): boolean
  /** A request on the inherited private parent port; the control socket has no such method. */
  request<Result>(method: typeof METHOD_REGISTRY.brainPage, params: object): Promise<Result>
}

const KEYS = new Set(['command', 'archived', 'withdrawn', 'offset', 'query', 'id', 'depth'])

export function installBrainPageIpc(
  bridge: { handle(channel: `aiterm:${string}`, listener: (event: IpcMainInvokeEvent, request?: unknown) => unknown): void },
  options: BrainPageIpcOptions
): void {
  bridge.handle(BRAIN_PAGE_CHANNEL, (event, request) => {
    if (!options.senderIsAllowed(event) || !options.fromApplicationWindow(event)) {
      throw new MainIpcError(ERROR_CODES.unauthorized, 'Only BMN’s own window can read the Brain page')
    }
    if (!options.fromPackagedPage(event)) throw new MainIpcError(ERROR_CODES.unauthorized, 'The Brain page requires BMN’s packaged window')
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new MainIpcError(ERROR_CODES.invalidArgument, 'A Brain page request is an object')
    const params: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(request)) {
      if (!KEYS.has(key) || !['string', 'number', 'boolean'].includes(typeof value)) {
        throw new MainIpcError(ERROR_CODES.invalidArgument, 'Unexpected Brain page parameter')
      }
      params[key] = value
    }
    return options.request(METHOD_REGISTRY.brainPage, params)
  })
}
