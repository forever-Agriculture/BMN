// MODULE: bmn-results.mjs - the bmn command line behind bin/bmn: what a socket command prints, and the requests for tell, piped fields and resume-command
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { isObject } from './shared-helpers.mjs'
import { GLOBAL_OPTIONS, PIPED_FIELDS } from './bmn-words.mjs'
import { UsageError, describeAway, requireNonEmpty } from './bmn-commands.mjs'

export { describeResult, resumeCommandRequest, takePipedField, tellRequest, usageFailure }

function describeSnapshot(result) {
  if (!isObject(result)) return JSON.stringify(result, null, 2)
  const lines = [`watermark: ${result.watermark}`]
  for (const [key, value] of Object.entries(result)) {
    if (key === 'watermark') continue
    if (Array.isArray(value)) lines.push(`${key}: ${value.length}`)
    else if (isObject(value)) lines.push(`${key}: ${Object.keys(value).length} entries`)
    else lines.push(`${key}: ${value}`)
  }
  return lines.join('\n')
}

function describeSessions(result) {
  const sessions = Array.isArray(result)
    ? result
    : isObject(result) && Array.isArray(result.sessions) ? result.sessions : null
  if (sessions === null) return JSON.stringify(result, null, 2)
  if (sessions.length === 0) return 'No sessions'
  return sessions
    .map((session) => {
      if (!isObject(session)) return String(session)
      return [session.sessionId ?? session.id, session.name ?? session.title, session.status ?? session.state]
        .filter((value) => value !== undefined && value !== null)
        .join('\t')
    })
    .join('\n')
}

function describeResult(command, positionals, options, result) {
  if (isObject(result) && result.state === 'uncertain') {
    return 'An earlier request with this key may already have been delivered; it was not repeated'
  }
  const duplicate = isObject(result) && result.duplicate === true ? ' (already done earlier; not repeated)' : ''
  switch (command) {
    case 'snapshot':
      return describeSnapshot(result)
    case 'list':
      return describeSessions(result)
    case 'publish': {
      const artifactId = isObject(result) && typeof result.artifactId === 'string' ? ` as ${result.artifactId}` : ''
      return `Published ${options.name ?? basename(positionals[0])}${artifactId}${duplicate}`
    }
    case 'handoff':
      return positionals[0] === 'status'
        ? describeHandoffStatus(result, positionals[1])
        : `Handoff ${isObject(result) ? result.draftId : 'unknown'} is queued for session ${positionals[0]}${duplicate}; ` +
          'BMN hands it to the agent there after its next tool call. Its state: bmn handoff status'
    case 'peers':
      return describePeers(result)
    case 'decision':
      if (positionals[0] === 'record') {
        return isObject(result) ? `Decision ${result.key} recorded (away revision ${result.revision})${result.outcome === 'repeated' ? ' (already recorded earlier; not repeated)' : ''}` : 'Decision recorded'
      }
      return isObject(result) ? `Outcome ${options.op} for decision ${result.key} reported${result.outcome === 'repeated' ? ' (already reported earlier; not repeated)' : ''}` : 'Outcome reported'
    case 'away':
    case 'back':
      return describeAway(result)
    case 'tell':
      return positionals[0] === 'status'
        ? describeTellStatus(result)
        : `Message ${isObject(result) ? result.messageId : 'unknown'} is waiting for session ${positionals[0]}${duplicate}. ` +
          'Its state: bmn tell status'
    case 'progress': {
      const attached = options['evidence-id']?.length ?? 0
      const evidence = attached === 0 ? '' : ` (${attached} evidence file${attached === 1 ? '' : 's'} attached, not checked)`
      return `Progress reported: ${positionals[0]}: ${positionals[1]}${evidence}`
    }
    case 'ask':
      return `Attention request ${positionals[0]} opened${duplicate}`
    case 'withdraw':
      return `Attention request ${positionals[0]} withdrawn`
    case 'resolve':
      return `Attention request ${positionals[0]} resolved`
    case 'send':
      return `${options.submit ? 'Input submitted' : 'Input pasted'}${duplicate}`
    case 'resume-command':
      if (options.clear) {
        return isObject(result) && result.cleared === false
          ? `No resume command was kept for this session${duplicate}`
          : `Resume command cleared${duplicate}`
      }
      return `Resume command recorded for this session: ${positionals.map(shellWord).join(' ')}${duplicate}`
    default:
      return JSON.stringify(result, null, 2)
  }
}

