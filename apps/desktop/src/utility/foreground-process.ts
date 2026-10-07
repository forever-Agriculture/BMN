import { readFileSync, statSync } from 'node:fs'

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
