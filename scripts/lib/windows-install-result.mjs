import { existsSync, readFileSync } from 'node:fs'
import assert from 'node:assert/strict'
import { isAbsolute } from 'node:path'
import { readWindowsInstallation } from './windows-release-transaction.mjs'
import { writeConfigSafely } from '../../apps/desktop/bin/safe-config-write.mjs'

export function windowsInstallFailureMessage(root) {
  let selected
  try { selected = readWindowsInstallation(root)?.current?.commit ?? null }
  catch { selected = undefined }
  const status = selected === undefined ? 'The selected release could not be verified.'
    : selected === null ? 'No BMN release is selected.' : `Selected BMN version: ${selected}.`
  return `Installation is incomplete. ${status} Retained payloads and recovery snapshots were preserved. Close BMN and rerun the installer to finish or repair installation.`
}
export function writeWindowsInstallResult(path, message) {
  assert.ok(isAbsolute(path), 'Installer diagnostic requires an absolute destination')
  writeConfigSafely(path, existsSync(path) ? readFileSync(path, 'utf8') : null, message + '\n')
}
