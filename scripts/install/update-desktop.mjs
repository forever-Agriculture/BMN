// MODULE: update-desktop.mjs - queues a source build that installs only after packaged BMN exits
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { packagedApp } from '../lib/packaged-app.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workerPath = fileURLToPath(import.meta.url)
const { binary, archive } = packagedApp(repoRoot)
const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local/state')
const stateDirectory = join(stateHome, 'bmn', 'source-update')
const statusPath = join(stateDirectory, 'latest.json')
const logPath = join(stateDirectory, 'latest.log')
const desktopEntry = join(
  process.env.XDG_DATA_HOME || join(homedir(), '.local/share'),
  'applications',
  'bmn.desktop'
)
const unit = 'bmn-desktop-update.service'

/** Returns processes whose executable is the packaged BMN binary, without matching command text. */
export function runningExecutablePids(executable, procRoot = '/proc') {
  const expected = resolve(executable)
  let entries
  try {
    entries = readdirSync(procRoot, { withFileTypes: true })
  } catch {
    return []
  }
  const pids = []
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/u.test(entry.name)) continue
    try {
      const target = readlinkSync(join(procRoot, entry.name, 'exe')).replace(/ \(deleted\)$/u, '')
      if (resolve(target) === expected) pids.push(Number(entry.name))
    } catch {
      // Processes may exit or deny inspection between the directory read and readlink.
    }
  }
  return pids.sort((left, right) => left - right)
}

export function repositoryReadiness({ branch, head, originHead, status }) {
  if (branch !== 'main') return `expected branch main, found ${branch || 'detached HEAD'}`
  if (status.trim()) return 'working tree is not clean'
  if (head !== originHead) return 'local main does not match origin/main; push the commit first'
  return null
}

export function desktopEntryRunsBinary(entry, executable) {
  return entry.split(/\r?\n/u).includes(`Exec="${executable}"`)
}

function capture(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: 'utf8' })
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || result.error?.message || '').trim()
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`)
  }
  return result.stdout.trim()
}

function gitState() {
  return {
    branch: capture('git', ['branch', '--show-current']),
    head: capture('git', ['rev-parse', 'HEAD']),
    originHead: capture('git', ['rev-parse', 'origin/main']),
    status: capture('git', ['status', '--porcelain'])
  }
}

function writeStatus(value) {
  mkdirSync(stateDirectory, { recursive: true })
  const temporary = `${statusPath}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, statusPath)
}

function log(message) {
  mkdirSync(stateDirectory, { recursive: true })
  appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`)
}

function notify(summary, body, urgency = 'normal') {
  if (process.platform !== 'linux') return
  spawnSync('notify-send', ['--urgency', urgency, summary, body], { stdio: 'ignore' })
}

function runStep(label, args) {
  log(`START ${label}: pnpm ${args.join(' ')}`)
  const output = openSync(logPath, 'a')
  const result = spawnSync('pnpm', args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ['ignore', output, output]
  })
  closeSync(output)
  if (result.status !== 0) {
    throw new Error(`${label} failed with ${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}`)
  }
  log(`PASS ${label}`)
}

async function waitForPackagedAppToExit() {
  let announced = false
  for (;;) {
    const pids = runningExecutablePids(binary)
    if (pids.length > 0) {
      if (!announced) {
        log(`WAIT packaged BMN is running (${pids.join(', ')})`)
        announced = true
      }
      await delay(1_000)
      continue
    }
    // A quiet window prevents an immediate desktop relaunch from racing the replacement.
    await delay(3_000)
    if (runningExecutablePids(binary).length === 0) return
    announced = false
  }
}

async function runWorker() {
  mkdirSync(stateDirectory, { recursive: true })
  writeFileSync(logPath, '')
  const queuedState = gitState()
  writeStatus({ phase: 'waiting-for-exit', commit: queuedState.head, updatedAt: new Date().toISOString(), logPath })
  log(`QUEUED commit ${queuedState.head}`)
  await waitForPackagedAppToExit()

  const buildingState = gitState()
  const readiness = repositoryReadiness(buildingState)
  if (readiness) throw new Error(readiness)
  writeStatus({ phase: 'building', commit: buildingState.head, updatedAt: new Date().toISOString(), logPath })

  runStep('package', ['run', 'package'])
  runStep('packaged smoke test', ['run', 'smoke:packaged'])
  runStep('desktop install', ['run', 'install:desktop'])

  const completedState = gitState()
  const completedReadiness = repositoryReadiness(completedState)
  if (completedReadiness) throw new Error(`source changed during the update: ${completedReadiness}`)
  if (completedState.head !== buildingState.head) throw new Error('source commit changed during the update')
  if (!existsSync(binary) || !existsSync(archive)) throw new Error('packaged BMN artifact is missing after install')
  if (!desktopEntryRunsBinary(readFileSync(desktopEntry, 'utf8'), binary)) {
    throw new Error('desktop launcher does not point at the packaged BMN binary')
  }

  const completedAt = new Date().toISOString()
  writeStatus({ phase: 'complete', commit: completedState.head, completedAt, logPath, binary })
  log(`COMPLETE commit ${completedState.head}`)
  notify('BMN updated', `Reopen BMN to run ${completedState.head.slice(0, 7)}.`)
}

function queueWorker() {
  if (process.platform !== 'linux') {
    throw new Error('automatic update-after-exit currently requires Linux systemd; close BMN and run package/install manually')
  }
  const state = gitState()
  const readiness = repositoryReadiness(state)
  if (readiness) throw new Error(readiness)

  const active = spawnSync('systemctl', ['--user', 'is-active', '--quiet', unit])
  if (active.status === 0) {
    console.log(`BMN update is already queued; it will package the latest clean origin/main after BMN exits.\nLog: ${logPath}`)
    return
  }

  mkdirSync(stateDirectory, { recursive: true })
  writeStatus({ phase: 'queued', commit: state.head, updatedAt: new Date().toISOString(), logPath })
  const result = spawnSync('systemd-run', [
    '--user',
    `--unit=${unit.replace(/\.service$/u, '')}`,
    '--collect',
    '--property=Type=exec',
    `--property=WorkingDirectory=${repoRoot}`,
    `--setenv=PATH=${process.env.PATH || ''}`,
    process.execPath,
    workerPath,
    '--worker'
  ], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`could not queue BMN update: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`)
  }
  console.log(`Queued BMN ${state.head.slice(0, 7)} update. Close BMN and wait for the “BMN updated” notification before reopening.\nLog: ${logPath}`)
}

const directlyInvoked = process.argv[1] && resolve(process.argv[1]) === workerPath
if (directlyInvoked) {
  const worker = process.argv.includes('--worker')
  Promise.resolve()
    .then(() => worker ? runWorker() : queueWorker())
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      writeStatus({ phase: 'failed', error: message, updatedAt: new Date().toISOString(), logPath })
      log(`FAILED ${message}`)
      notify('BMN update failed', `See ${logPath}`, 'critical')
      console.error(`BMN update failed: ${message}`)
      process.exitCode = 1
    })
}
