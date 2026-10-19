// MODULE: bmn-commands.mjs - the bmn command line behind bin/bmn: its usage errors, the socket command table, argument parsing and the control-socket client
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { ConfigWriteError } from './safe-config-write.mjs'
import { isObject } from './shared-helpers.mjs'
import { ATTENTION_KINDS, FLAG_OPTIONS, LIST_OPTIONS, MAX_ANSWER_WAIT_SECONDS, PROGRESS_STATES, TIMEOUT_MS, USAGE, VALUE_OPTIONS } from './bmn-words.mjs'

export { COMMANDS, CliError, UsageError, call, callEach, commandUsage, describeAway, parseArguments, readCredentials, requireNonEmpty }

class UsageError extends Error {}

/**
 * One command's entries of the usage, for `bmn <command> --help` (Story 76.8: agents read help through `| head`, and
 * `decision` sat a hundred lines down the whole list, so a decision was never recorded); null for a command it does not list.
 */
function commandUsage(command) {
  // away and back share one description.
  const names = ['away', 'back'].includes(command) ? ['away', 'back'] : [command]
  const lines = USAGE.split('\n')
  const kept = []
  let inside = false
  for (const line of lines) {
    const entry = /^ {2}(\S+)/.exec(line)
    if (entry) inside = names.includes(entry[1])
    else if (!/^\s{4,}\S/.test(line)) inside = false
    if (inside) kept.push(line)
  }
  return kept.length === 0 ? null : `Usage: bmn ${command} …\n\n${kept.join('\n')}\n\nAll commands: bmn help`
}

/** A refusal with a stable code; the shared config writer throws the same class. */
const CliError = ConfigWriteError

/**
 * The choices of a manual card: `{"options":[{"label","description"}]}`, or the plain list agents write first, of labels or of
 * `{label, description?}` objects (Story 76.8: two agents could not leave a card from the error alone). Other keys of an
 * option are ignored; the result is always the strict form.
 */
function cliManualChoices(json, kind, title, requestKey) {
  const bad = () => { throw new UsageError('choices are 2–8 unique labels (1–200 characters) for a question or permission ask, as --choices-json \'["Release now","Hold"]\' or \'{"options":[{"label":"Release now","description":"Runs deploy.sh"},{"label":"Hold","description":null}]}\'') }
  let data
  try { data = JSON.parse(json) } catch { return bad() }
  if (Array.isArray(data)) data = { options: data }
  if (!['question', 'permission'].includes(kind) || !isObject(data) || Object.keys(data).join() !== 'options' ||
    !Array.isArray(data.options) || data.options.length < 2 || data.options.length > 8) return bad()
  data = { options: data.options.map((option) => typeof option === 'string' ? { label: option, description: null }
    : isObject(option) ? { label: option.label, description: option.description ?? null } : option) }
  const labels = new Set()
  // eslint-disable-next-line no-control-regex
  const safe = value => typeof value === 'string' && !/[\u0000-\u001f\u007f-\u009f\p{Cf}]/u.test(value)
  for (const option of data.options) {
    if (!isObject(option) || !safe(option.label) || !option.label.trim() || option.label.length > 200 || labels.has(option.label) ||
      option.description !== null && (!safe(option.description) || option.description.length > 500)) return bad()
    labels.add(option.label)
  }
  const escaped = value => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  if (data.options.reduce((sum, option) => sum + escaped(option.label).length + 12, 0) + escaped(title).length + escaped(requestKey).length + 1000 > 4096) {
    throw new UsageError('Choice labels cannot fit a Telegram card; use shorter labels')
  }
  return data
}

/** Story 76.3: the note, the revision an agent saw, and the key that makes a retry return the first result. */
function awayOptions(options) {
  let revision
  if (options.revision !== undefined) {
    if (!/^\d{1,15}$/.test(String(options.revision))) throw new UsageError('--revision must be a whole number (bmn away --status shows it)')
    revision = Number(options.revision)
  }
  if (options.note !== undefined && [...options.note].length > 200) throw new UsageError('--note is longer than 200 characters; nothing was changed')
  return {
    ...(options.note === undefined ? {} : { note: options.note }),
    ...(revision === undefined ? {} : { revision }),
    // Only a key the caller chose: a retry of it never changes the state again, however much later (Story 76.3 AC1).
    ...(options.key === undefined ? {} : { idempotencyKey: options.key })
  }
}

