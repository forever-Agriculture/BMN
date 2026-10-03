// MODULE: config-write-worker.test.ts - native-write isolation and target binding across the worker queue
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { linkTarget } from './safe-config-write'
import { writeConfigInWorker } from './config-write-worker'
import { writeClaudeFolderAsync } from './agent-history-claude'

const writer = resolve(dirname(fileURLToPath(import.meta.url)), '../../bin/safe-config-write.mjs')
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-config-worker-')); roots.push(root); return root
}

it('keeps the caller responsive while a slow native writer preserves unrelated settings and backup', async () => {
  const root = await fixture(), path = join(root, 'settings.json'), modulePath = join(root, 'delayed.mjs')
  const original = '{"foreign":"KEEP 雪","cleanupPeriodDays":90}\n'
  await writeFile(path, original)
  if (process.platform === 'win32') {
    const source = `$ErrorActionPreference='Stop';$path=[Console]::In.ReadToEnd();$acl=[IO.File]::GetAccessControl($path);$acl.SetOwner([Security.Principal.WindowsIdentity]::GetCurrent().User);[IO.File]::SetAccessControl($path,$acl)`
    const result = spawnSync(join(process.env.SystemRoot!, 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], { input: path, timeout: 15000, windowsHide: true })
    expect(result.status).toBe(0)
  }
  await writeFile(modulePath, `import { writeConfigSafely as write } from ${JSON.stringify(pathToFileURL(writer).href)};
export function writeConfigSafely(...args) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200); return write(...args); }`)
  let heartbeat = false
  const timer = setTimeout(() => { heartbeat = true }, 10)
  try {
    const result = await writeClaudeFolderAsync(root, 30, modulePath)
    expect(heartbeat).toBe(true)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.failure)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ foreign: 'KEEP 雪', cleanupPeriodDays: 30 })
    expect(await readFile(result.backup!, 'utf8')).toBe(original)
  } finally { clearTimeout(timer) }
}, 15000)

it('refuses an identical-content destination switch before queued worker execution', async () => {
  const root = await fixture(), first = join(root, 'first'), second = join(root, 'second'), path = join(root, 'settings.json')
  await writeFile(first, 'SAME'); await writeFile(second, 'SAME'); await symlink(first, path, 'file')
  const expectedTarget = linkTarget(path)
  await unlink(path); await symlink(second, path, 'file')
  await expect(writeConfigInWorker(writer, { path, text: 'SAME', next: 'OURS', expectedTarget })).rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(await readFile(first, 'utf8')).toBe('SAME')
  expect(await readFile(second, 'utf8')).toBe('SAME')
}, 15000)

it('reports worker startup failure without exposing settings data', async () => {
  const root = await fixture(), path = join(root, 'settings.json')
  await expect(writeConfigInWorker(join(root, 'absent.mjs'), { path, text: null, next: 'PRIVATE_SYNTHETIC', expectedTarget: path }))
    .rejects.toMatchObject({ code: 'IO_ERROR', message: 'Config write could not be confirmed' })
}, 15000)

it('preserves postpublication recovery status without transferring raw diagnostics', async () => {
  const root = await fixture(), modulePath = join(root, 'recovery.mjs'), path = join(root, 'settings.json')
  await writeFile(modulePath, `export function writeConfigSafely() { const e=new Error('PRIVATE_SYNTHETIC_DIAGNOSTIC'); e.code='RECOVERY_REQUIRED'; throw e; }`)
  await expect(writeConfigInWorker(modulePath, { path, text: null, next: 'PRIVATE_SYNTHETIC', expectedTarget: path }))
    .rejects.toMatchObject({ code: 'RECOVERY_REQUIRED', message: 'Config write could not be confirmed' })
}, 15000)
