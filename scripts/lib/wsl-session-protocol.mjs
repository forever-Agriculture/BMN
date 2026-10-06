// MODULE: wsl-session-protocol.mjs - native side of the WSL session wire protocol (frames, launch schema, session receipt)
// Preparatory (Story 53.5): not wired to BMN. The guest side is wsl-session-protocol.py; both follow
// docs/wsl-session-protocol.md and the shared vectors in scripts/test/fixtures/wsl-session-protocol-vectors.json.

export const PROTOCOL_VERSION = 1
export const PROFILE_VERSIONS = Object.freeze(['restricted-1'])
export const CHANNELS = Object.freeze({ control: 0, terminal: 1, resize: 2 })
/** Reserved until designed and reviewed: bridge (3) and file transfer (4). */
export const RESERVED_CHANNELS = Object.freeze([3, 4])
export const HEADER_BYTES = 8
export const MAX_PAYLOAD = 65536
export const ENVIRONMENT_ALLOWLIST = Object.freeze(['TERM', 'COLORTERM', 'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES',
  'LC_COLLATE', 'LC_NUMERIC', 'LC_TIME', 'TZ', 'NO_COLOR', 'FORCE_COLOR', 'CLICOLOR'])
/** Typed failures the guest can report, with the helper's process exit code for each. */
export const HELPER_EXIT_CODES = Object.freeze({ UNSUPPORTED_PROFILE: 69, INTERNAL: 70, EXEC_FAILED: 71, STORAGE_RECOVERY: 74,
  LEASE_UNAVAILABLE: 75, PROTOCOL: 76, AUTH: 77, ROOT_DENIED: 78, CLEANUP_UNCONFIRMED: 79 })
/** Found on the Windows side only; never reported by the guest. */
export const NATIVE_ONLY_CODES = Object.freeze(['WSL_MISSING', 'DISTRO_CHANGED'])

export class ProtocolError extends Error {
  /** @param {string} code a typed failure code @param {string} reason */
  constructor(code, reason) {
    super(`${code}: ${reason}`)
    this.code = code
    this.reason = reason
  }
}

const fail = (reason, code = 'PROTOCOL') => { throw new ProtocolError(code, reason) }
const maxPayload = (channel) => channel === CHANNELS.resize ? 4 : MAX_PAYLOAD

/** One frame's bytes. `payload` is a Uint8Array. */
export function encodeFrame(channel, payload) {
  if (![CHANNELS.control, CHANNELS.terminal, CHANNELS.resize].includes(channel)) fail(`channel ${channel} cannot be sent`)
  if (channel === CHANNELS.resize ? payload.byteLength !== 4 : payload.byteLength > MAX_PAYLOAD) {
    fail(`payload of ${payload.byteLength} bytes does not fit channel ${channel}`)
  }
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength)
  const view = new DataView(frame.buffer)
  view.setUint8(0, PROTOCOL_VERSION)
  view.setUint8(1, channel)
  view.setUint32(4, payload.byteLength)
  frame.set(payload, HEADER_BYTES)
  return frame
}

export const encodeControl = (message) => encodeFrame(CHANNELS.control, new TextEncoder().encode(JSON.stringify(message)))

/** Terminal bytes as as many frames as their size needs. */
export function encodeTerminal(bytes) {
  const frames = []
  for (let offset = 0; offset < bytes.byteLength || frames.length === 0; offset += MAX_PAYLOAD) {
    frames.push(encodeFrame(CHANNELS.terminal, bytes.subarray(offset, offset + MAX_PAYLOAD)))
  }
  return frames
}

export function encodeResize(cols, rows) {
  validateSize({ cols, rows }, 'size')
  const payload = new Uint8Array(4)
  new DataView(payload.buffer).setUint16(0, cols)
  new DataView(payload.buffer).setUint16(2, rows)
  return encodeFrame(CHANNELS.resize, payload)
}

/**
 * Streaming frame decoder. `push` returns the frames that chunk completed and, once the stream breaks the format,
 * the error (frames before the break are still returned, so any split of the same bytes gives the same result);
 * `end` returns the truncation error, if any. The header is checked before any payload is buffered, so at most one
 * header and one largest payload are held. After an error the decoder accepts nothing more.
 */