/** One line for a said state: away or back, since when, the revision, and the note where the caller may see it. */
function describeAway(result) {
  if (!isObject(result)) return JSON.stringify(result, null, 2)
  const since = typeof result.since === 'string' ? new Date(result.since) : null
  const at = since && Number.isFinite(since.getTime())
    ? since.toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : 'an unknown time'
  const head = result.state === 'leaving' ? `Leaving since ${at}; the runs are told and may each ask on one card (bmn grant --help)`
    : result.state === 'away' ? `Away since ${at}`
    : result.state === 'back' ? `Back; was away from ${at}` : 'Nothing said: BMN goes by the desk input'
  const outcome = result.outcome === 'unchanged' ? ' (nothing changed)' : result.outcome === 'repeated' ? ' (already done earlier; not repeated)' : ''
  const note = typeof result.note === 'string' && result.note !== '' ? `\nNote: ${result.note}` : ''
  return `${head} (revision ${result.revision})${outcome}${note}`
}

function withSession(options, params) {
  return options.session === undefined ? params : { sessionId: options.session, ...params }
}

function requireNonEmpty(value, label) {
  if (value === '') throw new UsageError(`${label} must not be empty`)
  return value
}

const COMMANDS = {
  snapshot: {
    args: [],
    options: [],
    build: () => ({ method: 'state.snapshot', params: {} })
  },
  list: {
    args: [],
    options: [],
    build: () => ({ method: 'session.list', params: {} })
  },
  publish: {
    args: ['file'],
    options: ['name', 'session', 'key'],
    build: ([file], options) => ({
      method: 'artifact.publish',
      params: withSession(options, {
        path: resolve(process.cwd(), requireNonEmpty(file, 'file')),
        ...(options.name === undefined ? {} : { name: options.name }),
        idempotencyKey: options.key ?? randomUUID()
      })
    })
  },
  decision: {
    args: ['action'],
    options: ['key', 'revision', 'choice', 'reason', 'affects', 'reverse', 'ref', 'depends', 'op', 'result', 'evidence-id'],
    build: ([action], options) => {
      const given = (names) => names.filter((name) => options[name] !== undefined)
      if (action === 'record') {
        const stray = given(['op', 'result', 'evidence-id'])
        if (stray.length > 0) throw new UsageError(`decision record does not take --${stray[0]}`)
        const missing = ['key', 'revision', 'choice', 'reason', 'affects', 'reverse'].filter((name) => options[name] === undefined)
        if (missing.length > 0) throw new UsageError(`decision record needs --${missing.join(', --')}`)
        if (!/^\d{1,15}$/.test(String(options.revision))) throw new UsageError('--revision must be the whole number bmn away --status shows')
        return {
          method: 'decision.record',
          params: {
            key: options.key, revision: Number(options.revision), choice: options.choice, reason: options.reason, affects: options.affects,
            reverse: options.reverse, references: options.ref ?? [], depends: options.depends ?? []
          }
        }
      }
      if (action === 'outcome') {
        const stray = given(['revision', 'choice', 'reason', 'affects', 'reverse', 'ref', 'depends'])
        if (stray.length > 0) throw new UsageError(`decision outcome does not take --${stray[0]}`)
        const missing = ['key', 'op', 'result'].filter((name) => options[name] === undefined)
        if (missing.length > 0) throw new UsageError(`decision outcome needs --${missing.join(', --')}`)
        if (!['done', 'failed'].includes(options.result)) throw new UsageError('--result must be done or failed')
        return { method: 'decision.outcome', params: { key: options.key, op: options.op, result: options.result, evidenceIds: options['evidence-id'] ?? [] } }
      }
      throw new UsageError('decision expects record or outcome')
    }
  },
  progress: {
    args: ['state', 'label'],
    options: ['source', 'detail', 'observed', 'session', 'evidence-id'],
    build: ([state, label], options) => {
      if (!PROGRESS_STATES.includes(state)) {
        throw new UsageError(`state must be one of ${PROGRESS_STATES.join(', ')}`)
      }
      const evidenceIds = options['evidence-id'] ?? []
      for (const id of evidenceIds) requireNonEmpty(id, 'evidence-id')
      return {
        method: 'progress.report',
        params: withSession(options, {
          source: options.source ?? 'bmn',
          state,
          label: requireNonEmpty(label, 'label'),
          ...(options.detail === undefined ? {} : { detail: options.detail }),
          // Omitted means this report has no evidence; it never inherits the previous report's files.
          ...(evidenceIds.length === 0 ? {} : { evidenceIds }),
          ...(options.observed === undefined ? {} : { observedAt: options.observed })
        })
      }
    }
  },
  ask: {
    args: ['request-key', 'title'],
    options: ['kind', 'body', 'expires', 'session', 'choices-json'],
    build: ([requestKey, title], options) => {
      const kind = options.kind ?? 'question'
      if (!ATTENTION_KINDS.includes(kind)) {
        throw new UsageError(`--kind must be one of ${ATTENTION_KINDS.join(', ')}`)
      }
      return {
        method: 'attention.open',
        params: withSession(options, {
          requestKey: requireNonEmpty(requestKey, 'request-key'),
          kind,
          title: requireNonEmpty(title, 'title'),
          origin: 'cli',
          ...(options['choices-json'] === undefined ? {} : { manualChoices: cliManualChoices(options['choices-json'], kind, title, requestKey) }),
          ...(options.body === undefined ? {} : { body: options.body }),
          ...(options.expires === undefined ? {} : { expiresAt: options.expires })
        })
      }
    }
  },
  withdraw: {
    args: ['request-key'],
    options: ['session'],
    build: ([requestKey], options) => ({
      method: 'attention.withdraw',
      params: withSession(options, { requestKey: requireNonEmpty(requestKey, 'request-key'), origin: 'cli' })
    })
  },
  resolve: {
    args: ['request-key', 'resolution'],
    options: ['session'],
    build: ([requestKey, resolution], options) => ({
      method: 'attention.resolve',
      params: withSession(options, {
        requestKey: requireNonEmpty(requestKey, 'request-key'),
        resolution: requireNonEmpty(resolution, 'resolution'),
        origin: 'cli'
      })
    })
  },
  answer: {
    args: ['action'],
    options: ['wait', 'reported'],
    build: ([action], options) => {
      if (action !== 'take') throw new UsageError('answer supports only: take')
      let reported
      if (options.reported !== undefined) {
        const match = /^([\x21-\x3c\x3e-\x7e]{1,128})=(ok|failed)$/.exec(String(options.reported))
        if (!match) throw new UsageError('--reported must be REQUEST_ID=ok or REQUEST_ID=failed')
        reported = { requestRef: match[1], delivered: match[2] === 'ok' }
      }
      const wait = options.wait === undefined ? 0 : Number(options.wait)
      if (!Number.isInteger(wait) || wait < 0 || wait > MAX_ANSWER_WAIT_SECONDS || !/^\d+$/.test(String(options.wait ?? '0'))) {
        throw new UsageError(`--wait must be a whole number of seconds from 0 to ${MAX_ANSWER_WAIT_SECONDS}`)
      }
      // The socket holds the call open for up to --wait; the connection deadline allows for it.
      return { method: 'answer.take', params: { wait, ...(reported ? { reported } : {}) }, timeoutMs: TIMEOUT_MS + wait * 1000 }
    }
  },
  peers: {
    args: [],
    options: [],
    build: () => ({ method: 'peers.list', params: {} })
  },
  away: {
    args: [],
    options: ['note', 'status', 'revision', 'key', 'leaving'],
    build: (_positionals, options) => {
      if (options.status) {
        if (options.note !== undefined || options.revision !== undefined || options.key !== undefined || options.leaving) {
          throw new UsageError('away --status takes no other option')
        }
        return { method: 'away.status', params: {} }
      }
      if (options.leaving) {
        if (options.note !== undefined) throw new UsageError('away --leaving takes no note; the note goes with away')
        return { method: 'away.set', params: { to: 'leaving', ...awayOptions(options) } }
      }
      return { method: 'away.set', params: { to: 'away', ...awayOptions(options) } }
    }
  },
  back: {
    args: [],
    options: ['revision', 'key'],
    build: (_positionals, options) => ({ method: 'away.set', params: { to: 'back', ...awayOptions(options) } })
  },
  send: {
    args: ['text'],
    options: ['submit', 'session', 'key'],
    build: ([text], options) => {
      const submit = options.submit === true
      if (text === '' && !submit) throw new UsageError('text must not be empty unless --submit is given')
      return {
        method: 'input.submit',
        params: withSession(options, { text, submit, idempotencyKey: options.key ?? randomUUID() })
      }
    }
  }
}

