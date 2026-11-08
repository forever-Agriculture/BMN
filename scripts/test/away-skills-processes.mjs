// MODULE: away-skills-processes.mjs - 113.3: an owned process tree by /proc identity, and its proven stop
import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

const statOf = (pid, proc = '/proc') => {
  try {
    const value = readFileSync(`${proc}/${pid}/stat`, 'utf8')
    const fields = value.slice(value.lastIndexOf(')') + 1).trim().split(/\s+/u)
    return { pid, ppid: Number(fields[1]), start_ticks: fields[19], comm: value.slice(value.indexOf('(') + 1, value.lastIndexOf(')')) }
  } catch { return null }
}

/** The process and every descendant now alive, each with its start ticks. */
export function processTree(root, proc = '/proc') {
  const all = readdirSync(proc).filter(name => /^\d+$/u.test(name)).map(name => statOf(Number(name), proc)).filter(Boolean)
  const children = new Map()
  for (const stat of all) children.set(stat.ppid, [...(children.get(stat.ppid) ?? []), stat])
  const top = all.find(stat => stat.pid === root)
  if (!top) return []
  const found = [top], queue = [root]
  while (queue.length) for (const child of children.get(queue.shift()) ?? []) { found.push(child); queue.push(child.pid) }
  return found
}

/** Whether this exact process (same pid and start ticks) still exists. */
export const alive = (identity, proc = '/proc') => statOf(identity.pid, proc)?.start_ticks === identity.start_ticks

/** SIGKILL through a pidfd after rechecking the start ticks, never by a reusable numeric pid alone. */
export function killExact(identity) {
  execFileSync('python3', ['-c', 'import os,sys,signal\nfrom pathlib import Path\np=int(sys.argv[1])\ntry: fd=os.pidfd_open(p)\nexcept ProcessLookupError: sys.exit(0)\ntry:\n  s=Path(f"/proc/{p}/stat").read_text().rsplit(")",1)[1].split()[19]\n  if s==sys.argv[2]: signal.pidfd_send_signal(fd,signal.SIGKILL)\nexcept FileNotFoundError: pass\nfinally: os.close(fd)', String(identity.pid), identity.start_ticks])
}

/**
 * Wait until every recorded identity is gone; kill survivors exactly once after `graceMs`, then wait `afterKillMs`.
 * Returns the identities still alive at the end: an empty list is the only proof of a complete stop.
 */
export async function stopTree(identities, { graceMs, afterKillMs, wait, proc = '/proc', kill = killExact }) {
  const poll = async ms => { for (let spent = 0; spent < ms && identities.some(id => alive(id, proc)); spent += 100) await wait(100) }
  await poll(graceMs)
  const survivors = identities.filter(id => alive(id, proc))
  for (const id of survivors) kill(id)
  if (survivors.length) await poll(afterKillMs)
  return { killed: survivors.map(id => id.pid), remaining: identities.filter(id => alive(id, proc)) }
}