/**
 * Story 75.5: where a handoff stands. None of the words means the agent read it. A handoff prepared before 75.5
 * keeps the words of its draft, which is stored and never sent.
 */
function handoffStateWord(state) {
  switch (state) {
    case 'queued': return 'queued, not handed over yet'
    case 'printed': return 'printed for the agent, not proven read'
    case 'uncertain': return 'uncertain: handed over, not confirmed'
    case 'expired': return 'expired, never handed over'
    case 'draft': return 'prepared, never sent'
    case 'accepted':
    case 'submitted': return 'pasted (not submitted)'
    case 'discarded': return 'discarded'
    default: return 'unknown'
  }
}

function describeHandoffStatus(snapshot, draftId) {
  const rows = isObject(snapshot) && Array.isArray(snapshot.handoffs) ? snapshot.handoffs : []
  const visible = rows.filter((row) => isObject(row) && (draftId === undefined || row.draftId === draftId))
  if (visible.length === 0) return draftId === undefined ? 'No handoffs from this session' : 'No such handoff from this session'
  return visible.map((row) => `${row.draftId}\t${handoffStateWord(row.state)}\t${row.destinationSessionId ?? row.sessionId}\t${row.updatedAt}`).join('\n')
}

/**
 * Story 75.4: messages are on wherever the session and its workspace are not archived, and a limit pause lifts by
 * itself; the app is the agent in front of each peer's terminal now. The wording matches the protocol's
 * SESSION_MESSAGES_OFF and SESSION_MESSAGES_PAUSED.
 */
function describePeers(result) {
  if (!isObject(result) || result.on !== true) return 'This session or its workspace is archived; it sends no messages'
  const rows = Array.isArray(result.peers) ? result.peers.filter(isObject) : []
  const lines = result.paused === true
    ? ['Messages are paused in this workspace by its hourly limit; they are allowed again when the count falls']
    : []
  if (rows.length === 0) lines.push('No other session here receives messages')
  for (const row of rows) lines.push(`${row.sessionId}\t${row.name}\t${row.app ?? 'no agent now'}`)
  return lines.join('\n')
}

function describeTellStatus(result) {
  const rows = isObject(result) && Array.isArray(result.messages) ? result.messages.filter(isObject) : []
  if (rows.length === 0) return 'No messages sent by this session'
  return rows.map((row) => `${row.messageId}\t${row.state}\t${row.receiverSessionId}\t${row.sentAt}`).join('\n')
}

/**
 * Epic 66.2: `tell <session-id> --text T | --text-file - --key K` leaves one message; `tell status [message-id]`
 * reads the caller's own. The folder sent is the one this process stands in, which is where its agent works.
 */
function tellRequest(positionals, parsed) {
  for (const name of Object.keys(parsed.options)) {
    if (!GLOBAL_OPTIONS.includes(name) && !['text', 'key'].includes(name)) throw new UsageError(`tell does not accept --${name}`)
  }
  if (positionals[0] === 'status') {
    if (positionals.length > 2 || parsed.options.text !== undefined || parsed.options.key !== undefined) {
      throw new UsageError('tell status expects at most one message id and no other options')
    }
    return { method: 'message.status', params: positionals[1] === undefined ? {} : { messageId: requireNonEmpty(positionals[1], 'message id') } }
  }
  if (positionals.length !== 1 || parsed.literalStart !== null) {
    throw new UsageError('tell expects a session id and --text T or --text-file -')
  }
  if (!parsed.options.key) throw new UsageError('tell requires --key for safe retries')
  if (!parsed.options.text) throw new UsageError('tell requires its text: --text T or --text-file -')
  let senderCwd
  try {
    senderCwd = process.cwd()
  } catch {
    throw new UsageError('tell cannot read the folder it runs in; run it from an existing folder')
  }
  return { method: 'message.send', params: {
    destinationSessionId: requireNonEmpty(positionals[0], 'session id'),
    text: parsed.options.text, senderCwd, idempotencyKey: parsed.options.key
  } }
}

