// MODULE: qa-bench-status.test.mjs - complete nonzero and signalled traces remain usable evidence
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentFile, evidence, traceCompleted } from '../qa/bench-state.mjs'

function capture({ text = '11 +++ exited with 0 +++\n', exitCode = 0, signal = null, rawWaitStatus = 0, actorPid = 11 }, check) {
  const runId = `${Date.now()}-${randomBytes(8).toString('hex')}`, run = join(evidence, runId), key = runId.slice(-16)
  mkdirSync(join(run, 'recovery-root'), { recursive: true })
  const identity = path => { const s = statSync(path); return { device: s.dev, inode: s.ino } }
  const save = (name, value) => writeFileSync(join(run, name), JSON.stringify(value))
  const entry = { key, role: 'workload', file: 'isolation.strace', actorFile: 'launcher.json', recorderFile: `recorder-${key}.json`, certificateFile: `certificate-${key}.json`,
    group: { path: join(run, 'removed'), launchKey: key, device: 30, inode: 31 }, lease: { path: join(run, `launch-${key}.lease`) } }
  const recorder = { pid: 21, start_ticks: '100' }, tracer = { pid: 22, start_ticks: '101' }
  try {
    writeFileSync(entry.lease.path, 'released'); Object.assign(entry.lease, identity(entry.lease.path))
    save('config.json', { runId, run, currentFile, recoveryRoot: join(run, 'recovery-root') })
    save(`launch-${key}.json`, entry); save(`group-removal-${key}.json`, { runId })
    save(entry.recorderFile, { runId, launchKey: key, role: 'workload', recorderIdentity: recorder, tracerIdentity: tracer })
    save('launcher.json', { pid: actorPid, start_ticks: '102', runId, key, tracer })
    writeFileSync(join(run, entry.file), text)
    save(entry.certificateFile, { version: 1, runId, launchKey: key, role: 'workload', recorderIdentity: recorder, tracerIdentity: tracer,
      launchGroupIdentity: { device: 30, inode: 31 }, traceErrors: [], traceFileIdentity: identity(join(run, entry.file)),
      traceBytes: Buffer.byteLength(text), traceSha256: createHash('sha256').update(text).digest('hex'), rawWaitStatus, exitCode, signal })
    return check(() => traceCompleted(runId, entry))
  } finally { rmSync(run, { recursive: true, force: true }) }
}

describe('complete trace termination', () => {
  it('accepts normal completion', () => capture({}, done => expect(done()).toBe(true)))
  it('accepts a captured nonzero exit', () => capture({ text: '11 +++ exited with 7 +++\n', exitCode: 7, rawWaitStatus: 7 * 256 }, done => expect(done()).toBe(true)))
  it('accepts a captured SIGKILL', () => capture({ text: '11 +++ killed by SIGKILL +++\n', exitCode: null, signal: 9, rawWaitStatus: 9 }, done => expect(done()).toBe(true)))
  it('accepts a captured core signal', () => capture({ text: '11 +++ killed by SIGSEGV (core dumped) +++\n', exitCode: null, signal: 11, rawWaitStatus: 139 }, done => expect(done()).toBe(true)))
  it('rejects a status inconsistent with the trace', () => capture({ text: '11 +++ exited with 7 +++\n' }, done => expect(done()).toBe(false)))
  it('rejects an unobserved child completion', () => capture({ text: '11 clone(flags=SIGCHLD) = 12\n11 +++ exited with 0 +++\n' }, done => expect(done()).toBe(false)))
  it('rejects a substituted actor', () => capture({ actorPid: 99 }, done => expect(done()).toBe(false)))
  it.each([
    ['normal', 'pass', 0, null], ['nonzero', 'raise SystemExit(7)', 7, null],
    ['signal', 'import os,signal;os.kill(os.getpid(),signal.SIGKILL)', null, 'SIGKILL'],
    ['child outlives root', 'import os,time;child=os.fork();time.sleep(.03 if child==0 else 0);os._exit(0 if child==0 else 7)', 7, null]
  ])('reads actual strace termination: %s', (_name, code, exitCode, signal) => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-qa-status-')), file = join(root, 'trace')
    try {
      const process = spawnSync('/usr/bin/strace', ['-f', '-q', '-o', file, '/usr/bin/python3', '-I', '-S', '-c', code], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/bin:/bin' } })
      expect(process.error).toBeUndefined(); expect(process.status).toBe(exitCode); expect(process.signal).toBe(signal)
      const text = readFileSync(file, 'utf8'), actorPid = Number(/^(\d+)\s/u.exec(text)?.[1])
      const options = { text, actorPid, exitCode, signal: signal ? 9 : null, rawWaitStatus: signal ? 9 : exitCode * 256 }
      capture(options, done => expect(done()).toBe(true))
      capture({ ...options, text: text.replace(new RegExp(`^${actorPid} +\\+\\+\\+ .*\\+\\+\\+\\n`, 'mu'), '') }, done => expect(done()).toBe(false))
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
