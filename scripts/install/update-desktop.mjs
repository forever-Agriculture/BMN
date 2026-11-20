// MODULE: update-desktop.mjs - queues a source build that installs only after packaged BMN exits
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { UPDATE_UNIT, desktopEntryReturnsBrain, launcherPath, launcherScript, updateStateDirectory } from '../lib/desktop-launcher.mjs'
import { packagedApp } from '../lib/packaged-app.mjs'
import { buildFolders, packageSmokeAndSwap } from '../lib/staged-build.mjs'
import { startAttempt } from '../lib/update-attempts.mjs'
import { brainFileHash, brainResourcesHash, brainCutoverStateRoot, brainDeliveryCommit, brainContainsDelivery } from '../lib/brain-provenance.mjs'

import { installBrainCutoverService } from './brain-cutover-service.mjs'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const workerPath = fileURLToPath(import.meta.url)
const { root: liveRoot, binary, archive } = packagedApp(repoRoot)
const folders = buildFolders(liveRoot)
/** Which build the live path holds if this update fails: the launcher words its dialog from it. */
let liveBuild = 'previous'
const stateDirectory = updateStateDirectory()
const statusPath = join(stateDirectory, 'latest.json')
const logPath = join(stateDirectory, 'latest.log')
/** This worker's attempt (Story 134.1): its own log under `attempts/`, which later attempts never rewrite. */
let attempt = null
/** The step the worker is in, so a failure names where it stopped. */
let currentStep = 'start'
const desktopEntry = join(
  process.env.XDG_DATA_HOME || join(homedir(), '.local/share'),
  'applications',
  'bmn.desktop'
)
const launcher = launcherPath()
const unit = UPDATE_UNIT

/**
 * Returns the processes of an open packaged BMN: its executable is the packaged binary, without matching
 * command text. BMN's own helpers (its CLI, team-ask supervisors, QA relays) run that binary as Node with
 * ELECTRON_RUN_AS_NODE and may outlive the window, so they never count as BMN being open; a process whose
 * environment cannot be read counts as open.
 */
export function runningAppPids(executable, procRoot = '/proc') {
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
      if (resolve(target) === expected && !runsAsNode(join(procRoot, entry.name, 'environ'))) pids.push(Number(entry.name))
    } catch {
      // Processes may exit or deny inspection between the directory read and readlink.
    }
  }
  return pids.sort((left, right) => left - right)
}

function runsAsNode(environPath) {
  try {
    return /(?:^|\0)ELECTRON_RUN_AS_NODE=[^\0]/u.test(readFileSync(environPath, 'latin1'))
  } catch {
    return false
  }
}

export function repositoryReadiness({ branch, head, originHead, status }) {
  if (branch !== 'main') return `expected branch main, found ${branch || 'detached HEAD'}`
  if (status.trim()) return 'working tree is not clean'
  if (head !== originHead) return 'local main does not match origin/main; push the commit first'
  return null
}

/** Why the source is no longer what the build started from, or null. */
export function sourceChangeSince(started, now) {
  if (now.head !== started.head) return `HEAD moved from ${started.head} to ${now.head}`
  if (now.touched !== started.touched) return 'a tracked file was written during the build, so the build may hold what it held then'
  return repositoryReadiness(now)
}

/** When and how large each tracked file last was: a file changed for the compiler and put back has the same bytes, not the same time. */
export function trackedFilesStamp(root = repoRoot) {
  const names = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).stdout.split('\0').filter(Boolean)
  const stamp = createHash('sha256')
  for (const name of names) {
    let seen = 'gone'
    try {
      const { mtimeNs, size } = lstatSync(join(root, name), { bigint: true })
      seen = `${mtimeNs}:${size}`
    } catch {
      // A file that went away is part of the stamp as that.
    }
    stamp.update(`${name}\0${seen}\0`)
  }
  return stamp.digest('hex')
}

export function desktopEntryRunsLauncher(entry, launcherFile) {
  return entry.split(/\r?\n/u).includes(`Exec="${launcherFile}"`)
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
    status: capture('git', ['status', '--porcelain']),
    touched: trackedFilesStamp()
  }
}

function writeStatusIn(directory, value) {
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'latest.json'), temporary = `${path}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, path)
}

function writeStatus(value) {
  writeStatusIn(stateDirectory, value)
}

function log(message) {
  if (attempt) attempt.log(message)
  else {
    mkdirSync(stateDirectory, { recursive: true })
    appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`)
  }
}

export function brainUpdateNotice(commit,state=brainCutoverStateRoot()) {
  const opening=`Reopen BMN to run ${commit.slice(0,7)}.\n`
  if(!existsSync(join(state,'brain-cutover','journal.json')))return opening+'The brain is installed; nothing has switched. Use “Switch to the BMN brain…” in the command palette.'
  return opening+'The brain is installed. Open BMN to check the brain’s current state.'
}

function notify(summary, body, urgency = 'normal') {
  if (process.platform !== 'linux') return
  spawnSync('notify-send', ['--urgency', urgency, summary, body], { stdio: 'ignore' })
}

