export const ERROR_CODES = Object.freeze({
  unauthorized: 'UNAUTHORIZED',
  invalidArgument: 'INVALID_ARGUMENT',
  notFound: 'NOT_FOUND',
  revisionConflict: 'REVISION_CONFLICT',
  ioError: 'IO_ERROR',
  protocolMismatch: 'PROTOCOL_MISMATCH'
} as const)

export type ProtocolErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

export interface ProtocolErrorData {
  code: ProtocolErrorCode
  retryable: boolean
}

export interface ProtocolError {
  code: number
  message: string
  data: ProtocolErrorData
}

const errorCodeSet: ReadonlySet<string> = new Set(Object.values(ERROR_CODES))

export function isProtocolErrorCode(value: unknown): value is ProtocolErrorCode {
  return typeof value === 'string' && errorCodeSet.has(value)
}

export function isProtocolError(value: unknown): value is ProtocolError {
  if (!value || typeof value !== 'object') return false
  const candidate = value as Partial<ProtocolError>
  return (
    Number.isInteger(candidate.code) &&
    typeof candidate.message === 'string' &&
    candidate.message.length > 0 &&
    !!candidate.data &&
    typeof candidate.data === 'object' &&
    typeof candidate.data.code === 'string' &&
    errorCodeSet.has(candidate.data.code) &&
    typeof candidate.data.retryable === 'boolean'
  )
}