/**
 * Reads a piped field, stopping once the input is certainly over the limit: past the byte limit plus the one
 * trailing newline that is removed, or past four bytes per allowed character. Nothing is sent when it is over,
 * not valid UTF-8, or not piped at all.
 */
async function readPipedField(piped) {
  if (process.stdin.isTTY) throw new UsageError(`--${piped.option} - needs piped input, not a terminal`)
  // Where the app counts after its own cleaning (`received`), only what it would not even read is refused here.
  const most = piped.received ?? piped.limit
  const cap = piped.unit === 'bytes' ? most + 1 : most * 4
  const chunks = []
  let size = 0
  for await (const chunk of process.stdin) {
    chunks.push(chunk)
    size += chunk.length
    if (size > cap) break
  }
  const tooLong = new UsageError(`${piped.field} from standard input must be at most ${piped.limit} ${piped.unit}`)
  if (size > cap) throw tooLong
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new UsageError(`${piped.field} from standard input is not valid UTF-8`)
  }
  // A heredoc always ends in a newline the agent did not mean; anything else is kept exactly.
  if (text.endsWith('\n')) text = text.slice(0, -1)
  if ((piped.unit === 'bytes' ? Buffer.byteLength(text, 'utf8') : text.length) > most) throw tooLong
  return text
}

/** Replaces `--<field>-file -` with the text read from standard input, refusing a second source for the field. */
async function takePipedField(command, parsed, positionals) {
  if (command === 'ask' && parsed.options['choices-file'] !== undefined) {
    if (parsed.options['body-file'] !== undefined || parsed.options['choices-json'] !== undefined || parsed.options['choices-file'] !== '-') {
      throw new UsageError('choices take one source: --choices-json or --choices-file -; only one stdin source is allowed')
    }
    parsed.options['choices-json'] = await readPipedField({ option: 'choices-file', field: 'choices', limit: 24 * 1024, unit: 'bytes' })
    delete parsed.options['choices-file']
  }
  const piped = Object.hasOwn(PIPED_FIELDS, command) ? PIPED_FIELDS[command] : null
  if (piped === null || parsed.options[piped.option] === undefined) return positionals
  if (parsed.options[piped.option] !== '-') {
    throw new UsageError(`--${piped.option} accepts only - (standard input); to send a file, cat it into bmn`)
  }
  const inline = piped.twin === null ? positionals.length > 0
    : parsed.options[piped.twin] !== undefined || (command === 'handoff' && parsed.literalStart !== null)
  if (inline) {
    const other = piped.twin === null ? 'text' : command === 'handoff' ? '--text T or -- text' : `--${piped.twin}`
    throw new UsageError(`${command} takes its ${piped.field} from one source: ${other} or --${piped.option} -, not both`)
  }
  const text = await readPipedField(piped)
  delete parsed.options[piped.option]
  if (piped.twin === null) return [text]
  parsed.options[piped.twin] = text
  return positionals
}

function usageFailure(message) {
  process.stderr.write(`bmn: ${message}\nRun "bmn help" for usage.\n`)
  return 2
}

/**
 * Story 43.1: `resume-command -- <command> [args...]` reports how to resume the program running in this session;
 * `--clear` forgets it. Everything after -- is the command exactly as given, so its own options are never read as
 * bmn's. The app checks the rules and names the one a command breaks.
 */
function resumeCommandRequest(positionals, parsed) {
  for (const name of Object.keys(parsed.options)) {
    if (!GLOBAL_OPTIONS.includes(name) && !['clear', 'key'].includes(name)) {
      throw new UsageError(`resume-command does not accept --${name}`)
    }
  }
  const idempotencyKey = parsed.options.key ?? randomUUID()
  if (parsed.options.clear) {
    if (positionals.length > 0 || parsed.literalStart !== null) throw new UsageError('resume-command --clear takes no command')
    return { method: 'resume.clear', params: { idempotencyKey } }
  }
  if (parsed.literalStart !== 1 || positionals.length === 0) {
    throw new UsageError('resume-command expects -- <command> [arguments...] or --clear')
  }
  return { method: 'resume.report', params: { argv: positionals, idempotencyKey } }
}

/** One shell word per argument, so the confirmation shows each argument's own boundaries. */
function shellWord(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`
}
