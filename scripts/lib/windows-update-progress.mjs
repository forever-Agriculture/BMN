// MODULE: windows-update-progress.mjs - bounded update observations for the Windows desktop start
// The equivalent of the Linux worker's status and START/PASS lines. They describe
// progress and feed Show log; they never select a payload, authorize a launch or
// keep raw command output, arguments or environment.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const WINDOWS_UPDATE_LOG = 'source-update-log.json'
const stages = new Map([
  ['prepare', ['Checking the queued source', 'Getting the update ready…']],
  ['waiting', ['Waiting for BMN to close', 'Getting the update ready…']],
  ['snapshot', ['Preparing the source snapshot', 'Preparing the new build…']],
  ['install', ['Installing build dependencies', 'Preparing the new build…']],
  ['package', ['Packaging the new build', 'Packaging the new build. This can take several minutes.']],
  ['validate', ['Validating the packaged build', 'Checking the new build…']],
  ['smoke', ['Checking the new build in a disposable profile', 'Checking the new build…']],
  ['activate', ['Selecting the new build', 'Finishing the install…']],
  ['metadata', ['Refreshing the Start menu entry', 'Finishing the install…']]
])
const categories = new Map([['command', 'build command failed'], ['source', 'source changed or is not ready'],
  ['validation', 'build checks failed'], ['installation', 'installation step failed'], ['unknown', 'failed']])
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const maxEvents = 64, maxBytes = 64 * 1024

/** Categorized at the throw site; anything else is reported as unknown. */
export function windowsUpdateFailure(message, category, exitCode) {
  assert.ok(categories.has(category))
  return Object.assign(new Error(message), { updateCategory: category, ...(Number.isSafeInteger(exitCode) ? { exitCode } : {}) })
}

function validEvent(event, index) {
  assert.deepEqual(Object.keys(event).sort(), ['at', 'category', 'elapsedMs', 'exitCode', 'sequence', 'stage', 'status'])
  assert.equal(event.sequence, index + 1); assert.ok(stages.has(event.stage)); assert.ok(['START', 'PASS', 'FAIL'].includes(event.status))
  assert.ok(Number.isSafeInteger(Date.parse(event.at))); assert.ok(Number.isSafeInteger(event.elapsedMs) && event.elapsedMs >= 0)
  assert.ok(event.exitCode === null || (Number.isSafeInteger(event.exitCode) && event.exitCode >= 0 && event.exitCode <= 0xffffffff))
  assert.ok(event.status === 'FAIL' ? categories.has(event.category) : event.category === null)
}

/** Validated snapshot for this attempt, or null when absent, foreign or invalid. */
export function readWindowsUpdateLog(requests, attemptId) {
  const path = join(requests, WINDOWS_UPDATE_LOG)
  try {
    if (!existsSync(path)) return null
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) return null
    const value = JSON.parse(readFileSync(path, 'utf8'))
    assert.equal(value.format, 1); assert.match(value.attemptId, uuid)
    if (attemptId !== undefined && value.attemptId !== attemptId) return null
    assert.ok(typeof value.text === 'string' && value.text.length <= 200 && Array.isArray(value.events) && value.events.length <= maxEvents)
    value.events.forEach(validEvent)
    return value
  } catch { return null }
}

export function renderWindowsUpdateLog(snapshot, commit) {
  const rows = [`BMN update ${typeof commit === 'string' ? commit.slice(0, 12) : ''}`.trimEnd()]
  if (!snapshot) return [...rows, 'No update steps were recorded for this attempt.'].join('\r\n')
  for (const event of snapshot.events) {
    const [name] = stages.get(event.stage), seconds = Math.round(event.elapsedMs / 1000)
    const detail = event.status === 'START' ? '' : event.status === 'PASS' ? ` (${seconds} s)`
      : ` (${seconds} s; ${categories.get(event.category)}${event.exitCode === null ? '' : `; exit ${event.exitCode}`})`
    rows.push(`${event.at} ${event.status.padEnd(5)} ${name}${detail}`)
  }
  return rows.join('\r\n')
}

/** Observation failure is recorded in memory; it never fails or reverses the update. */
export class WindowsUpdateObserver {
  #path; #attemptId; #now; #events = []; #active = null; #started = 0; #text = stages.get('waiting')[1]
  unavailable = false
  constructor(requests, attemptId, { now = Date.now } = {}) {
    assert.match(attemptId, uuid)
    this.#path = join(requests, WINDOWS_UPDATE_LOG); this.#attemptId = attemptId; this.#now = now
    this.#write()
  }
  #record(stage, status, category = null, exitCode = null) {
    if (this.#events.length >= maxEvents) { this.unavailable = true; return }
    const now = this.#now()
    this.#events.push({ sequence: this.#events.length + 1, at: new Date(now).toISOString(), stage, status,
      elapsedMs: status === 'START' ? 0 : Math.max(0, now - this.#started), exitCode, category })
    if (status === 'START') this.#started = now
  }
  #write() {
    const temporary = `${this.#path}.${randomUUID()}.tmp`
    let fd
    try {
      fd = openSync(temporary, 'wx', 0o600)
      writeFileSync(fd, JSON.stringify({ format: 1, attemptId: this.#attemptId, text: this.#text, events: this.#events }))
      fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(temporary, this.#path)
    } catch { this.unavailable = true }
    finally {
      if (fd !== undefined) try { closeSync(fd) } catch { /* Reported through unavailable. */ }
      try { if (existsSync(temporary)) unlinkSync(temporary) } catch { /* Reported through unavailable. */ }
    }
  }
  /** Ends the active stage as passed and starts the next one. */
  enter(stage) {
    assert.ok(stages.has(stage))
    if (this.#active === stage) return
    if (this.#active) this.#record(this.#active, 'PASS')
    this.#active = stage; this.#text = stages.get(stage)[1]
    this.#record(stage, 'START'); this.#write()
  }
  finish(text = 'Update complete. Opening BMN…') {
    if (this.#active) this.#record(this.#active, 'PASS')
    this.#active = null; this.#text = text; this.#write()
  }
  fail(error) {
    const category = categories.has(error?.updateCategory) ? error.updateCategory : 'unknown'
    const exitCode = Number.isSafeInteger(error?.exitCode) && error.exitCode >= 0 ? error.exitCode : null
    // A failure before any step is reported against preparation, never dropped.
    if (!this.#active) this.#record('prepare', 'START')
    this.#record(this.#active ?? 'prepare', 'FAIL', category, exitCode)
    this.#active = null; this.#text = 'The update failed.'; this.#write()
  }
}