function parseArguments(argv) {
  const positionals = []
  const options = Object.create(null)
  let literal = false
  let literalStart = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (literal || !argument.startsWith('-') || argument === '-') {
      positionals.push(argument)
      continue
    }
    if (argument === '--') {
      literal = true
      literalStart = positionals.length
      continue
    }
    if (argument === '-h') {
      options.help = true
      continue
    }
    if (!argument.startsWith('--')) throw new UsageError(`unknown option ${argument}`)
    const equals = argument.indexOf('=')
    const name = argument.slice(2, equals === -1 ? undefined : equals)
    if (LIST_OPTIONS.has(name)) {
      const value = equals !== -1 ? argument.slice(equals + 1) : argv[index + 1]
      if (value === undefined) throw new UsageError(`--${name} requires a value`)
      if (equals === -1) index += 1
      options[name] = [...(options[name] ?? []), value]
      continue
    }
    if (options[name] !== undefined) throw new UsageError(`--${name} given more than once`)
    if (FLAG_OPTIONS.has(name)) {
      if (equals !== -1) throw new UsageError(`--${name} does not take a value`)
      options[name] = true
    } else if (VALUE_OPTIONS.has(name)) {
      if (equals !== -1) {
        options[name] = argument.slice(equals + 1)
      } else {
        if (index + 1 >= argv.length) throw new UsageError(`--${name} requires a value`)
        index += 1
        options[name] = argv[index]
      }
    } else {
      throw new UsageError(`unknown option --${name}`)
    }
  }
  return { positionals, options, literalStart }
}