export class FrameDecoder {
  #buffer = new Uint8Array(0)
  #failed = false

  get bufferedBytes() { return this.#buffer.byteLength }

  /** @returns {{ frames: Array<{ channel: number, payload: Uint8Array }>, error: ProtocolError | null }} */
  push(chunk) {
    if (this.#failed) return { frames: [], error: new ProtocolError('PROTOCOL', 'the stream already failed') }
    const joined = new Uint8Array(this.#buffer.byteLength + chunk.byteLength)
    joined.set(this.#buffer)
    joined.set(chunk, this.#buffer.byteLength)
    const frames = []
    let offset = 0
    while (joined.byteLength - offset >= HEADER_BYTES) {
      const view = new DataView(joined.buffer, joined.byteOffset + offset, HEADER_BYTES)
      const problem = headerProblem(view.getUint8(0), view.getUint8(1), view.getUint16(2), view.getUint32(4))
      if (problem) {
        this.#failed = true
        this.#buffer = new Uint8Array(0)
        return { frames, error: new ProtocolError('PROTOCOL', problem) }
      }
      const length = view.getUint32(4)
      if (joined.byteLength - offset - HEADER_BYTES < length) break
      frames.push({ channel: view.getUint8(1), payload: joined.slice(offset + HEADER_BYTES, offset + HEADER_BYTES + length) })
      offset += HEADER_BYTES + length
    }
    this.#buffer = joined.slice(offset)
    return { frames, error: null }
  }

  /** @returns {ProtocolError | null} */
  end() {
    if (this.#failed || this.#buffer.byteLength === 0) return null
    this.#failed = true
    return new ProtocolError('PROTOCOL', `input ended inside a frame (${this.#buffer.byteLength} bytes held)`)
  }
}

function headerProblem(version, channel, reserved, length) {
  if (version !== PROTOCOL_VERSION) return `unsupported frame version ${version}`
  if (RESERVED_CHANNELS.includes(channel)) return `channel ${channel} is reserved`
  if (![CHANNELS.control, CHANNELS.terminal, CHANNELS.resize].includes(channel)) return `unknown channel ${channel}`
  if (reserved !== 0) return 'reserved header bits are set'
  if (channel === CHANNELS.resize ? length !== 4 : length > maxPayload(channel)) return `a ${length}-byte payload does not fit channel ${channel}`
  return null
}

/** A control payload as an object; strict UTF-8 and a JSON object, or PROTOCOL. */
export function decodeControl(payload) {
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload)
  } catch {
    fail('control payload is not UTF-8')
  }
  let message
  try {
    message = JSON.parse(text)
  } catch {
    fail('control payload is not JSON')
  }
  if (message === null || typeof message !== 'object' || Array.isArray(message)) fail('control payload is not an object')
  return message
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const utf8Bytes = (text) => new TextEncoder().encode(text).byteLength

function exactKeys(value, keys, field) {
  if (!isObject(value)) fail(`${field || 'message'} must be an object`)
  for (const key of Object.keys(value)) if (!keys.includes(key)) fail(`${field ? `${field}.` : ''}${key} is not allowed`)
  for (const key of keys) if (!(key in value)) fail(`${field ? `${field}.` : ''}${key} is missing`)
}

function plainText(value, field, { limit = 4096, empty = false } = {}) {
  if (typeof value !== 'string') fail(`${field} must be a string`)
  if (!empty && value.length === 0) fail(`${field} is empty`)
  if (value.includes('\0')) fail(`${field} contains NUL`)
  // With the u flag only an unpaired surrogate matches; JSON can carry one, UTF-8 cannot.
  if (/[\uD800-\uDFFF]/u.test(value)) fail(`${field} is not valid Unicode`)
  if (utf8Bytes(value) > limit) fail(`${field} is longer than ${limit} bytes`)
  return value
}

export function validateLinuxPath(value, field) {
  plainText(value, field)
  if (!value.startsWith('/')) fail(`${field} is not absolute`)
  if (value !== '/' && value.slice(1).split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
    fail(`${field} is not a normalized path`)
  }
  return value
}

function integerIn(value, low, high, field) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < low || value > high) fail(`${field} must be an integer from ${low} to ${high}`)
  return value
}

function validateSize(size, field) {
  exactKeys(size, ['cols', 'rows'], field)
  integerIn(size.cols, 2, 1000, `${field}.cols`)
  integerIn(size.rows, 1, 1000, `${field}.rows`)
}

const NONCE = /^[0-9a-f]{32}$/u
const REGISTRATION = /^\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}$/u
const DISTRIBUTION_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const PROJECT_ID = /^[A-Za-z0-9_-]{1,64}$/u

/** Validates a launch message exactly; returns it, or throws PROTOCOL naming the field. */
export function validateLaunch(message) {
  exactKeys(message, ['type', 'protocol', 'profileVersion', 'sessionNonce', 'distribution', 'project', 'shell', 'cwd', 'environment', 'size'], '')
  if (message.type !== 'launch') fail('type must be launch')
  if (message.protocol !== PROTOCOL_VERSION) fail(`protocol must be ${PROTOCOL_VERSION}`)
  if (!PROFILE_VERSIONS.includes(message.profileVersion)) fail('profileVersion is not supported')
  if (typeof message.sessionNonce !== 'string' || !NONCE.test(message.sessionNonce)) fail('sessionNonce must be 32 lowercase hex characters')
  exactKeys(message.distribution, ['id', 'name'], 'distribution')
  if (typeof message.distribution.id !== 'string' || !REGISTRATION.test(message.distribution.id)) fail('distribution.id must be a lowercase registration GUID in braces')
  if (typeof message.distribution.name !== 'string' || !DISTRIBUTION_NAME.test(message.distribution.name)) fail('distribution.name is not allowed')
  exactKeys(message.project, ['id'], 'project')
  if (typeof message.project.id !== 'string' || !PROJECT_ID.test(message.project.id)) fail('project.id is not allowed')
  exactKeys(message.shell, ['argv'], 'shell')
  const argv = message.shell.argv
  if (!Array.isArray(argv) || argv.length < 1 || argv.length > 64) fail('shell.argv must hold 1 to 64 strings')
  validateLinuxPath(argv[0], 'shell.argv[0]')
  argv.slice(1).forEach((argument, index) => plainText(argument, `shell.argv[${index + 1}]`, { empty: true }))
  validateLinuxPath(message.cwd, 'cwd')
  if (!isObject(message.environment)) fail('environment must be an object')
  for (const [name, value] of Object.entries(message.environment)) {
    if (!ENVIRONMENT_ALLOWLIST.includes(name)) fail(`environment.${name} is not allowed`)
    plainText(value, `environment.${name}`, { empty: true })
  }
  validateSize(message.size, 'size')
  return message
}

/** The helper's process exit code as a typed failure; 0 is no failure. */
export function failureFromHelperExit(code) {
  if (code === 0) return null
  return Object.entries(HELPER_EXIT_CODES).find(([, number]) => number === code)?.[0] ?? 'INTERNAL'
}

const GUEST_CODES = Object.keys(HELPER_EXIT_CODES)

/**
 * The native side of one session: feeds the guest's bytes in, returns events, and keeps the receipt.
 * Events: ready, output (bytes), exit, failed. Every failure ends the session.
 */
export class NativeSession {
  #decoder = new FrameDecoder()
  #nonce
  state = 'awaiting-ready'
  receipt = { ready: null, exit: null, failure: null }

  constructor(sessionNonce) {
    if (typeof sessionNonce !== 'string' || !NONCE.test(sessionNonce)) fail('sessionNonce must be 32 lowercase hex characters')
    this.#nonce = sessionNonce
  }

  /** Bytes from the guest; returns the events they complete. */
  push(chunk) {
    if (this.state === 'failed') return []
    const events = []
    const { frames, error } = this.#decoder.push(chunk)
    try {
      for (const frame of frames) events.push(...this.#frame(frame))
    } catch (failure) {
      events.push(this.#failed(failure))
      return events
    }
    if (error) events.push(this.#failed(error))
    return events
  }

  /** End of the guest's output. */
  end() {
    if (this.state === 'failed') return []
    const truncated = this.#decoder.end()
    if (truncated) return [this.#failed(truncated)]
    if (this.state === 'exited') return []
    return [this.#failed(new ProtocolError(this.state === 'awaiting-ready' ? 'EXEC_FAILED' : 'CLEANUP_UNCONFIRMED',
      this.state === 'awaiting-ready' ? 'the guest ended before ready' : 'the guest ended without an exit receipt'))]
  }

  /** Complete only with a matching ready, a matching exit with confirmed cleanup, and no failure. */
  get complete() {
    return this.receipt.ready !== null && this.receipt.exit !== null && this.receipt.exit.cleanupConfirmed === true &&
      this.receipt.failure === null
  }

  #failed(error) {
    const failure = error instanceof ProtocolError ? { code: error.code, reason: error.reason } : { code: 'INTERNAL', reason: String(error) }
    this.state = 'failed'
    this.receipt.failure = failure
    return { type: 'failed', ...failure }
  }

  #frame({ channel, payload }) {
    if (this.state === 'exited') fail('bytes after the exit receipt')
    if (channel === CHANNELS.resize) fail('the guest cannot send resize frames')
    if (channel === CHANNELS.terminal) {
      if (this.state !== 'running') fail('terminal output before ready')
      return [{ type: 'output', bytes: payload }]
    }
    const message = decodeControl(payload)
    if (message.type === 'ready') {
      exactKeys(message, ['type', 'sessionNonce', 'profileVersion', 'leasedUid'], '')
      if (this.state !== 'awaiting-ready') fail('a second ready')
      if (message.sessionNonce !== this.#nonce) fail('ready names another session', 'AUTH')
      if (!PROFILE_VERSIONS.includes(message.profileVersion)) fail('ready names an unsupported profile', 'UNSUPPORTED_PROFILE')
      integerIn(message.leasedUid, 1, 2147483647, 'leasedUid')
      this.state = 'running'
      this.receipt.ready = { profileVersion: message.profileVersion, leasedUid: message.leasedUid }
      return [{ type: 'ready', ...this.receipt.ready }]
    }
    if (message.type === 'exit') {
      exactKeys(message, ['type', 'sessionNonce', 'payload', 'cleanupConfirmed'], '')
      if (this.state !== 'running') fail('exit before ready')
      if (message.sessionNonce !== this.#nonce) fail('exit names another session', 'AUTH')
      exactKeys(message.payload, ['code', 'signal'], 'payload')
      if (message.payload.code !== null) integerIn(message.payload.code, 0, 255, 'payload.code')
      if (message.payload.signal !== null && (typeof message.payload.signal !== 'string' || !/^SIG[A-Z0-9]{1,12}$/u.test(message.payload.signal))) {
        fail('payload.signal must be a signal name or null')
      }
      if ((message.payload.code === null) === (message.payload.signal === null)) fail('payload needs exactly one of code and signal')
      if (typeof message.cleanupConfirmed !== 'boolean') fail('cleanupConfirmed must be true or false')
      this.state = 'exited'
      this.receipt.exit = { payload: { code: message.payload.code, signal: message.payload.signal }, cleanupConfirmed: message.cleanupConfirmed }
      return [{ type: 'exit', ...this.receipt.exit }]
    }
    if (message.type === 'error') {
      exactKeys(message, ['type', 'sessionNonce', 'code', 'detail'], '')
      if (message.sessionNonce !== null && message.sessionNonce !== this.#nonce) fail('error names another session', 'AUTH')
      if (!GUEST_CODES.includes(message.code)) fail('error carries an unknown code')
      plainText(message.detail, 'detail', { limit: 512, empty: true })
      throw new ProtocolError(message.code, `guest: ${message.detail}`)
    }
    return fail('unknown control message')
  }
}
