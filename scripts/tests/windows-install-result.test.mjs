import { existsSync, mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { windowsInstallFailureMessage } from '../lib/windows-install-result.mjs'
import { chooseWindowsUninstallData, windowsUninstallDialog } from '../lib/windows-uninstall-choice.mjs'
import { removeWindowsDataAfterConfirmation } from '../lib/windows-installed-worker.mjs'

it('reports the actually selected version after postactivation metadata failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-install-result-'))
  try {
    const current = { commit: 'b'.repeat(40), payloadSha256: 'c'.repeat(64), schemaVersion: 23 }
    writeFileSync(join(root, 'installation.json'), JSON.stringify({ format: 1, current, previous: { ...current, commit: 'a'.repeat(40) }, snapshot: null }))
    const message = windowsInstallFailureMessage(root)
    expect(message).toContain(`Selected BMN version: ${current.commit}`)
    expect(message).not.toContain('previous selection'); expect(message).toContain('rerun the installer')
    rmSync(join(root, 'installation.json')); expect(windowsInstallFailureMessage(root)).toContain('No BMN release')
    writeFileSync(join(root, 'installation.json'), '{}'); expect(windowsInstallFailureMessage(root)).toContain('could not be verified')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
it('offers retention by default and accepts only an explicit retain/delete/cancel decision', () => {
  const dataRoot = join(tmpdir(), 'synthetic data ^&'), calls = []
  const show = (script, environment) => { calls.push({ script, environment }); return 'retain' }
  expect(chooseWindowsUninstallData({ dataRoot, show })).toBe('retain')
  expect(calls[0].environment).toEqual({ BMN_REMOVE_DATA: '0', BMN_UNINSTALL_DATA: dataRoot })
  expect(calls[0].script).toContain('CheckBox')
  expect(windowsUninstallDialog).toContain('ALL contents'); expect(windowsUninstallDialog).toContain('files you placed there')
  expect(chooseWindowsUninstallData({ dataRoot, show: () => 'remove-all' })).toBe('remove-all')
  expect(chooseWindowsUninstallData({ dataRoot, show: () => 'cancel' })).toBe('cancel')
  expect(() => chooseWindowsUninstallData({ dataRoot, show: () => '' })).toThrow('not confirmed')
})
it('preserves unknown files for retention and deletes them only under explicit all-folder consent', () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-uninstall-consent-')), dataRoot = join(root, 'data')
  mkdirSync(dataRoot)
  const sentinel = join(dataRoot, 'user-created.txt'), outside = join(root, 'project.txt'), lock = join(dataRoot, 'update.lock')
  for (const path of [sentinel, outside, lock]) writeFileSync(path, 'synthetic preserved')
  try {
    expect(() => removeWindowsDataAfterConfirmation(dataRoot, true)).toThrow('explicit uninstall decision')
    removeWindowsDataAfterConfirmation(dataRoot, 'retain')
    expect(existsSync(sentinel)).toBe(true)
    removeWindowsDataAfterConfirmation(dataRoot, 'remove-all')
    expect(existsSync(sentinel)).toBe(false); expect(existsSync(outside)).toBe(true); expect(existsSync(lock)).toBe(true)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
