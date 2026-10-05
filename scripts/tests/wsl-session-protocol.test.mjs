// MODULE: wsl-session-protocol.test.mjs - both sides of the WSL session protocol against the shared hand-written vectors
// Preparatory (Story 53.5): no WSL, root or network; the guest side runs in a plain Python process.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ENVIRONMENT_ALLOWLIST, FrameDecoder, HEADER_BYTES, HELPER_EXIT_CODES, MAX_PAYLOAD, NativeSession, ProtocolError,
  encodeControl, encodeFrame, encodeResize, encodeTerminal, failureFromHelperExit, validateLaunch
} from '../lib/wsl-session-protocol.mjs'

const vectors = JSON.parse(readFileSync(new URL('../test/fixtures/wsl-session-protocol-vectors.json', import.meta.url), 'utf8'))
const guestModule = fileURLToPath(new URL('../lib/wsl-session-protocol.py', import.meta.url))
const hex = (bytes) => Buffer.from(bytes).toString('hex')
const fromHex = (text) => new Uint8Array(Buffer.from(text, 'hex'))

/** Every vector runs whole, one byte at a time and in uneven pieces; the results must not depend on the split. */
const SPLITS = ['whole', 'bytes', 'uneven']
function split(bytes, mode) {
  if (mode === 'whole') return [bytes]
  if (mode === 'bytes') return [...bytes].map((byte) => Uint8Array.of(byte))
  const sizes = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89]
  const pieces = []
  for (let offset = 0, index = 0; offset < bytes.byteLength; index += 1) {
    pieces.push(bytes.subarray(offset, offset + sizes[index % sizes.length]))
    offset += sizes[index % sizes.length]
  }
  return pieces
}

const payloadOf = (frame) => frame.json !== undefined ? new TextEncoder().encode(JSON.stringify(frame.json))
  : frame.text !== undefined ? new TextEncoder().encode(frame.text)
    : frame.frameOf !== undefined ? encodeControl(frame.frameOf) : fromHex(frame.hex)
const streamOf = (input) => Buffer.concat(input.map((item) => item.raw !== undefined ? fromHex(item.raw) : encodeFrame(item.channel, payloadOf(item))))
const expectedEvents = (events) => events.map((event) => event.frameOf === undefined ? event
  : { type: event.type, bytes: hex(encodeControl(event.frameOf)) })

function patched(base, patch) {
  const message = structuredClone(base)
  for (const [path, value] of patch) {
    let target = message
    for (const key of path.slice(0, -1)) target = target[key]
    if (value !== null && typeof value === 'object' && value.$delete) delete target[path.at(-1)]
    else target[path.at(-1)] = value
  }
  return message
}
const launchMessages = vectors.launch.map((vector) => vector.message ?? patched(vectors.launchBase, vector.patch))

// The guest side: one Python process runs every vector and answers with plain JSON.
const GUEST_DRIVER = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('wsl_session_protocol', sys.argv[1])
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)
packet = json.loads(sys.stdin.read())
def split(data, mode):
    if mode == 'whole': return [data]
    if mode == 'bytes': return [data[i:i + 1] for i in range(len(data))]
    sizes, pieces, offset, index = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89], [], 0, 0
    while offset < len(data):
        size = sizes[index % len(sizes)]; pieces.append(data[offset:offset + size]); offset += size; index += 1
    return pieces
