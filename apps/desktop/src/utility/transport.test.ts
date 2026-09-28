import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONSUMER_OUTPUT_QUEUE_BYTES,
  MAX_TERMINAL_CHUNK_BYTES,
  PTY_HOST_OUTPUT_QUEUE_BYTES,
  isTerminalAckMessage,
  isTerminalInputMessage,
  isTerminalOutputMessage,
  terminalWriteCut,
  type TerminalOutputMessage
} from '@bmn/protocol'
import { TerminalByteFramer } from './terminal-byte-framer'
import { generatedTerminalOutput, pick, seeded } from './test-fixtures/terminal-output'
import { XtermParser, xtermUtf8Decoder } from './test-fixtures/xterm-parser'
import { HostOutputQueue } from './transport'

describe('terminal MessagePort messages', () => {
  afterEach(() => vi.useRealTimers())
  it('accepts bounded input/output/ack messages and rejects oversized bytes', () => {
    const bytes = new Uint8Array([1, 2, 3])
    expect(
      isTerminalInputMessage({
        kind: 'terminal-input',
        method: 'terminal.write',
        attachmentId: 'attachment',
        bytes
      })
    ).toBe(true)
    expect(
      isTerminalOutputMessage({
        kind: 'terminal-output',
        attachmentId: 'attachment',
        streamSeq: 0,
        bytes
      })
    ).toBe(true)
    expect(
      isTerminalAckMessage({ kind: 'terminal-ack', attachmentId: 'attachment', streamSeq: 0 })
    ).toBe(true)
    expect(
      isTerminalInputMessage({
        kind: 'terminal-input',
        method: 'terminal.write',
        attachmentId: 'attachment',
        bytes: new Uint8Array(MAX_TERMINAL_CHUNK_BYTES + 1)
      })
    ).toBe(false)
  })

  it('keeps the contract queue defaults explicit', () => {
    expect(CONSUMER_OUTPUT_QUEUE_BYTES).toBe(4 * 1024 * 1024)
    expect(PTY_HOST_OUTPUT_QUEUE_BYTES).toBe(16 * 1024 * 1024)
  })

  it('paces sends to consumer credit, resumes after acknowledgements, and bounds the host queue', () => {
    const send = vi.fn()
    const pause = vi.fn()
    const resume = vi.fn()
    const disconnect = vi.fn()
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 8,
      send,
      pause,
      resume,
      disconnect
    })

    queue.enqueue({ bytes: new Uint8Array(8), freshStart: 0 })
    expect(pause).toHaveBeenCalledOnce()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      attachmentId: 'attachment', streamSeq: 0, bytes: new Uint8Array(4)
    }))
    queue.acknowledge(0)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({
      attachmentId: 'attachment', streamSeq: 1, bytes: new Uint8Array(4)
    }))
    expect(resume).not.toHaveBeenCalled()
    queue.acknowledge(1)
    expect(resume).toHaveBeenCalledOnce()

    queue.enqueue({ bytes: new Uint8Array(8), freshStart: 0 })
    queue.enqueue({ bytes: new Uint8Array(1), freshStart: 0 })
    expect(disconnect).toHaveBeenCalledWith(
      'output-overflow',
      expect.objectContaining({
        discardedPartialFrameBytes: 4,
        unsentFrames: [{ bytes: new Uint8Array(1), freshStart: 0 }]
      })
    )
  })

  it('revokes a paused consumer after the acknowledgement deadline and resumes the producer', () => {
    vi.useFakeTimers()
    const pause = vi.fn()
    const resume = vi.fn()
    const disconnect = vi.fn()
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 8,
      acknowledgementDeadlineMs: 25,
      send: vi.fn(),
      pause,
      resume,
      disconnect
    })

    queue.enqueue({ bytes: new Uint8Array(4), freshStart: 0 })
    expect(pause).toHaveBeenCalledOnce()
    vi.advanceTimersByTime(24)
    expect(disconnect).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)

    expect(disconnect).toHaveBeenCalledWith(
      'acknowledgement-timeout',
      expect.objectContaining({ discardedPartialFrameBytes: 0 })
    )
    expect(resume).toHaveBeenCalledOnce()
  })

  it('does not postpone the acknowledgement deadline when more output arrives without ack progress', () => {
    vi.useFakeTimers()
    const disconnect = vi.fn()
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 32,
      acknowledgementDeadlineMs: 25,
      send: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      disconnect
    })

    queue.enqueue({ bytes: new Uint8Array(4), freshStart: 0 })
    vi.advanceTimersByTime(20)
    queue.enqueue({ bytes: new Uint8Array(4), freshStart: 0 })
    vi.advanceTimersByTime(5)

    expect(disconnect).toHaveBeenCalledWith(
      'acknowledgement-timeout',
      expect.objectContaining({ discardedPartialFrameBytes: 0 })
    )
  })

  it('reports publication only after paced pending chunks have been sent', async () => {
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 8,
      send: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      disconnect: vi.fn()
    })
    queue.enqueue({ bytes: new Uint8Array(8), freshStart: 0 })
    let published = false
    const publication = queue.whenPublished().then(() => (published = true))
    await Promise.resolve()
    expect(published).toBe(false)

    queue.acknowledge(0)
    await publication

    expect(published).toBe(true)
  })

  it('resumes a paused producer when the output queue closes', () => {
    const pause = vi.fn()
    let handoffAccepted = false
    const resume = vi.fn(() => {
      expect(handoffAccepted).toBe(true)
    })
    const disconnect = vi.fn()
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 8,
      send: vi.fn(),
      pause,
      resume,
      disconnect
    })

    queue.enqueue({ bytes: new Uint8Array(4), freshStart: 0 })
    expect(pause).toHaveBeenCalledOnce()

    queue.close([], () => {
      handoffAccepted = true
    })

    expect(resume).toHaveBeenCalledOnce()
    expect(disconnect).not.toHaveBeenCalled()
  })

  it('returns only whole never-sent frames and counts a partially sent frame tail', () => {
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 64,
      send: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      disconnect: vi.fn()
    })
    const partial = new TextEncoder().encode('abcdUNSENT')
    const whole = new TextEncoder().encode('WHOLE')

    queue.enqueue({ bytes: partial, freshStart: 0 })
    queue.enqueue({ bytes: whole, freshStart: 0 })
    const transition = queue.close()

    expect(transition).toEqual({
      unsentFrames: [{ bytes: whole, freshStart: 0 }],
      discardedPartialFrameBytes: new TextEncoder().encode('UNSENT').byteLength
    })
  })

  it('starts a view where its first frame lets a fresh parser start, then passes contiguous frames', () => {
    const send = vi.fn()
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      send,
      pause: vi.fn(),
      resume: vi.fn(),
      disconnect: vi.fn()
    })
    const encoder = new TextEncoder()

    queue.enqueue({ bytes: encoder.encode('~~~'), freshStart: null })
    queue.enqueue({ bytes: encoder.encode('~\u001b\\text'), freshStart: 1 })
    queue.enqueue({ bytes: encoder.encode('\u001bPq~'), freshStart: 0 })
    queue.enqueue({ bytes: encoder.encode('~\u001b\\'), freshStart: null })

    expect(send.mock.calls.map(([message]) => new TextDecoder().decode(message.bytes)))
      .toEqual(['\u001b\\text', '\u001bPq~', '~\u001b\\'])
    expect(queue.skippedBytes).toBe(4)
  })

  it('skips a whole first frame whose fresh start is its end', () => {
    const send = vi.fn()
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      send,
      pause: vi.fn(),
      resume: vi.fn(),
      disconnect: vi.fn()
    })
    const encoder = new TextEncoder()

    queue.enqueue({ bytes: encoder.encode('~\u0007'), freshStart: 2 })
    queue.enqueue({ bytes: encoder.encode('text'), freshStart: 0 })

    expect(send.mock.calls.map(([message]) => new TextDecoder().decode(message.bytes))).toEqual(['text'])
    expect(queue.skippedBytes).toBe(2)
  })

  it('returns an unsent frame with its fresh start so the next view can use it', () => {
    const disconnect = vi.fn()
    const queue = new HostOutputQueue({
      attachmentId: 'attachment',
      consumerBytes: 4,
      hostBytes: 8,
      send: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      disconnect
    })
    const header = new TextEncoder().encode('\u001bPq~')
    const continuation = { bytes: new TextEncoder().encode('~~~~~'), freshStart: null }

    queue.enqueue({ bytes: header, freshStart: 0 })
    queue.enqueue(continuation)

    expect(disconnect).toHaveBeenCalledWith('output-overflow', {
      unsentFrames: [continuation],
      discardedPartialFrameBytes: 0
    })
  })
})

