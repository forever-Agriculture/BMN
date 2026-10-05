// Bundled on Electron's Node runtime; no source checkout or external Node needed.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync } from 'node:fs'
import { physicalPayloadFs } from './physical-payload-fs.mjs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { randomUUID } from 'node:crypto'
import { ensurePrivateDirectories, provisionPrivateDirectories } from '../../apps/desktop/src/utility/private-directory.ts'
import { windowsEnvironmentValue } from '../../apps/desktop/bin/windows-env.mjs'
import { activateWindowsRelease, readWindowsInstallation, releaseDirectory } from './windows-release-transaction.mjs'
import { loadWindowsInstallLease, withWindowsInstallLease, withWindowsReleaseLeases } from './windows-install-lease.mjs'
import { inspectWindowsReleaseData } from './windows-release-data.mjs'
import { validateWindowsReleasePayload, readInstallerDescriptor } from './windows-release-payload.mjs'
import { quarantineWindowsSourceUpdate } from './windows-source-update.mjs'
import { chooseWindowsUninstallData } from './windows-uninstall-choice.mjs'
import { missingSelfTestPhases, packagedReceiptComplete } from './self-test-receipt.mjs'
import { windowsUpdateFailure } from './windows-update-progress.mjs'

const { copyFileSync, cpSync, rmSync } = physicalPayloadFs

