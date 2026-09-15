import { PROTOCOL_VERSION } from './constants'

export interface HelloParams {
  protocol: {
    major: number
    minor: number
  }
  clientVersion: string
  instanceId: string
}

export function isHelloParams(value: unknown): value is HelloParams {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<HelloParams>
  return (
    !!candidate.protocol &&
    typeof candidate.protocol === 'object' &&
    Number.isInteger(candidate.protocol.major) &&
    Number.isInteger(candidate.protocol.minor) &&
    typeof candidate.clientVersion === 'string' &&
    candidate.clientVersion.length > 0 &&
    typeof candidate.instanceId === 'string' &&
    candidate.instanceId.length > 0
  )
}

export function isCompatibleProtocol(value: HelloParams['protocol']): boolean {
  return value.major === PROTOCOL_VERSION.major
}