interface OutputFlow {
  attach(attachmentId: string): void
  accept(
    message: TerminalOutputMessage,
    actions: {
      write(bytes: Uint8Array, settled: () => void): void
      acknowledge(attachmentId: string, streamSeq: number): void
      recover(reason: string): void
    }
  ): boolean
}

const TERMINAL_OUTPUT_FLOW_MODULE = '../renderer/src/terminal-output-flow'
const SCREEN = { cols: 97, rows: 24, scrollback: 100_000 }

function joined(parts: ArrayLike<number>[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.length
  }
  return bytes
}

/**
 * Sends a stream the way a live view receives it: framed in PTY-sized reads, cut into host
 * chunks by the view's credit, written to xterm by the renderer's output flow. Returns what the
 * view's xterm shows.
 */
async function shownByView(
  stream: Uint8Array,
  options: { reads: number[]; consumerBytes?: number | undefined }
): Promise<{ screen: string; state: number; chunks: number[] }> {
  const { TerminalOutputFlow } = await vi.importActual(TERMINAL_OUTPUT_FLOW_MODULE) as {
    TerminalOutputFlow: new () => OutputFlow
  }
  const view = new XtermParser(SCREEN)
  const flow = new TerminalOutputFlow()
  flow.attach('view')
  const settles: Array<() => void> = []
  const acknowledgements: number[] = []
  const chunks: number[] = []
  const queue = new HostOutputQueue({
    attachmentId: 'view',
    ...(options.consumerBytes === undefined ? {} : { consumerBytes: options.consumerBytes }),
    send: (message) => {
      chunks.push(message.bytes.byteLength)
      flow.accept(message, {
        write: (bytes, settled) => {
          view.write(bytes)
          settles.push(settled)
        },
        acknowledge: (_attachmentId, streamSeq) => acknowledgements.push(streamSeq),
        recover: (reason) => {
          throw new Error(`view recovered: ${reason}`)
        }
      })
    },
    pause: () => undefined,
    resume: () => undefined,
    disconnect: (reason) => {
      throw new Error(`view disconnected: ${reason}`)
    }
  })
  const pump = (): void => {
    while (settles.length > 0 || acknowledgements.length > 0) {
      settles.shift()?.()
      const streamSeq = acknowledgements.shift()
      if (streamSeq !== undefined) queue.acknowledge(streamSeq)
    }
  }
  const framer = new TerminalByteFramer()
  let offset = 0
  let read = 0
  while (offset < stream.byteLength) {
    const end = Math.min(stream.byteLength, offset + options.reads[read++ % options.reads.length]!)
    for (const frame of framer.push(stream.subarray(offset, end))) queue.enqueue(frame)
    pump()
    offset = end
  }
  for (const frame of framer.flush()) queue.enqueue(frame)
  pump()
  const shown = { screen: view.screen, state: view.state, chunks }
  view.dispose()
  return shown
}

