// MODULE: setup-removal-preservation.test.mjs - No data loss from independent replacement at the final Undo boundary
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it } from 'vitest'

it('preserves an independent replacement after the final observation and refuses Undo', () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-setup-removal-race-'))
  try {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/setup-removal-interference.mjs', import.meta.url)), root],
      { encoding: 'utf8', env: { HOME: root, PATH: '/usr/bin:/bin' }, timeout: 15000 })
    assert.equal(result.status, 0, result.stderr)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.replaced, true, 'the independent writer ran at the product boundary')
    assert.notEqual(receipt.code, 'OK', JSON.stringify(receipt))
    assert(receipt.targetText === 'independent writer replacement' || receipt.holdings.some(row => row.text === 'independent writer replacement'), JSON.stringify(receipt))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

for (const inPlace of [false, true]) for (const occupied of [false, true]) it(`preserves an independent ${inPlace ? 'in-place edit' : 'replacement'} inside the native check gap with original name ${occupied ? 'occupied' : 'absent'}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'bmn-setup-native-race-'))
  try {
    const helper = join(root, 'race-helper')
    const compile = spawnSync('/usr/bin/cc', ['-Wall', '-Wextra', '-Werror', `-DTEST_OCCUPIED=${occupied ? 1 : 0}`, `-DTEST_IN_PLACE=${inPlace ? 1 : 0}`,
      fileURLToPath(new URL('../../apps/desktop/native/defaults-publish.c', import.meta.url)),
      fileURLToPath(new URL('./fixtures/defaults-publication-syscall-race.c', import.meta.url)), '-Wl,--wrap=syscall', '-o', helper], { encoding: 'utf8', timeout: 15000 })
    assert.equal(compile.status, 0, compile.stderr)
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/setup-native-removal-interference.mjs', import.meta.url)), root, helper],
      { encoding: 'utf8', env: { HOME: root, PATH: '/usr/bin:/bin' }, timeout: 15000 })
    assert.equal(run.status, 0, run.stderr)
    const receipt = JSON.parse(run.stdout)
    assert.deepEqual(receipt.nativeReceipts.map(row => ({ code: row.code, published: row.published })), [{ code: inPlace ? 'OK' : 'TARGET_CHANGED', published: true }])
    assert.equal(receipt.code, 'REVISION_CONFLICT')
    assert.equal(receipt.retry, 'REVISION_CONFLICT')
    assert.equal(receipt.recovery.phase, occupied ? 'unresolved' : 'foreign-returned')
    assert.equal(receipt.targetText, occupied ? 'new original-name occupant' : 'independent native replacement')
    if (occupied) assert(receipt.holdings.includes('independent native replacement'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})
