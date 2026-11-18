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
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { UPDATE_UNIT, desktopEntryReturnsBrain, launcherPath, launcherScript, updateStateDirectory } from '../lib/desktop-launcher.mjs'
import { packagedApp } from '../lib/packaged-app.mjs'
import { buildFolders, packageSmokeAndSwap } from '../lib/staged-build.mjs'
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
  log(`START ${label}: pnpm ${args.join(' ')}`)
  const output = openSync(logPath, 'a')
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
  writeFileSync(logPath, '')
  const queuedState = gitState()
  writeStatus({ phase: 'waiting-for-exit', commit: queuedState.head, updatedAt: new Date().toISOString(), logPath })
  log(`QUEUED commit ${queuedState.head}`)
  await waitForPackagedAppToExit()

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

function queueWorker() {
  if (process.platform !== 'linux') {
    throw new Error('automatic update-after-exit currently requires Linux systemd; close BMN and run package/install manually')
  }
  const state = gitState()
  const readiness = repositoryReadiness(state)
  if (readiness) throw new Error(readiness)

  prepareBrainDelivery({commit:state.head})

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
  console.log(`Queued BMN ${state.head.slice(0, 7)} update. Close BMN; opening it from the desktop waits until the update finishes.\nLog: ${logPath}`)
}

const directlyInvoked = process.argv[1] && resolve(process.argv[1]) === workerPath
if (directlyInvoked) {
  const worker = process.argv.includes('--worker')
  Promise.resolve()
    .then(() => worker ? runWorker() : queueWorker())
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      writeStatus({ phase: 'failed', error: message, liveBuild, updatedAt: new Date().toISOString(), logPath })
      log(`FAILED ${message}`)
      notify('BMN update failed', `See ${logPath}`, 'critical')
      console.error(`BMN update failed: ${message}`)
      process.exitCode = 1
    })
}