function runStep(label, args) {
  currentStep = label
  log(`START ${label}: pnpm ${args.join(' ')}`)
  const output = openSync(attempt?.path ?? logPath, 'a')
  const result = spawnSync('pnpm', args, {
    cwd: repoRoot,
    // The step builds into staging, never over the live build: `package-preflight.mjs` lets it run while BMN is open.
    env: { ...process.env, BMN_PACKAGE_STAGED: '1' },
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
    const pids = runningAppPids(binary)
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
    if (runningAppPids(binary).length === 0) return
    announced = false
  }
}

/** Called only from the clean canonical main checkout, never from an implementation worktree. */
export function prepareBrainDelivery({project=repoRoot,commit,state=stateDirectory,install=installBrainCutoverService}) {
  const common=spawnSync('/usr/bin/git',['-C',project,'rev-parse','--path-format=absolute','--git-common-dir'],{encoding:'utf8',timeout:10_000})
  if(common.status!==0||resolve(project)!==dirname(common.stdout.trim()))throw new Error('Held brain installation requires the canonical delivery checkout')
  const delivered=brainDeliveryCommit(project,commit),path=join(state,'brain-delivery.json')
  if(existsSync(path)){
    const prior=JSON.parse(readFileSync(path,'utf8'))
    if(prior.version!==1||prior.epic!==126||prior.commit!==delivered)throw new Error('The original brain delivery identity changed; kept unchanged')
  }else{
    mkdirSync(state,{recursive:true,mode:0o700})
    const text=JSON.stringify({version:1,epic:126,commit:delivered})+'\n',temporary=path+'.tmp-'+process.pid
    const fd=openSync(temporary,'wx',0o600)
    try{writeFileSync(fd,text);fsyncSync(fd)}finally{closeSync(fd)}
    renameSync(temporary,path)
    if(readFileSync(path,'utf8')!==text)throw new Error('Brain delivery identity read-back failed')
    const directory=openSync(state,'r');try{fsyncSync(directory)}finally{closeSync(directory)}
  }
  install({sourceRoot:project,resources:packagedApp(project).resources})
  return delivered
}

async function runWorker() {
  mkdirSync(stateDirectory, { recursive: true })
  const queuedState = gitState()
  attempt = startAttempt({ stateDirectory, commit: queuedState.head })
  writeStatus({ phase: 'waiting-for-exit', commit: queuedState.head, updatedAt: new Date().toISOString(), logPath: attempt.path })
  log(`QUEUED commit ${queuedState.head}`)
  currentStep = 'wait for BMN to exit'
  await waitForPackagedAppToExit()
  currentStep = 'source check'

  const buildingState = gitState()
  const readiness = repositoryReadiness(buildingState)
  if (readiness) throw new Error(readiness)
  const brainDelivered=prepareBrainDelivery({commit:buildingState.head})
  writeStatus({ phase: 'building', commit: buildingState.head, updatedAt: new Date().toISOString(), logPath })

  // The live build is not touched until the new one has passed its smoke test in a folder beside it.
  await packageSmokeAndSwap({
    folders,
    step: runStep,
    waitForExit: waitForPackagedAppToExit,
    log,
    onLiveBuild: (state) => { liveBuild = state },
    sourceChange: () => sourceChangeSince(buildingState, gitState())
  })
  runStep('desktop install', ['run', 'install:desktop'])
  currentStep = 'install check'

  const completedState = gitState()
  const completedReadiness = repositoryReadiness(completedState)
  if (completedReadiness) throw new Error(`source changed during the update: ${completedReadiness}`)
  if (completedState.head !== buildingState.head) throw new Error('source commit changed during the update')
  if (!existsSync(binary) || !existsSync(archive)) throw new Error('packaged BMN artifact is missing after install')
  if (!desktopEntryRunsLauncher(readFileSync(desktopEntry, 'utf8'), launcher)) {
    throw new Error('desktop entry does not run the BMN launcher')
  }
  if (!desktopEntryReturnsBrain(readFileSync(desktopEntry, 'utf8'), binary)) {
    throw new Error('desktop entry lacks the recovery launcher for the return to Obsidian')
  }
  if (readFileSync(launcher, 'utf8') !== launcherScript({ binary, statusPath })) {
    throw new Error('BMN launcher does not start the packaged BMN binary')
  }

  if(brainDeliveryCommit(repoRoot,completedState.head)!==brainDelivered||!brainContainsDelivery(repoRoot,brainDelivered,completedState.head))throw new Error('Packaged build no longer contains brain delivery')
  for(const name of ['brain-cutover-service.py','brain-cutover-peer.py']){
    const installed=join(dirname(archive),'bin',name),source=join(repoRoot,'apps/desktop/bin',name)
    if(!lstatSync(installed).isFile()||lstatSync(installed).isSymbolicLink()||brainFileHash(installed)!==brainFileHash(source))throw new Error('Installed brain helper provenance failed')
  }
  // Verify the held unit again after packaging, without starting or enabling it.
  prepareBrainDelivery({commit:completedState.head})
  const completedAt = new Date().toISOString()
  const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex')
  const completed = { phase: 'complete', commit: completedState.head, brainDeliveryCommit:brainDelivered, completedAt, logPath, binary, archive,
    binaryHash: digest(binary), archiveHash: digest(archive), resourcesHash:brainResourcesHash(dirname(archive)),
    preparedHash:existsSync(join(brainCutoverStateRoot(),'brain-cutover-prepared.json'))?brainFileHash(join(brainCutoverStateRoot(),'brain-cutover-prepared.json')):null, brainVersion: 126, liveBuild }
  // latest.json is replaced at queue time. Keep completed provenance independently of later attempts.
  const history = join(stateDirectory, 'completed')
  mkdirSync(history, { recursive: true, mode: 0o700 })
  const record = join(history, completedState.head + '.json'), temporary = record + '.tmp'
  const completedFile=openSync(temporary,'w',0o600)
  try{writeFileSync(completedFile,JSON.stringify(completed)+'\n');fsyncSync(completedFile)}finally{closeSync(completedFile)}
  renameSync(temporary, record)
  for(const path of [history,stateDirectory]){const directory=openSync(path,'r');try{fsyncSync(directory)}finally{closeSync(directory)}}
  if (readFileSync(record, 'utf8') !== JSON.stringify(completed) + '\n') throw new Error('Completed build record read-back failed')
  writeStatus(completed)
  log(`COMPLETE commit ${completedState.head}`)
  notify('BMN updated', brainUpdateNotice(completedState.head))
}

function startUnit() {
  return spawnSync('systemd-run', [
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
}

/**
 * A failed worker attempt: its own log ends with the step it failed at, and `latest.json` names that commit, step and
 * log, which stays readable after later attempts (Story 134.1). Returns the message.
 */
export function recordWorkerFailure({ directory, attempt: failed, step, error, liveBuild: live }) {
  const message = error instanceof Error ? error.message : String(error)
  writeStatusIn(directory, { phase: 'failed', commit: failed?.commit ?? null, failedStep: step, error: message, liveBuild: live, updatedAt: new Date().toISOString(), logPath: failed?.path ?? join(directory, 'latest.log') })
  if (failed) failed.log(`FAILED at ${step}: ${message}`)
  else appendFileSync(join(directory, 'latest.log'), `${new Date().toISOString()} FAILED at ${step}: ${message}\n`)
  return message
}

const unitActive = () => spawnSync('systemctl', ['--user', 'is-active', '--quiet', unit]).status === 0

/**
 * `pnpm run update:desktop` without `--worker`: queues the worker, or refuses. A refusal (wrong platform, dirty tree,
 * unpushed main, brain delivery, a unit that would not start) is printed and leaves `latest.json`, the attempt logs and
 * the completed records exactly as they were (Story 134.1, Epic 111 F6): it writes nothing a launcher reads.
 * The options exist for the tests; the command uses the defaults. Returns the exit code.
 */
export function queueCommand({
  platform = process.platform, state = gitState, prepareBrain = (commit) => prepareBrainDelivery({ commit }),
  queued = unitActive, start = startUnit, directory = stateDirectory, print = console.log, printError = console.error
} = {}) {
  const statusFile = join(directory, 'latest.json')
  try {
    if (platform !== 'linux') {
      throw new Error('automatic update-after-exit currently requires Linux systemd; close BMN and run package/install manually')
    }
    const current = state()
    const readiness = repositoryReadiness(current)
    if (readiness) throw new Error(readiness)
    prepareBrain(current.head)
    if (queued()) {
      print(`BMN update is already queued; it will package the latest clean origin/main after BMN exits.\nLog: ${join(directory, 'latest.log')}`)
      return 0
    }
    const before = existsSync(statusFile) ? readFileSync(statusFile) : null
    writeStatusIn(directory, { phase: 'queued', commit: current.head, updatedAt: new Date().toISOString(), logPath: join(directory, 'latest.log') })
    const result = start()
    if (result.status !== 0) {
      // Nothing was queued: put back what the launcher read before.
      if (before === null) rmSync(statusFile, { force: true })
      else { const temporary = `${statusFile}.tmp-${process.pid}`; writeFileSync(temporary, before, { mode: 0o600 }); renameSync(temporary, statusFile) }
      throw new Error(`could not queue BMN update: ${(result.stderr || result.stdout || result.error?.message || '').trim()}`)
    }
    print(`Queued BMN ${current.head.slice(0, 7)} update. Close BMN; opening it from the desktop waits until the update finishes.\nLog: ${join(directory, 'latest.log')}`)
    return 0
  } catch (error) {
    printError(`BMN update not queued: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

const directlyInvoked = process.argv[1] && resolve(process.argv[1]) === workerPath
if (directlyInvoked && !process.argv.includes('--worker')) process.exitCode = queueCommand()
else if (directlyInvoked) {
  runWorker().catch((error) => {
    const message = recordWorkerFailure({ directory: stateDirectory, attempt, step: currentStep, error, liveBuild })
    notify('BMN update failed', `Failed at ${currentStep}. See ${attempt?.path ?? logPath}`, 'critical')
    console.error(`BMN update failed at ${currentStep}: ${message}`)
    process.exitCode = 1
  })
}
