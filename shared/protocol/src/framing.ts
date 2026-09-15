import { MAX_CONTROL_FRAME_BYTES } from './constants'
import { assertRpcEnvelope, type RpcEnvelope } from './envelope'

const HEADER_BYTES = 4
const utf8 = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8', { fatal: true })

export class FrameTooLargeError extends RangeError {
  constructor(readonly frameBytes: number) {
    super(`Protocol frame is ${frameBytes} bytes; maximum is ${MAX_CONTROL_FRAME_BYTES}`)
    this.name = 'FrameTooLargeError'
  }
}

export class TruncatedFrameError extends Error {
  constructor() {
    super('Protocol stream ended with a truncated frame')
    this.name = 'TruncatedFrameError'
  }
}

export class MalformedFrameError extends Error {
  constructor(readonly cause?: unknown) {
    super('Protocol frame body is empty, malformed JSON, invalid UTF-8, or not a valid RPC envelope')
    this.name = 'MalformedFrameError'
  }
}

export function encodeFrame(envelope: RpcEnvelope): Uint8Array {
  assertRpcEnvelope(envelope)
  const body = utf8.encode(JSON.stringify(envelope))
  if (body.byteLength > MAX_CONTROL_FRAME_BYTES) throw new FrameTooLargeError(body.byteLength)
  const frame = new Uint8Array(HEADER_BYTES + body.byteLength)
  new DataView(frame.buffer).setUint32(0, body.byteLength, false)
  frame.set(body, HEADER_BYTES)
  return frame
}

function decodeBody(body: Uint8Array): RpcEnvelope {
  try {
    const parsed: unknown = JSON.parse(utf8Decoder.decode(body))
    assertRpcEnvelope(parsed)
    return parsed
  } catch (error) {
    throw new MalformedFrameError(error)
  }
}

type BodyAllocator = (size: number) => Uint8Array

export class FrameDecoder {
  private readonly header = new Uint8Array(HEADER_BYTES)
  private headerOffset = 0
  private body: Uint8Array | undefined
  private bodyOffset = 0

  constructor(private readonly allocateBody: BodyAllocator = (size) => new Uint8Array(size)) {}

  push(chunk: Uint8Array): RpcEnvelope[] {
    const envelopes: RpcEnvelope[] = []
    let offset = 0

    while (offset < chunk.byteLength) {
      if (!this.body) {
        const headerRemaining = HEADER_BYTES - this.headerOffset
        const headerBytes = Math.min(headerRemaining, chunk.byteLength - offset)
        this.header.set(chunk.subarray(offset, offset + headerBytes), this.headerOffset)
        this.headerOffset += headerBytes
        offset += headerBytes
        if (this.headerOffset < HEADER_BYTES) continue

        const frameBytes = new DataView(this.header.buffer).getUint32(0, false)
        if (frameBytes > MAX_CONTROL_FRAME_BYTES) {
          this.reset()
          throw new FrameTooLargeError(frameBytes)
        }
        if (frameBytes === 0) {
          this.reset()
          throw new MalformedFrameError()
        }
        this.body = this.allocateBody(frameBytes)
        this.bodyOffset = 0
      }

      const bodyRemaining = this.body.byteLength - this.bodyOffset
      const bodyBytes = Math.min(bodyRemaining, chunk.byteLength - offset)
      this.body.set(chunk.subarray(offset, offset + bodyBytes), this.bodyOffset)
      this.bodyOffset += bodyBytes
      offset += bodyBytes

      if (this.bodyOffset === this.body.byteLength) {
        const body = this.body
        this.reset()
        envelopes.push(decodeBody(body))
      }
    }

    return envelopes
  }

  finish(): void {
    if (this.headerOffset !== 0 || this.body) throw new TruncatedFrameError()
  }

  private reset(): void {
    this.headerOffset = 0
    this.body = undefined
    this.bodyOffset = 0
  }
}
