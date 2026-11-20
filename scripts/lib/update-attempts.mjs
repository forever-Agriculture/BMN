// MODULE: update-attempts.mjs - Story 134.1: every desktop update attempt keeps its own log; latest.log points at the newest
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'

/** How many attempt logs stay; older ones are removed when a new attempt starts. */
export const KEPT_ATTEMPTS = 20

const ATTEMPT_LOG = /^\d{8}T\d{6}\d{3}Z-[0-9a-f]{7,64}(?:-\d+)?\.log$/u

/** The attempt logs in a state folder, oldest first: names start with their UTC start time, so name order is time order. */
export function attemptLogs(stateDirectory) {
  try {
    return readdirSync(join(stateDirectory, 'attempts')).filter((name) => ATTEMPT_LOG.test(name)).sort()
  } catch {
    return []
  }
}

/**
 * Starts one attempt: `attempts/<UTC start>-<commit>.log` beside `latest.json`, its first line naming the commit;
 * `latest.log` becomes a link to it (by rename, so a reader sees the old or the new log, never none); attempts beyond
 * `keep` are removed, oldest first, never one named in `protect` (a passed build still waiting writes its swap into its
 * own log), which counts toward `keep`. Earlier attempts are never written again (2026-11-20: a failed update's log
 * was truncated by the next queued attempt before anyone read it).
 */
export function startAttempt({ stateDirectory, commit, now = new Date(), keep = KEPT_ATTEMPTS, protect = [] }) {
  const folder = join(stateDirectory, 'attempts')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const stamp = now.toISOString().replace(/[-:.]/gu, '')
  let name = `${stamp}-${commit}.log`
  for (let index = 2; attemptLogs(stateDirectory).includes(name); index += 1) name = `${stamp}-${commit}-${index}.log`
  const path = join(folder, name)
  writeFileSync(path, `${now.toISOString()} ATTEMPT commit ${commit}\n`, { flag: 'wx', mode: 0o600 })
  const latest = join(stateDirectory, 'latest.log'), temporary = `${latest}.tmp-${process.pid}`
  rmSync(temporary, { force: true })
  symlinkSync(join('attempts', name), temporary)
  renameSync(temporary, latest)
  const kept = new Set(protect.map((protectedPath) => basename(protectedPath)))
  const logs = attemptLogs(stateDirectory), prunable = logs.filter((old) => !kept.has(old))
  const room = Math.max(0, keep - (logs.length - prunable.length))
  for (const old of prunable.slice(0, Math.max(0, prunable.length - room))) rmSync(join(folder, old), { force: true })
  return {
    path,
    commit,
    log: (message) => appendFileSync(path, `${new Date().toISOString()} ${message}\n`)
  }
}
