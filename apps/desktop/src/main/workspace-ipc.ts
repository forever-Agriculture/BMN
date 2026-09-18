import {
  ERROR_CODES,
  METHOD_REGISTRY,
  type ProtocolErrorCode,
  type ProtocolMethod
} from '@bmn/protocol'
import type { IpcMainInvokeEvent } from 'electron'

export class MainIpcError extends Error {
  constructor(readonly code: ProtocolErrorCode, message: string) {
    super(message)
    this.name = 'MainIpcError'
  }
}

export function requireSessionRuntime<Runtime>(
  event: IpcMainInvokeEvent,
  sessionId: unknown,
  senderIsAllowed: (event: IpcMainInvokeEvent) => boolean,
  runtimes: ReadonlyMap<string, Runtime>
): Runtime {
  if (!senderIsAllowed(event)) {
    throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
  }
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new MainIpcError(ERROR_CODES.invalidArgument, 'An explicit sessionId is required')
  }
  const runtime = runtimes.get(sessionId)
  if (!runtime) throw new MainIpcError(ERROR_CODES.notFound, `Session ${sessionId} is not live`)
  return runtime
}

interface WorkspaceHostClient {
  request<Result>(method: ProtocolMethod, params: object): Promise<Result>
}

interface WorkspaceIpcRegistrar {
  handle(channel: string, listener: (event: IpcMainInvokeEvent, params?: unknown) => unknown): void
}

export interface WorkspaceIpcActions {
  client(): WorkspaceHostClient
  createSession(params: unknown): Promise<unknown>
}

const ROUTES = {
  'aiterm:workspace:list': METHOD_REGISTRY.workspaceList,
  'aiterm:workspace:create': METHOD_REGISTRY.workspaceCreate,
  'aiterm:workspace:update': METHOD_REGISTRY.workspaceUpdate,
  'aiterm:session:list': METHOD_REGISTRY.sessionList,
  'aiterm:session:update': METHOD_REGISTRY.sessionUpdate,
  'aiterm:template:list': METHOD_REGISTRY.templateList,
  'aiterm:template:create': METHOD_REGISTRY.templateCreate,
  'aiterm:layout:get': METHOD_REGISTRY.layoutGet,
  'aiterm:layout:put': METHOD_REGISTRY.layoutPut
} as const

export function installWorkspaceIpcHandlers(
  ipc: WorkspaceIpcRegistrar,
  senderIsAllowed: (event: IpcMainInvokeEvent) => boolean,
  actions: WorkspaceIpcActions
): void {
  const authorize = (event: IpcMainInvokeEvent): void => {
    if (!senderIsAllowed(event)) {
      throw new MainIpcError(ERROR_CODES.unauthorized, 'Renderer sender is not authorized')
    }
  }
  for (const [channel, method] of Object.entries(ROUTES)) {
    ipc.handle(channel, (event, params = {}) => {
      authorize(event)
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new MainIpcError(ERROR_CODES.invalidArgument, 'IPC parameters must be an object')
      }
      return actions.client().request(method, params as object)
    })
  }
  ipc.handle('aiterm:session:create', (event, params) => {
    authorize(event)
    return actions.createSession(params)
  })
}
