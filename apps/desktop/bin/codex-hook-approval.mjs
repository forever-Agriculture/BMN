// MODULE: codex-hook-approval.mjs - Story 102.4: whether real Codex runs BMN's entries: a changed one runs only once he approves it, and only Codex can say
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

/** Codex answers within a second on an idle machine; past this the report says it could not ask, never that the entries run. */
const ASK_LIMIT_MS = 10_000
/** Codex's `HookTrustStatus`. It runs an enabled entry only in the first two (`codex-rs/hooks/src/engine/discovery.rs`). */
const RUNS = new Set(['trusted', 'managed'])
const KNOWN = new Set([...RUNS, 'untrusted', 'modified'])
const METHOD_NOT_FOUND = -32601

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

/** The name Codex keeps an entry's approval under: the file, the event in snake case, and the entry's two positions. */
export function codexHookKey(path, event, group, handler) {
  return `${path}:${event.replace(/(?<!^)[A-Z]/g, (letter) => `_${letter}`).toLowerCase()}:${group}:${handler}`
}

/**
 * Asks a real `codex app-server` for its list of hooks, read-only. Its input stays open until the answer: at the end of its
 * input it exits without answering (measured on Codex 0.166.0). Resolves `{ state: 'read', hooks, warnings, errors }` or
 * `{ state: 'unread', reason }`, never rejects.
 */
export function askCodexHooks(program, { env = process.env, cwd = homedir(), limitMs = ASK_LIMIT_MS, start = spawn } = {}) {
  return new Promise((resolve) => {
    let child = null
    let timer = null
    let done = false
    let buffer = ''
    const finish = (answer) => {
      if (done) return
      done = true
      clearTimeout(timer)
      child?.stdout?.destroy()
      child?.stdin?.destroy()
      child?.kill('SIGKILL')
      resolve(answer)
    }
    const unread = (reason) => finish({ state: 'unread', reason })
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`)
    const received = (message) => {
      if (!isObject(message)) return unread('an answer BMN cannot read')
      if (message.id === 1) {
        if (!isObject(message.result)) return unread('Codex refused the question')
        send({ method: 'initialized' })
        send({ id: 2, method: 'hooks/list', params: { cwds: [cwd] } })
      } else if (message.id === 2) {
        if (message.error?.code === METHOD_NOT_FOUND) return unread('this Codex cannot list its hooks')
        const entry = Array.isArray(message.result?.data) ? message.result.data[0] : undefined
        if (!isObject(entry) || !Array.isArray(entry.hooks)) return unread('an answer BMN cannot read')
        finish({
          state: 'read', hooks: entry.hooks,
          warnings: Array.isArray(entry.warnings) ? entry.warnings.length : 0,
          errors: Array.isArray(entry.errors) ? entry.errors.length : 0
        })
      }
      return undefined
    }
    try {
      child = start(program, ['app-server'], { env, cwd, stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (error) {
      unread(error.code ?? error.message)
      return
    }
    timer = setTimeout(() => unread(`no answer in ${limitMs / 1000} s`), limitMs)
    child.on('error', (error) => unread(error.code ?? error.message))
    child.on('close', () => unread('Codex ended without answering'))
    child.stdin.on('error', () => unread('Codex ended without answering'))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text) => {
      buffer += text
      let end = buffer.indexOf('\n')
      while (end >= 0 && !done) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        end = buffer.indexOf('\n')
        if (line.trim() === '') continue
        let message
        try {
          message = JSON.parse(line)
        } catch {
          unread('an answer BMN cannot read')
          return
        }
        received(message)
      }
    })
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'bmn-hooks-check', title: null, version: '1' } } })
  })
}

/**
 * Codex's answer, for BMN's own entries `{ event, key, command }` and no others. An entry Codex will not run gives
 * `not-approved`, whatever else is fine; anything BMN cannot read for sure gives `unverified`, never approved.
 */
export function approvalFrom(answer, entries) {
  if (answer.state !== 'read') return { state: 'unverified', reason: answer.reason }
  if (answer.errors > 0) return { state: 'unverified', reason: 'Codex could not load its settings' }
  const listed = new Map(answer.hooks.filter(isObject).map((hook) => [hook.key, hook]))
  const off = []
  for (const { event, key, command } of entries) {
    const hook = listed.get(key)
    // A warning is how Codex reports a hook file it could not parse; its text stays out, as it may quote his file.
    if (hook === undefined) return { state: 'unverified', reason: `Codex does not list BMN's ${event} entry${answer.warnings > 0 ? ', and warns about its hooks' : ''}` }
    if (hook.command !== command) return { state: 'unverified', reason: `Codex lists another command for BMN's ${event} entry` }
    if (typeof hook.enabled !== 'boolean' || !KNOWN.has(hook.trustStatus)) return { state: 'unverified', reason: `Codex said something BMN does not know about its ${event} entry` }
    if (!hook.enabled || !RUNS.has(hook.trustStatus)) off.push(event)
  }
  return off.length === 0 ? { state: 'approved' } : { state: 'not-approved', entries: off.length, events: [...new Set(off)] }
}

/** One line for a report. */
export function approvalWords(approval) {
  if (approval.state === 'approved') return 'Codex says it runs these entries; that does not prove one fired'
  if (approval.state === 'not-approved') return `Codex does not run ${approval.entries} of these entries (${approval.events.join(', ')}) until you approve them: run /hooks in Codex`
  if (approval.state === 'unverified') return `BMN could not ask Codex whether it runs these entries: ${approval.reason}`
  return 'BMN cannot find Codex, so it cannot say whether it runs these entries: check that it is on your PATH'
}

/** What a report may still claim about a feature that needs `event`'s entry to run. */
export function claimWithApproval(line, approval, event) {
  if (typeof line !== 'string' || approval === null) return line
  const name = line.split(':')[0]
  if (approval.state === 'not-approved' && approval.events.includes(event)) return `${name}: off, Codex has not approved its entry`
  if (approval.state === 'unverified') return `${name}: not verified, BMN could not ask Codex whether it runs its entry`
  if (approval.state === 'no-codex') return `${name}: not verified, BMN cannot find Codex`
  return line
}

/** The guard's standing once Codex has said whether it runs the entry: a probe that holds proves only the entry's own text. */
export function guardWithApproval(standing, approval) {
  if (approval === null || standing?.state !== 'holds') return standing
  if (approval.state === 'no-codex') return { state: 'no-codex' }
  if (approval.state === 'unverified') return { state: 'unverified', reason: approval.reason }
  if (approval.state === 'not-approved' && approval.events.includes('PreToolUse')) return { state: 'not-approved' }
  return standing
}

/**
 * Whether a report's reader has something to do. Every state but approved: BMN's entries are in Codex's own file, so "no Codex"
 * is as likely a PATH problem as a removal, and neither says its guard runs.
 */
export const approvalNeedsHim = (approval) => approval !== null && approval !== undefined && approval.state !== 'approved'
