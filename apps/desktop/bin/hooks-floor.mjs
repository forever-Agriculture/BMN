// MODULE: hooks-floor.mjs - Story 102.4: whether the command guard answers, asked as an app outside BMN would ask it
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const OWN_FOLDER = dirname(fileURLToPath(import.meta.url))
/** Starting Electron's runtime as Node takes seconds on a loaded machine; past this the guard would not have answered in time either. */
const PROBE_LIMIT_MS = 30_000
/** The command in the synthetic event. It only names a command: nothing is executed, and the guard reads no file or socket. */
export const PROBE_COMMAND = 'docker system prune -af'

const shortReason = (text) => text.trim().split('\n').pop()?.slice(0, 200) ?? ''

/**
 * Runs an entry BMN recognised, exactly as written, with a synthetic held-command event, in the environment of a session
 * outside BMN: no socket, and no PATH entry that only a BMN session has. The caller never passes a changed entry: an edited
 * entry could run anything.
 */
export function probeCommandGuard(agent, entry, { env = process.env, ownFolder = OWN_FOLDER } = {}) {
  const { BMN_CONTROL_SOCKET: _a, BMN_TOKEN: _b, AITERM_CONTROL_SOCKET: _c, AITERM_TOKEN: _d, ...rest } = env
  const outside = { ...rest, PATH: (env.PATH ?? '').split(':').filter((folder) => folder !== ownFolder).join(':') }
  const input = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: PROBE_COMMAND } })
  const run = spawnSync('/bin/sh', ['-c', entry], { input, env: outside, encoding: 'utf8', timeout: PROBE_LIMIT_MS, maxBuffer: 1024 * 1024 })
  if (run.error?.code === 'ETIMEDOUT') return { state: 'does-not-answer', reason: `no answer in ${PROBE_LIMIT_MS / 1000} s` }
  if (run.error) return { state: 'does-not-answer', reason: run.error.code ?? run.error.message }
  try {
    const answer = JSON.parse(run.stdout)
    if (answer?.hookSpecificOutput?.permissionDecision === (agent === 'claude' ? 'ask' : 'deny')) return { state: 'holds' }
  } catch {
    // Nothing printed, or nothing readable: the words below say why.
  }
  const reason = shortReason(run.stderr)
  if (reason !== '') return { state: 'does-not-answer', reason }
  const reachable = spawnSync('/bin/sh', ['-c', 'PATH="$PATH:$HOME/.local/bin"; command -v bmn'], { env: outside, encoding: 'utf8', timeout: PROBE_LIMIT_MS })
  return { state: 'does-not-answer', reason: reachable.status === 0 ? 'the entry printed nothing' : 'bmn is not on the PATH of a session outside BMN' }
}

/** One line for `hooks check`. */
export function guardWords(standing) {
  if (standing.state === 'holds') return 'command guard holds'
  if (standing.state === 'does-not-answer') return `command guard does not answer: ${standing.reason}`
  if (standing.state === 'changed') return 'command guard: the entry is not one BMN wrote, so BMN did not run it'
  return 'command guard: no entry'
}