function readCredentials(options) {
  const socketPath = options.socket ?? process.env.BMN_CONTROL_SOCKET ?? process.env.AITERM_CONTROL_SOCKET
  if (!socketPath) throw new UsageError('no control socket: set BMN_CONTROL_SOCKET or pass --socket')
  if (options.owner && options['token-file'] !== undefined) {
    throw new UsageError('use either --owner or --token-file, not both')
  }
  const tokenFile = options['token-file'] ?? (options.owner ? join(dirname(socketPath), 'owner.token') : undefined)
  if (tokenFile === undefined) {
    const token = process.env.BMN_TOKEN ?? process.env.AITERM_TOKEN
    if (!token) throw new UsageError('no credential: set BMN_TOKEN or pass --owner or --token-file')
    return { socketPath, token }
  }
  let token
  try {
    token = readFileSync(tokenFile, 'utf8').trim()
  } catch (error) {
    throw new CliError('IO_ERROR', `cannot read token file ${tokenFile} (${error.code ?? 'read failed'})`)
  }
  if (!token) throw new CliError('UNAUTHORIZED', `token file ${tokenFile} is empty`)
  return { socketPath, token }
}

function remoteError(error) {
  const code = isObject(error) && isObject(error.data) && typeof error.data.code === 'string'
    ? error.data.code
    : 'IO_ERROR'
  const message = isObject(error) && typeof error.message === 'string' ? error.message : 'request failed'
  return new CliError(code, message)
}

/** One connection per invocation: auth, then each request in order, close. A request's remote error does not stop the rest. */
function callEach(socketPath, token, requests, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolveCall, rejectCall) => {
    const socket = createConnection(socketPath)
    const outcomes = []
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      finish(new CliError('IO_ERROR', `no response from control socket within ${timeoutMs / 1000} s`))
    }, timeoutMs)

    function finish(error) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) rejectCall(error)
      else resolveCall(outcomes)
    }

    function send(id, requestMethod, requestParams) {
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: requestMethod, params: requestParams })}\n`)
    }

    function sendNext() {
      const next = requests[outcomes.length]
      // A trailing entry may be a function of the outcomes so far, so a call can report what the calls
      // before it actually did. Returning undefined ends the batch, which is how it declines to be sent.
      const resolved = typeof next === 'function' ? next(outcomes) : next
      if (resolved === undefined) finish(null)
      else send(outcomes.length + 2, resolved.method, resolved.params)
    }

    function handleLine(line) {
      let message
      try {
        message = JSON.parse(line)
      } catch {
        finish(new CliError('PROTOCOL_MISMATCH', 'control socket sent a malformed response'))
        return
      }
      if (!isObject(message)) {
        finish(new CliError('PROTOCOL_MISMATCH', 'control socket sent a malformed response'))
      } else if (message.id === 1) {
        if (message.error !== undefined) finish(remoteError(message.error))
        else sendNext()
      } else if (message.id === outcomes.length + 2) {
        outcomes.push(message.error !== undefined ? { error: remoteError(message.error) } : { result: message.result })
        sendNext()
      } else if (message.error !== undefined) {
        finish(remoteError(message.error))
      } else {
        finish(new CliError('PROTOCOL_MISMATCH', 'control socket answered an unknown request'))
      }
    }

    socket.setEncoding('utf8')
    socket.on('connect', () => send(1, 'auth', { token }))
    socket.on('data', (chunk) => {
      buffer += chunk
      let newline = buffer.indexOf('\n')
      while (newline !== -1 && !settled) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line.trim() !== '') handleLine(line)
        newline = buffer.indexOf('\n')
      }
    })
    socket.on('error', (error) => {
      // A sandboxed shell tool (Codex's, measured on 0.162.1) may not open a socket outside its sandbox.
      const sandboxed = error.code === 'EPERM' || error.code === 'EACCES'
        ? '. A sandbox may be keeping this command from BMN: ask to run it outside the sandbox'
        : ''
      finish(new CliError('IO_ERROR', `cannot reach control socket ${socketPath} (${error.code ?? error.message})${sandboxed}`))
    })
    socket.on('close', () => {
      finish(new CliError('IO_ERROR', 'control socket closed the connection before responding'))
    })
  })
}

async function call(socketPath, token, method, params, timeoutMs = TIMEOUT_MS) {
  const [outcome] = await callEach(socketPath, token, [{ method, params }], timeoutMs)
  if (outcome.error) throw outcome.error
  return outcome.result
}