function shownByUncutRead(stream: Uint8Array): { screen: string; state: number } {
  const reference = new XtermParser(SCREEN)
  reference.parse(stream)
  const shown = { screen: reference.screen, state: reference.state }
  reference.dispose()
  return shown
}

describe('terminal output cut into host chunks and xterm writes', () => {
  const encoder = new TextEncoder()
  const dashes = (before: number, after: string): Uint8Array =>
    joined([new Uint8Array(before).fill(0x78), encoder.encode(`\u2014${after}`)])

  it.each([
    ['a 256 KiB host chunk', dashes(MAX_TERMINAL_CHUNK_BYTES - 2, ' after the chunk'), undefined],
    ["xterm's 131,072-byte write piece", dashes(131_070, ' after the piece'), undefined],
    ['a 4,096-byte credit', dashes(4_094, ' after the credit'), 4_096]
  ])('keeps a character that %s would end right after its 0x80 byte', async (_limit, stream, consumerBytes) => {
    const shown = await shownByView(stream, { reads: [stream.byteLength], consumerBytes })

    expect(shown.screen).toContain('\u2014 after the')
    expect(shown).toMatchObject(shownByUncutRead(stream))
  })

  it('keeps an escape sequence whose character a cut would drop, so later text is not read as a string', async () => {
    const stream = joined([new Uint8Array(MAX_TERMINAL_CHUNK_BYTES - 3).fill(0x78), [0x1b], encoder.encode('\u2014PqVISIBLE')])
    const shown = await shownByView(stream, { reads: [stream.byteLength] })

    expect(shown.screen).toContain('PqVISIBLE')
    expect(shown).toMatchObject(shownByUncutRead(stream))
  })

  it.each(Array.from({ length: 16 }, (_, seed) => seed))(
    'shows random output as an uncut read does (seed %i)',
    async (seed) => {
      const random = seeded(0xd1 + seed)
      const text = ['\u2014', '\u2026', '\u2019', '\u2003', 'М', '😀', 'x', ' '].map((character) => encoder.encode(character))
      const parts: ArrayLike<number>[] = []
      for (let part = 0; part < 6; part += 1) {
        parts.push(generatedTerminalOutput(random, { segments: 40, largestString: 70_000 }))
        const run: number[] = []
        const size = Math.floor(random() * 300_000)
        while (run.length < size) run.push(...pick(random, text))
        parts.push(run)
      }
      const stream = joined(parts)
      const reads = Array.from({ length: 7 }, () => 1 + Math.floor(random() * 400_000))
      const consumerBytes = pick(random, [4_096, 10_007, 65_537, 131_072, 300_007, undefined])
      const shown = await shownByView(stream, { reads, consumerBytes })

      expect(shown).toMatchObject(shownByUncutRead(stream))
    },
    30_000
  )

  // Measured 1.7 s on an idle 12-core machine (2026-09-28); it timed out at vitest's default 5 s at load average 16.
  it('cuts only where xterm decodes the pieces as it decodes the uncut bytes', () => {
    const random = seeded(0xc07)
    const pieces = [[0x41], [0x7f], [0x80], [0x94], [0xbf], [0xc2], [0xc3, 0xa9], [0xe2, 0x80], [0xe2, 0x80, 0x94], [0xe2],
      [0xf0, 0x90, 0x80, 0x80], [0xf0, 0x9f, 0x98, 0x80], [0xf0, 0x80], [0xed, 0xa0, 0x80], [0xc0, 0x80], [0xff]]
    for (let run = 0; run < 3_000; run += 1) {
      const bytes = joined(Array.from({ length: 1 + Math.floor(random() * 12) }, () => pick(random, pieces)))
      const cut = xtermUtf8Decoder()
      const codePoints: number[] = []
      let start = 0
      while (start < bytes.byteLength) {
        let end = terminalWriteCut(bytes, start, start + 1 + Math.floor(random() * 5))
        if (end === start) end = terminalWriteCut(bytes, start, start + 4)
        expect(end, `no cut after ${start} in ${Buffer.from(bytes).toString('hex')}`).toBeGreaterThan(start)
        codePoints.push(...cut.decode(bytes.subarray(start, end)))
        start = end
      }
      const uncut = xtermUtf8Decoder()
      const expected = uncut.decode(bytes)
      expect({ codePoints, interim: cut.interim }, Buffer.from(bytes).toString('hex'))
        .toEqual({ codePoints: expected, interim: uncut.interim })
    }
  }, 30_000)

  it.each([4, 5, 6, 7])('delivers every character with the smallest credit a view may have, %i bytes', async (consumerBytes) => {
    const stream = encoder.encode('\u{1F600}\u2014é\u2026x\u{10000}'.repeat(200))
    const shown = await shownByView(stream, { reads: [97, 13], consumerBytes })

    expect(shown).toMatchObject(shownByUncutRead(stream))
  })

  it.each([4, 5, 7, 4_096, 65_537])('sends each chunk from where the previous one ended (credit %i)', (consumerBytes) => {
    // Every position holds a different counter, so a chunk cut from the wrong offset cannot match.
    const frames = [0, 1, 2].map((part) => encoder.encode(
      Array.from({ length: 9_000 }, (_, index) => `${part}:${String(index).padStart(6, '0')} `).join('')))
    const chunks: Uint8Array[] = []
    const queue = new HostOutputQueue({
      attachmentId: 'view',
      consumerBytes,
      hostBytes: 1_000_000,
      send: (message) => chunks.push(message.bytes),
      pause: vi.fn(),
      resume: vi.fn(),
      disconnect: vi.fn()
    })
    for (const frame of frames) queue.enqueue({ bytes: frame, freshStart: 0 })
    for (let streamSeq = 0; streamSeq < chunks.length; streamSeq += 1) queue.acknowledge(streamSeq)

    expect(Buffer.concat(chunks).equals(Buffer.concat(frames))).toBe(true)
    expect(chunks.every((chunk) => chunk.byteLength <= consumerBytes)).toBe(true)
  })

  it('refuses a view credit that cannot hold one whole character', () => {
    const options = { attachmentId: 'view', send: vi.fn(), pause: vi.fn(), resume: vi.fn(), disconnect: vi.fn() }

    for (const consumerBytes of [0, 1, 3, 4.5]) {
      expect(() => new HostOutputQueue({ ...options, consumerBytes })).toThrow(RangeError)
    }
    expect(() => new HostOutputQueue({ ...options, consumerBytes: 4 })).not.toThrow()
  })
})
