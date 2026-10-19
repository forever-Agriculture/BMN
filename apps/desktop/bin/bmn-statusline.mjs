// MODULE: bmn-statusline.mjs - the bmn command line behind bin/bmn: `bmn statusline` check, install and uninstall, and its background report
import { readFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { ConfigWriteError, absoluteUncollapsed, currentText, jsonIndent, rewrittenNumbers, writeConfigSafely } from './safe-config-write.mjs'
import { isObject } from './shared-helpers.mjs'
import { UsageError, callEach, parseArguments } from './bmn-commands.mjs'
import { usageFailure } from './bmn-results.mjs'
import { holdAtTestGate } from './bmn-hooks.mjs'

export { reportStatusLine, statusLineCommand }

/**
 * Story 37.2: Claude Code gives its status-line command the plan's rate limits on standard input. BMN wraps the
 * owner's own command instead of replacing it: one line goes in front of it, and the command follows unchanged.
 * Inside a BMN session that line keeps the input in an unlinked temporary file opened twice, hands one copy to
 * `bmn statusline report` in the background and the other to the owner's command as its standard input; anywhere
 * else it does nothing. Claude runs the whole text as `/bin/sh -c <command>` (measured on 2.1.283,
 * docs/usage-sources.md), so the owner's command still runs in the shell it was written for, prints what it
 * printed and exits with its code, and the report never waits in the redraw.
 */
const STATUS_LINE_WRAPPER = 'if [ -n "${BMN_CONTROL_SOCKET:-}" ] && command -v bmn >/dev/null 2>&1 && ' +
  'bmn_statusline=$(mktemp 2>/dev/null); then ' +
  'if cat > "$bmn_statusline" 2>/dev/null && exec 3<"$bmn_statusline" 4<"$bmn_statusline"; then rm -f "$bmn_statusline"; ' +
  'bmn statusline report 0<&3 3<&- 4<&- >/dev/null 2>&1 & exec 0<&4 3<&- 4<&-; ' +
  // A copy that failed part-way (a full disk) fails quietly and gives the owner's command the bytes it holds;
  // the rest of the input is lost with it.
  'else exec 0<"$bmn_statusline"; rm -f "$bmn_statusline"; fi; fi\n'
/** Claude's two plan windows and their lengths in minutes, the unit Codex also reports. */
const STATUS_LINE_WINDOWS = { five_hour: 300, seven_day: 10_080 }
const STATUS_LINE_USAGE = `Usage: bmn statusline check [--file PATH] [--json]
       bmn statusline install [--file PATH] [--json]
       bmn statusline uninstall [--file PATH] [--json]

The file is Claude Code's settings.json ($CLAUDE_CONFIG_DIR, else ~/.claude). install puts one line in
front of the statusLine command already there, after copying the file to <file>.bmn-backup-<timestamp>;
the command itself is unchanged and prints what it printed. uninstall removes that line again. A file
without a statusLine command is left alone. Inside a BMN session the line sends BMN only the 5-hour and
weekly plan use and the context use; elsewhere it does nothing.`

/** The owner's command inside a command BMN wrapped, or null when it is not wrapped. */
function unwrappedStatusLine(command) {
  return typeof command === 'string' && command.startsWith(STATUS_LINE_WRAPPER)
    ? command.slice(STATUS_LINE_WRAPPER.length) : null
}

function statusLineFilePath() {
  return `${absoluteUncollapsed(process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`)}/settings.json`
}

/** What the settings file says about the status line: absent, not a command, the owner's own, or wrapped. */
function readStatusLine(path) {
  let text
  try {
    text = currentText(path)
  } catch (error) {
    return { state: 'unreadable', detail: error.code ?? 'read failed' }
  }
  if (text === null) return { state: 'none', text: null, data: {} }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    return { state: 'unparsable', detail: error.message }
  }
  if (!isObject(data)) return { state: 'unparsable', detail: 'the file is not a JSON object' }
  const statusLine = data.statusLine
  if (statusLine === undefined) return { state: 'none', text, data }
  if (!isObject(statusLine) || statusLine.type !== 'command' || typeof statusLine.command !== 'string') {
    return { state: 'not-a-command', text, data }
  }
  const original = unwrappedStatusLine(statusLine.command)
  if (original !== null) return { state: 'wrapped', text, data, original }
  // A line another bmn wrote, or one edited by hand: wrapping it again would report twice.
  if (statusLine.command.includes('bmn statusline report')) return { state: 'other-wrapper', text, data }
  return { state: 'unwrapped', text, data, original: statusLine.command }
}

const STATUS_LINE_WORDS = {
  unreadable: 'cannot be read',
  unparsable: 'is not valid JSON',
  none: 'has no statusLine command, so there is nothing to wrap',
  'not-a-command': 'has a statusLine that is not a command, so there is nothing to wrap',
  unwrapped: 'has its own statusLine command, not wrapped by BMN',
  wrapped: 'has its statusLine command wrapped by BMN',
  'other-wrapper': 'has a statusLine command that already runs bmn statusline report in a form this bmn did not write; '
    + 'edit it by hand'
}

function statusLineCommand(argv) {
  let parsed
  try {
    parsed = parseArguments(argv)
    for (const name of Object.keys(parsed.options)) {
      if (!['json', 'file', 'help'].includes(name)) throw new UsageError(`statusline does not accept --${name}`)
    }
  } catch (error) {
    if (error instanceof UsageError) return usageFailure(error.message)
    throw error
  }
  const [action, ...rest] = parsed.positionals
  if (parsed.options.help || action === undefined) {
    process.stdout.write(`${STATUS_LINE_USAGE}\n`)
    return parsed.options.help ? 0 : 2
  }
  if (!['check', 'install', 'uninstall'].includes(action) || rest.length > 0) {
    return usageFailure('statusline expects check, install or uninstall')
  }
  const path = parsed.options.file === undefined ? statusLineFilePath() : absoluteUncollapsed(parsed.options.file)
  const asJson = parsed.options.json === true
  const read = readStatusLine(path)
  const say = (result, words) => {
    writeSync(1, `${asJson ? JSON.stringify(result, null, 2) : words}\n`)
  }
  if (action === 'check') {
    say({ file: path, state: read.state }, `${path} ${STATUS_LINE_WORDS[read.state]}.`)
    return read.state === 'wrapped' ? 0 : 1
  }
  const wanted = action === 'install' ? 'unwrapped' : 'wrapped'
  const done = action === 'install' ? 'wrapped' : 'unwrapped'
  if (read.state === done) {
    say({ file: path, state: read.state, changed: false, backup: null }, `Nothing to do: ${path} ${STATUS_LINE_WORDS[read.state]}.`)
    return 0
  }
  if (read.state !== wanted) {
    process.stderr.write(`bmn: ${path} ${STATUS_LINE_WORDS[read.state]}; it was left untouched\n`)
    return 1
  }
  if (rewrittenNumbers(read.text).length > 0) {
    process.stderr.write(`bmn: ${path} holds a number BMN cannot write back unchanged; it was left untouched\n`)
    return 1
  }
  const command = action === 'install' ? `${STATUS_LINE_WRAPPER}${read.original}` : read.original
  const next = `${JSON.stringify({ ...read.data, statusLine: { ...read.data.statusLine, command } }, null, jsonIndent(read.text))}\n`
  let backup
  try {
    ;({ backup } = writeConfigSafely(path, read.text, next, { beforeCommit: holdAtTestGate }))
  } catch (error) {
    process.stderr.write(`bmn: ${error instanceof ConfigWriteError ? error.message : `cannot write ${path} (${error.code ?? error.message})`}\n`)
    return 1
  }
  const state = action === 'install' ? 'wrapped' : 'unwrapped'
  say({ file: path, state, changed: true, backup },
    `${action === 'install' ? 'Wrapped the statusLine command in' : 'Restored the original statusLine command in'} ${path}\nBackup: ${backup}`)
  return 0
}

/** The plan windows and context use in Claude's status-line input, or null when it carries neither. */
function statusLineReading(bytes) {
  let data
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    return null
  }
  if (!isObject(data)) return null
  const limits = isObject(data.rate_limits) ? data.rate_limits : {}
  const windows = []
  for (const [window, minutes] of Object.entries(STATUS_LINE_WINDOWS)) {
    const reading = limits[window]
    if (!isObject(reading)) continue
    const used = reading.used_percentage
    const resets = reading.resets_at
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 1000) continue
    // Claude gives the reset as whole seconds since the epoch.
    if (!Number.isInteger(resets) || resets <= 0 || resets > 1e11) continue
    windows.push({ minutes, usedPercent: used, resetsAt: new Date(resets * 1000).toISOString() })
  }
  const context = isObject(data.context_window) ? data.context_window.used_percentage : undefined
  const contextUsedPercent = typeof context === 'number' && Number.isFinite(context) && context >= 0 && context <= 1000
    ? context : undefined
  if (windows.length === 0 && contextUsedPercent === undefined) return null
  return { agent: 'claude', windows, ...(contextUsedPercent === undefined ? {} : { contextUsedPercent }) }
}

/** The background half of the wrapper: one bounded report of what Claude's status-line input says. */
async function reportStatusLine() {
  const socketPath = process.env.BMN_CONTROL_SOCKET
  const token = process.env.BMN_TOKEN
  if (!socketPath || !token || process.stdin.isTTY) return 0
  let reading
  try {
    reading = statusLineReading(readFileSync(0))
  } catch {
    return 0
  }
  if (reading === null) return 0
  await callEach(socketPath, token, [{ method: 'usage.report', params: reading }], 3000).catch(() => undefined)
  return 0
}