function systemPowerShell(environment = process.env) {
  const system = windowsEnvironmentValue(environment, 'SystemRoot')
  assert.ok(system, 'Windows system directory is unavailable')
  return join(system, 'System32/WindowsPowerShell/v1.0/powershell.exe')
}
function powershell(script, environment = process.env) {
  // Utility commands must not depend on auto-discovery in an isolated profile.
  script = "$ErrorActionPreference='Stop';Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/Microsoft.PowerShell.Utility/Microsoft.PowerShell.Utility.psd1'));Import-Module ([System.IO.Path]::Combine($PSHOME,'Modules/CimCmdlets/CimCmdlets.psd1'));\n" + script
  const result = spawnSync(systemPowerShell(environment), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { env: environment, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.ok(!result.error && result.status === 0, 'Windows installation operation failed')
  return result.stdout.trim()
}

/** No reusable-PID killing: observe all BMN hosts and utilities except this worker. */
export function observeWindowsApps() { return JSON.parse(powershell(
  "$ErrorActionPreference='Stop'; $ids=@(Get-CimInstance Win32_Process -Filter \"Name='BMN.exe'\" | Select-Object -ExpandProperty ProcessId); ConvertTo-Json -InputObject $ids -Compress")) }

export function observeWindowsSelectedApps(root) {
  const installation = readWindowsInstallation(root)
  if (!installation) return []
  const selected = win32.resolve(releaseDirectory(root, installation.current), 'BMN.exe').toLowerCase()
  const rows = JSON.parse(powershell("$ErrorActionPreference='Stop'; $rows=@(Get-CimInstance Win32_Process -Filter \"Name='BMN.exe'\" | Select-Object ProcessId,ExecutablePath); ConvertTo-Json -InputObject $rows -Compress"))
  assert.ok(Array.isArray(rows) && rows.every(row => Number.isSafeInteger(row.ProcessId)), 'GUI observation is incomplete')
  return rows.filter(row => typeof row.ExecutablePath === 'string' && win32.resolve(row.ExecutablePath).toLowerCase() === selected)
    .map(row => row.ProcessId)
}

export async function waitForWindowsAppsToExit({ ownPid = process.pid, observe = observeWindowsApps, wait = delay } = {}) {
  for (;;) {
    const pids = observe()
    assert.ok(Array.isArray(pids) && pids.every(Number.isSafeInteger), 'Windows process observation is incomplete')
    if (pids.every(pid => pid === ownPid)) {
      await wait(1000)
      const quiet = observe()
      assert.ok(Array.isArray(quiet) && quiet.every(Number.isSafeInteger), 'Windows process observation is incomplete')
      if (quiet.every(pid => pid === ownPid)) return
    } else await wait(1000)
  }
}

export const windowsInstallerSmokeFolders = ['home', 'local', 'roaming', 'config', 'data', 'state', 'runtime', 'cache', 'claude', 'codex', 'opencode']

export function windowsInstallerSmokeEnvironment(root, inherited = process.env) {
  const environment = {}
  for (const name of ['SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP']) {
    const value = windowsEnvironmentValue(inherited, name)
    if (value !== undefined) environment[name] = value
  }
  environment.Path = [join(environment.SystemRoot, 'System32'), environment.SystemRoot].join(';')
  ensurePrivateDirectories(windowsInstallerSmokeFolders.map(name => join(root, name)))
  // Windows refuses an application root equal to the user's local application data
  // (private-directory.ts), so the profile's shell folders stay apart from every BMN root.
  return { ...environment, HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    APPDATA: join(root, 'roaming'), LOCALAPPDATA: join(root, 'local'),
    BMN_CONFIG_HOME: join(root, 'config'), BMN_DATA_HOME: join(root, 'data'),
    BMN_STATE_HOME: join(root, 'state'), BMN_RUNTIME_HOME: join(root, 'runtime'),
    XDG_CONFIG_HOME: join(root, 'config'), XDG_DATA_HOME: join(root, 'data'), XDG_STATE_HOME: join(root, 'state'),
    XDG_RUNTIME_DIR: join(root, 'runtime'), XDG_CACHE_HOME: join(root, 'cache'),
    CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex'), OPENCODE_CONFIG_DIR: join(root, 'opencode') }
}
export async function smokeWindowsInstalledPayload(root) {
  const temporary = mkdtempSync(join(tmpdir(), 'bmn-install-smoke-'))
  // Existing Windows roots must already have protected ACLs. Provision a missing
  // child privately; never adopt the ordinary mkdtemp directory by changing ACLs.
  const profile = join(temporary, 'profile')
  try {
    ensurePrivateDirectories([profile])
    const started = Date.now()
    const result = spawnSync(join(root, 'BMN.exe'), ['--self-test'], {
      env: windowsInstallerSmokeEnvironment(profile), encoding: 'utf8', timeout: 300000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 })
    const receipts = String(result.stdout ?? '').split(/\r?\n/u).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
    if (result.error || result.status !== 0) {
      // The synthetic self-test's own failure line and exit status stay on the
      // error for diagnosis; the update log records only its category and exit.
      throw Object.assign(windowsUpdateFailure('Installed candidate failed isolated smoke', 'validation', result.status ?? undefined), { smokeOutcome: {
        status: result.status, signal: result.signal, errorCode: result.error?.code, durationMs: Date.now() - started,
        receipts: receipts.map(row => row?.selfTest).filter(name => typeof name === 'string'),
        failure: /\[BMN\] session self-test failed: ([^\r\n]*)/u.exec(String(result.stderr ?? ''))?.[1],
        // The self-test names each phase on stderr; the last one locates a hang.
        stdoutBytes: Buffer.byteLength(String(result.stdout ?? '')), stderrBytes: Buffer.byteLength(String(result.stderr ?? '')),
        phases: [...String(result.stderr ?? '').matchAll(/\[BMN\] self-test phase: ([^\r\n]*)/gu)].map(match => match[1]) } })
    }
    const receipt = receipts.find(row => row.selfTest === 'session-roundtrip')
    // The installed build is accepted on the same receipt as a packaged one: every phase and its packaged facts.
    assert.ok(receipt && missingSelfTestPhases(receipt).length === 0 && packagedReceiptComplete(receipt, 'win32'), 'Installed smoke receipt is incomplete')
    return receipt
  } finally { rmSync(temporary, { recursive: true, force: true }) }
}

export function refreshWindowsInstalledMetadata(root, release, payload = join(root, 'bootstrap')) {
  const local = windowsEnvironmentValue(process.env, 'LOCALAPPDATA'), roaming = windowsEnvironmentValue(process.env, 'APPDATA')
  assert.ok(local && roaming, 'Current-user shell locations are unavailable')
  const launcher = join(root, 'BMN-launcher.exe')
  assert.ok(existsSync(launcher), 'Stable installed launcher is missing')
  // Paths are data in environment variables, never embedded in executable script.
  const environment = { ...process.env, BMN_INSTALL_ROOT: root, BMN_INSTALL_LAUNCHER: launcher,
    BMN_INSTALL_SHORTCUT: join(roaming, 'Microsoft/Windows/Start Menu/Programs/BMN.lnk'), BMN_INSTALL_COMMIT: release.commit }
  mkdirSync(join(roaming, 'Microsoft/Windows/Start Menu/Programs'), { recursive: true })
  const shortcut = spawnSync(join(payload, 'resources/install/BMN-shortcut.exe'),
    [launcher, root, environment.BMN_INSTALL_SHORTCUT], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 30000 })
  assert.ok(!shortcut.error && shortcut.status === 0, 'Windows shortcut identity did not verify')
  powershell(`$ErrorActionPreference='Stop';
    $key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BMN'; $null=New-Item -Path $key -Force;
    New-ItemProperty -Path $key -Name DisplayName -Value BMN -Force | Out-Null;
    New-ItemProperty -Path $key -Name DisplayVersion -Value $env:BMN_INSTALL_COMMIT -Force | Out-Null;
    New-ItemProperty -Path $key -Name InstallLocation -Value $env:BMN_INSTALL_ROOT -Force | Out-Null;
    New-ItemProperty -Path $key -Name UninstallString -Value ('"'+$env:BMN_INSTALL_LAUNCHER+'" --uninstall') -Force | Out-Null;
    New-ItemProperty -Path $key -Name NoModify -PropertyType DWord -Value 1 -Force | Out-Null;
    New-ItemProperty -Path $key -Name NoRepair -PropertyType DWord -Value 1 -Force | Out-Null;`, environment)
}

// Transaction phases are reported as update stages for the progress window only.
const installStages = new Map([['validating', 'smoke'], ['checking-data', 'activate'], ['refreshing', 'metadata']])
export async function installWindowsPayload({ source, root, dataRoot, descriptor, smoke = smokeWindowsInstalledPayload, refreshMetadata = refreshWindowsInstalledMetadata, beforeActivate = async () => {}, requireAlreadySelected = false, observe = () => {} }) {
  assert.equal(process.platform, 'win32', 'Native Windows installer required')
  root = resolve(root); dataRoot = resolve(dataRoot); source = resolve(source)
  await validateWindowsReleasePayload(source, descriptor)
  // Create/check only the roots before acquiring their lock files. Recursive
  // security inspection is inside both leases after the full GUI/utility exit
  // observation; a relaunch cannot race that scan or the snapshot.
  provisionPrivateDirectories([root, dataRoot], 'win32', dataRoot)
  const anchor = pathToFileURL(join(source, 'resources/app.asar/package.json'))
  const native = loadWindowsInstallLease(anchor), Database = createRequire(anchor)('better-sqlite3')
  return activateWindowsRelease({ root, candidate: descriptor, beforeActivate, requireAlreadySelected,
    checkpoint: async phase => { if (installStages.has(phase)) observe(installStages.get(phase)) },
    withLease: operation => withWindowsReleaseLeases(root, dataRoot, async () => {
      await waitForWindowsAppsToExit()
      ensurePrivateDirectories([root, dataRoot], 'win32', dataRoot)
      return operation()
    }, { native }),
    waitForExit: waitForWindowsAppsToExit,
    stage: async target => { cpSync(source, target, { recursive: true, errorOnExist: true, force: false }) },
    validate: validateWindowsReleasePayload, smoke,
    inspectData: async release => {
      const snapshots = join(dataRoot, 'recovery')
      ensurePrivateDirectories([snapshots], 'win32')
      const snapshotId = `${release.commit}-${Date.now()}`
      return inspectWindowsReleaseData({ databasePath: join(dataRoot, 'state.sqlite3'), supportedSchemaVersion: release.schemaVersion,
        snapshotPath: join(snapshots, `${snapshotId}.sqlite3`), snapshotId, Database })
    }, refreshMetadata: async (target, release) => {
      const bootstrap = join(root, 'bootstrap')
      if (!existsSync(bootstrap)) {
        const pending = mkdtempSync(join(root, 'bootstrap-'))
        cpSync(source, pending, { recursive: true, errorOnExist: true, force: false })
        await validateWindowsReleasePayload(pending, descriptor)
        renameSync(pending, bootstrap)
      } else await validateWindowsReleasePayload(bootstrap, readInstallerDescriptor(bootstrap))
      const launcherSource = join(bootstrap, 'resources/install/BMN-launcher.exe'), launcher = join(root, 'BMN-launcher.exe')
      if (!existsSync(launcher)) copyFileSync(launcherSource, launcher, 1) // COPYFILE_EXCL
      else assert.deepEqual(readFileSync(launcher), readFileSync(launcherSource), 'Installed launcher is not its retained bootstrap')
      return refreshMetadata(root, release, target)
    } })
}

export async function launchWindowsInstalled(root, argv = [], { engineRoot = join(root, 'bootstrap') } = {}) {
  const native = loadWindowsInstallLease(pathToFileURL(join(engineRoot, 'resources/app.asar/package.json')))
  return withWindowsInstallLease(root, async () => {
    const installation = readWindowsInstallation(root)
  assert.ok(installation, 'No selected BMN release; rerun the installer')
  const target = releaseDirectory(root, installation.current)
  await validateWindowsReleasePayload(target, installation.current)
  const environment = { ...process.env }; delete environment.ELECTRON_RUN_AS_NODE
  // The app obtains its shared startup lease and verifies selection before data.
  // Retain this worker through GUI exit so the native launcher's job remains alive.
    return new Promise((resolveExit, reject) => {
    const child = spawn(join(target, 'BMN.exe'), argv, { env: environment, stdio: 'ignore', windowsHide: false })
    child.once('error', reject); child.once('exit', (code, signal) => signal ? reject(new Error('Installed BMN terminated')) : resolveExit(code))
    })
  }, { native, exclusive: false })
}

export function removeWindowsDataAfterConfirmation(dataRoot, choice) {
  assert.ok(['retain', 'remove-all'].includes(choice), 'Data removal requires an explicit uninstall decision')
  if (choice === 'retain') return
  for (const name of readdirSync(dataRoot)) if (name !== 'update.lock') rmSync(join(dataRoot, name), { recursive: true })
}

/** Keep the offline recovery engine; never delete its mapped executable or lock.
 * Other versions, shortcuts and registration are removed. A mapped versioned
 * engine remains inactive alongside the bootstrap. Reinstall reuses
 * the protected bootstrap. User data removal is an explicit additional action.
 */
export function windowsMappedEnginePayloads(root, executables) {
  assert.ok(Array.isArray(executables) && executables.every(path => typeof path === 'string' && win32.isAbsolute(path)),
    'Mapped worker observation is incomplete')
  const versions = win32.resolve(root, 'versions').toLowerCase(), result = new Set()
  for (const path of executables) {
    const payload = win32.dirname(path)
    if (win32.dirname(payload).toLowerCase() === versions && win32.basename(path).toLowerCase() === 'bmn-worker.exe') {
      assert.match(win32.basename(payload), /^[a-f0-9]{40}-[a-f0-9]{64}$/u, 'Mapped engine identity is invalid')
      result.add(payload)
    }
  }
  return [...result]
}
function observeWindowsMappedEnginePayloads(root) {
  const paths = JSON.parse(powershell("$ErrorActionPreference='Stop'; $paths=@(Get-CimInstance Win32_Process -Filter \"Name='BMN-worker.exe'\" | Select-Object -ExpandProperty ExecutablePath); ConvertTo-Json -InputObject $paths -Compress"))
  return windowsMappedEnginePayloads(root, paths)
}

export function removeWindowsInstalledPayloads(root, engineRoot, mappedEngines = []) {
  const versions = join(root, 'versions')
  const canonical = path => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  const retained = new Set([engineRoot, ...mappedEngines].map(canonical))
  // The running engine's exe/DLLs may be mapped. Retain this inactive payload
  // rather than partially delete it and abort before removing shell metadata.
  for (const name of existsSync(versions) ? readdirSync(versions) : []) {
    const path = join(versions, name)
    if (!retained.has(canonical(path))) rmSync(path, { recursive: true })
  }
  const staging = join(root, 'staging')
  if (existsSync(staging)) rmSync(staging, { recursive: true })
}

export async function uninstallWindowsPayload({ root, dataRoot, removeData = false, engineRoot = join(root, 'bootstrap') }) {
  assert.equal(process.platform, 'win32')
  root = resolve(root); dataRoot = resolve(dataRoot)
  const choice = chooseWindowsUninstallData({ dataRoot, initialRemoveData: removeData,
    show: (script, extra) => powershell(script, { ...process.env, ...extra }) })
  if (choice === 'cancel') return
  provisionPrivateDirectories([root, dataRoot], 'win32', dataRoot)
  const native = loadWindowsInstallLease(pathToFileURL(join(engineRoot, 'resources/app.asar/package.json')))
  const requests = join(root, 'requests')
  ensurePrivateDirectories([requests])
  // Queue, resume and uninstall share this outer lease. No waiting worker can
  // recreate selection after uninstall releases the data/installation leases.
  await withWindowsInstallLease(requests, async () => {
    quarantineWindowsSourceUpdate(join(requests, 'source-update.json'))
    return withWindowsReleaseLeases(root, dataRoot, async () => {
    await waitForWindowsAppsToExit()
    ensurePrivateDirectories([root, dataRoot], 'win32', dataRoot)
    const current = readWindowsInstallation(root)
    if (current) renameSync(join(root, 'installation.json'), join(root, `uninstalled-${randomUUID()}.json`))
    // No selection means both the launcher and direct versions refuse data use.
    removeWindowsInstalledPayloads(root, engineRoot, observeWindowsMappedEnginePayloads(root))
    if (existsSync(join(root, 'update.json'))) renameSync(join(root, 'update.json'), join(root, `uninstalled-update-${randomUUID()}.json`))
    const roaming = windowsEnvironmentValue(process.env, 'APPDATA')
    assert.ok(roaming, 'Current-user shell directory is unavailable')
    powershell(`$ErrorActionPreference='Stop';
      $key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BMN';
      if(Test-Path -LiteralPath $key){Remove-Item -LiteralPath $key};
      if(Test-Path -LiteralPath $env:BMN_INSTALL_SHORTCUT){Remove-Item -LiteralPath $env:BMN_INSTALL_SHORTCUT};`,
    { ...process.env, BMN_INSTALL_SHORTCUT: join(roaming, 'Microsoft/Windows/Start Menu/Programs/BMN.lnk') })
    // The UI names this exact data folder and includes unknown files placed
    // there. Retain the held empty lock to avoid racing another updater.
    removeWindowsDataAfterConfirmation(dataRoot, choice)
    }, { native })
  }, { native })
}
