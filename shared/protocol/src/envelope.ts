import { METHOD_REGISTRY, isProtocolMethod, type ProtocolMethod } from './constants'
import type { ProtocolError } from './errors'
import { isHelloParams } from './hello'

export type RpcId = string | number | null

export interface RpcRequest<Params = unknown> {
  jsonrpc: '2.0'
  id?: Exclude<RpcId, null>
  method: ProtocolMethod
  params?: Params
}

export interface RpcSuccess<Result = unknown> {
  jsonrpc: '2.0'
  id: RpcId
  result: Result
}

export interface RpcFailure {
  jsonrpc: '2.0'
  id: RpcId
  error: ProtocolError
}

function hasValidId(value: unknown): value is RpcId {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))
}

export function isRpcRequest(value: unknown): value is RpcRequest {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<RpcRequest>
  if (candidate.jsonrpc !== '2.0' || !isProtocolMethod(candidate.method)) return false
  if ('id' in candidate && !hasValidId(candidate.id)) return false
  if (candidate.method === METHOD_REGISTRY.hello && !isHelloParams(candidate.params)) return false
  return true
}