def payload(frame):
    if 'json' in frame: return json.dumps(frame['json'], separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    if 'text' in frame: return frame['text'].encode('utf-8')
    if 'frameOf' in frame: return p.encode_control(frame['frameOf'])
    return bytes.fromhex(frame['hex'])
def stream(items):
    return b''.join(bytes.fromhex(i['raw']) if 'raw' in i else p.encode_frame(i['channel'], payload(i)) for i in items)
def decode(data, mode):
    decoder, frames, error, held = p.FrameDecoder(), [], None, 0
    for piece in split(data, mode):
        got, error = decoder.push(piece)
        frames += [{'channel': c, 'payload': b.hex()} for c, b in got]
        held = max(held, decoder.buffered_bytes)
        if error: return frames, error.reason, held
    end = decoder.end()
    return frames, end.reason if end else None, held
def plain(event):
    return {k: (v.hex() if isinstance(v, (bytes, bytearray)) else v) for k, v in event.items()}
out = {'constants': {'helperExitCodes': p.HELPER_EXIT_CODES, 'environmentAllowlist': list(p.ENVIRONMENT_ALLOWLIST)},
       'frames': [], 'malformed': [], 'launch': [], 'guest': []}
for v in packet['vectors']['frames']:
    encoded = stream(v['frames'])
    out['frames'].append({'hex': encoded.hex(), 'decoded': {m: decode(encoded, m) for m in packet['splits']}})
for v in packet['vectors']['malformed']:
    out['malformed'].append({m: decode(bytes.fromhex(v['hex']), m) for m in packet['splits']})
for message in packet['launch']:
    try:
        p.validate_launch(message); out['launch'].append({'ok': True})
    except p.ProtocolError as error:
        out['launch'].append({'code': error.code, 'reason': error.reason})
for v in packet['vectors']['guest']:
    runs = {}
    for mode in packet['splits']:
        session, events = p.GuestSession(), []
        for piece in split(stream(v['input']), mode): events += session.push(piece)
        events += session.end()
        runs[mode] = {'events': [plain(e) for e in events], 'state': session.state, 'dropped': session.dropped}
    out['guest'].append(runs)
big = bytes(range(256)) * 800
out['terminal'] = [frame.hex()[:16] for frame in p.encode_terminal(big)] + [p.encode_terminal(b'')[0].hex()]
out['exitCodes'] = {code: p.helper_exit_code(code) for code in list(p.HELPER_EXIT_CODES) + ['WSL_MISSING']}
print(json.dumps(out))
`
let guestResults
const guest = () => guestResults ??= JSON.parse(execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', GUEST_DRIVER, guestModule], {
  input: JSON.stringify({ vectors, launch: launchMessages, splits: SPLITS }), encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024
}))

function nativeDecode(bytes, mode) {
  const decoder = new FrameDecoder()
  const frames = []
  let held = 0
  for (const piece of split(bytes, mode)) {
    const result = decoder.push(piece)
    frames.push(...result.frames.map((frame) => ({ channel: frame.channel, payload: hex(frame.payload) })))
    held = Math.max(held, decoder.bufferedBytes)
    if (result.error) return [frames, result.error.reason, held]
  }
  return [frames, decoder.end()?.reason ?? null, held]
}

describe('WSL session protocol: shared vectors on both sides', () => {
  it('both sides use the same failure codes and environment allowlist as the vectors', () => {
    expect(HELPER_EXIT_CODES).toEqual(vectors.helperExitCodes)
    expect([...ENVIRONMENT_ALLOWLIST]).toEqual(vectors.environmentAllowlist)
    expect(guest().constants).toEqual({ helperExitCodes: vectors.helperExitCodes, environmentAllowlist: vectors.environmentAllowlist })
  })

  it('encodes frames byte for byte alike, and both decode them back under any split', () => {
    vectors.frames.forEach((vector, index) => {
      const encoded = streamOf(vector.frames)
      const expectedFrames = vector.frames.map((frame) => ({ channel: frame.channel, payload: hex(payloadOf(frame)) }))
      if (vector.hex) expect(hex(encoded), vector.name).toBe(vector.hex)
      expect(guest().frames[index].hex, vector.name).toBe(hex(encoded))
      for (const mode of SPLITS) {
        const [frames, error, held] = nativeDecode(encoded, mode)
        expect({ frames, error }, `${vector.name} (${mode})`).toEqual({ frames: expectedFrames, error: null })
        expect(held).toBeLessThanOrEqual(HEADER_BYTES + MAX_PAYLOAD)
        expect(guest().frames[index].decoded[mode].slice(0, 2), `${vector.name} (${mode}, guest)`).toEqual([expectedFrames, null])
      }
    })
  })

  it('refuses malformed streams at the same point on both sides, before buffering an oversized payload', () => {
    vectors.malformed.forEach((vector, index) => {
      for (const mode of SPLITS) {
        const [frames, error, held] = nativeDecode(fromHex(vector.hex), mode)
        expect({ frames: frames.length, error }, `${vector.name} (${mode})`).toEqual({ frames: vector.framesBefore, error: vector.reason })
        expect(held).toBeLessThanOrEqual(HEADER_BYTES + MAX_PAYLOAD)
        const [guestFrames, guestError] = guest().malformed[index][mode]
        expect({ frames: guestFrames.length, error: guestError }, `${vector.name} (${mode}, guest)`).toEqual({ frames: vector.framesBefore, error: vector.reason })
      }
    })
  })

  it('validates launch messages alike, naming the refused field', () => {
    vectors.launch.forEach((vector, index) => {
      let native
      try {
        validateLaunch(launchMessages[index])
        native = { ok: true }
      } catch (error) {
        expect(error, vector.name).toBeInstanceOf(ProtocolError)
        native = { code: error.code, reason: error.reason }
      }
      const guestAnswer = guest().launch[index]
      if (vector.ok) {
        expect(native, vector.name).toEqual({ ok: true })
        expect(guestAnswer, `${vector.name} (guest)`).toEqual({ ok: true })
      } else {
        for (const answer of [native, guestAnswer]) {
          expect(answer.code, vector.name).toBe('PROTOCOL')
          expect(answer.reason.startsWith(`${vector.field} `), `${vector.name}: ${answer.reason}`).toBe(true)
        }
        expect(guestAnswer.reason, `${vector.name}: both sides give the same reason`).toBe(native.reason)
      }
    })
  })

  it('runs the guest session to the expected events under any split', () => {
    vectors.guest.forEach((vector, index) => {
      for (const mode of SPLITS) {
        expect(guest().guest[index][mode], `${vector.name} (${mode})`).toEqual({ events: vector.events, state: vector.state, dropped: vector.dropped })
      }
    })
  })

  it('runs the native session to the expected events and receipt under any split', () => {
    for (const vector of vectors.native) {
      for (const mode of SPLITS) {
        const session = new NativeSession(vectors.nonce)
        const events = []
        for (const piece of split(streamOf(vector.input), mode)) events.push(...session.push(piece))
        events.push(...session.end())
        const plain = events.map((event) => event.bytes === undefined ? event : { ...event, bytes: hex(event.bytes) })
        expect(plain, `${vector.name} (${mode})`).toEqual(expectedEvents(vector.events))
        expect(session.complete, `${vector.name} (${mode}) receipt`).toBe(vector.complete)
      }
    }
  })

  it('splits large terminal output into frames of at most 64 KiB on both sides, and sends empty output as one frame', () => {
    const big = new Uint8Array(256 * 800).map((_, index) => index % 256)
    const frames = encodeTerminal(big)
    expect(frames.map((frame) => frame.byteLength - HEADER_BYTES)).toEqual([65536, 65536, 65536, 8192])
    const [decoded, error] = nativeDecode(Buffer.concat(frames), 'whole')
    expect(error).toBeNull()
    expect(decoded.map((frame) => frame.payload).join('')).toBe(hex(big))
    expect(guest().terminal).toEqual([...frames.map((frame) => hex(frame).slice(0, 16)), hex(encodeTerminal(new Uint8Array(0))[0])])
  })

  it('maps helper exit codes to typed failures and back; unknown codes are INTERNAL', () => {
    expect(failureFromHelperExit(0)).toBeNull()
    for (const [code, number] of Object.entries(vectors.helperExitCodes)) {
      expect(failureFromHelperExit(number)).toBe(code)
      expect(guest().exitCodes[code]).toBe(number)
    }
    expect(failureFromHelperExit(1)).toBe('INTERNAL')
    expect(guest().exitCodes.WSL_MISSING).toBe(70)
  })

  it('refuses to send a resize outside the session limits or a frame on a reserved channel', () => {
    expect(hex(encodeResize(80, 24))).toBe('010200000000000400500018')
    expect(() => encodeResize(1, 24)).toThrow('size.cols must be an integer from 2 to 1000')
    expect(() => encodeFrame(3, new Uint8Array(0))).toThrow('channel 3 cannot be sent')
  })
})
