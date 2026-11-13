// MODULE: foreground-process.ts - which process holds the foreground of a session's terminal, as Linux reports it, and the folder that process is in
import { readFileSync, readlinkSync, statSync } from 'node:fs'

function processStat(pid: number) {
  const text = readFileSync(`/proc/${pid}/stat`, 'utf8')
  // comm can contain spaces and parentheses. The fields following its final ')' are fixed.
  const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/)
  const group = Number(fields[2]), tty = Number(fields[4]), foreground = Number(fields[5])
  const start = fields[19]
  if (!Number.isSafeInteger(group) || group <= 0 || !Number.isSafeInteger(tty) || tty === 0 ||
    !Number.isSafeInteger(foreground) || foreground <= 0 || !start || !/^\d+$/.test(start) ||
    !fields[0] || ['T', 't', 'Z', 'X'].includes(fields[0])) return null
  const command = text.slice(text.indexOf('(') + 1, text.lastIndexOf(')'))
  return { group, tty, foreground, start, command }
}

/** Host-only Linux identity. Synchronous so the final input fence introduces no async gap. */
export function foregroundProcessIdentity(ptyPid: number): string | null {
  if (process.platform !== 'linux' || !Number.isSafeInteger(ptyPid) || ptyPid <= 0) return null
  try {
    const terminal = processStat(ptyPid)
    if (!terminal) return null
    const pid = terminal.foreground
    const process = processStat(pid)
    if (!process || process.group !== pid || process.foreground !== pid || process.tty !== terminal.tty) return null
    // A delayed hook must not establish fresh producer ownership after its agent returned to a shell.
    if (['sh', 'bash', 'dash', 'zsh', 'fish', 'ksh', 'csh', 'tcsh', 'nu', 'xonsh'].includes(process.command)) return null
    // start time catches PID reuse; executable identity also catches exec() in the same process.
    const executable = statSync(`/proc/${pid}/exe`, { bigint: true })
    const current = processStat(ptyPid)
    const leader = processStat(pid)
    if (!current || !leader || current.start !== terminal.start || current.tty !== terminal.tty ||
      current.foreground !== pid || leader.start !== process.start || leader.group !== pid ||
      leader.foreground !== pid || leader.tty !== terminal.tty) return null
    return `${terminal.tty}:${pid}:${process.start}:${executable.dev}:${executable.ino}`
  } catch { return null }
}

/**
 * The arguments of an agent typed into a shell, as Linux reports them for the process an identity names: what follows
 * the agent's own name (`claude ...`, or `node .../codex.js ...`). Null when that process is gone, is another one by
 * now, or is not that agent.
 */
export function foregroundAgentArguments(identity: string, agent: string): string[] | null {
  const [, pidText, start] = identity.split(':')
  const pid = Number(pidText)
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0 || !start) return null
  try {
    const words = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
    if (words.at(-1) === '') words.pop()
    if (processStat(pid)?.start !== start) return null
    return agentArguments(words, agent)
  } catch { return null }
}

/** The arguments after the agent's own name, which is the first or second word of its command line. */
export function agentArguments(words: readonly string[], agent: string): string[] | null {
  const at = words.slice(0, 2).findIndex(word => (word.split('/').pop() ?? '').replace(/\.js$/u, '') === agent)
  return at < 0 ? null : words.slice(at + 1)
}

/**
 * The folder Linux reports for the process an identity names; null when that process is gone or is
 * another one by now. The link is read first and the process checked after, so a reused process id
 * cannot lend its folder.
 */
export function foregroundProcessFolder(identity: string): string | null {
  const [, pidText, start] = identity.split(':')
  const pid = Number(pidText)
  if (process.platform !== 'linux' || !Number.isSafeInteger(pid) || pid <= 0 || !start) return null
  try {
    const folder = readlinkSync(`/proc/${pid}/cwd`)
    return processStat(pid)?.start === start && folder.startsWith('/') ? folder : null
  } catch { return null }
}
