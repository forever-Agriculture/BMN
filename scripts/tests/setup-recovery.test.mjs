// MODULE: setup-recovery.test.mjs - Historical recovery, interrupted intents, hostile entries and finite reporting budgets
import assert from 'node:assert/strict'
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, it } from 'vitest'
import { agentsDirectory } from '../../apps/desktop/bin/agents-roster.mjs'
import { readSetupRecovery } from '../../apps/desktop/bin/setup-recovery.mjs'
import { setupSkillRecordPath } from '../../apps/desktop/bin/setup-skill-records.mjs'

let root, home, transactions
const setupId = 'synthetic-recovery-history'
const id = n => `2026-10-21T08-00-00Z-100-${n}`
const target = () => ({ kind: 'hooks', app: 'codex', path: join(root, 'hooks.json'), entry: 'Stop' })
const held = (transaction, sourcePath, suffix = 'a') => ({ version: 1, phase: 'intent', sourcePath,
  holdingPath: join(root, `.bmn-hold-${transaction}-${suffix.repeat(16)}`) })
const put = (folder, value) => { mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'manifest.json'), JSON.stringify(value)) }
const hook = n => ({ id: id(n), kind: 'setup-hook', state: 'failed', setup: { setupId, target: target(),
  configInstall: { version: 1, phase: 'complete', path: target().path, directory: root }, configInstallHolding: held(id(n), target().path) } })
const paths = result => result.rows.flatMap(row => row.recoveryPaths)
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-recovery-')); home = process.env.HOME; process.env.HOME = root
  transactions = join(agentsDirectory(), 'state/rules/transactions'); mkdirSync(transactions, { recursive: true })
})
afterEach(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; rmSync(root, { recursive: true, force: true }) })

it('discovers failed pre-ownership transactions without reading or requiring recovery payloads', () => {
  const value = hook(1); put(join(transactions, value.id), value)
  // A dangling link at the recorded holding would be unsafe to open. Discovery reads only the manifest.
  symlinkSync(join(root, 'missing-private-file'), value.setup.configInstallHolding.holdingPath)
  const result = readSetupRecovery(setupId)
  assert.equal(result.code, 'OK'); assert.deepEqual(paths(result), [value.setup.configInstallHolding.holdingPath])
  assert(result.rows.every(row => row.state === 'recovery'))
  assert.deepEqual(readSetupRecovery(setupId), result, 'a fresh reader retains historical locations')
})

it('retains multiple completed refreshes, nested metadata and original Undo history', () => {
  const original = { id: id(1), kind: 'setup-skill', state: 'complete', setup: { setupId,
    target: { kind: 'own-skills', app: 'source', path: join(root, 'plan'), entry: 'plan' }, removal: held(id(1), join(root, 'plan')) } }
  const folder = join(transactions, original.id); put(folder, original)
  const expected = [original.setup.removal.holdingPath]
  for (const suffix of ['a', 'b']) {
    const refresh = `refresh-${suffix.repeat(24)}`, next = { id: refresh, kind: 'setup-skill-refresh', state: 'complete',
      setup: { originalTransaction: original.id, target: original.setup.target, removal: held(refresh, original.setup.target.path) } }
    put(join(folder, refresh), next); expected.push(next.setup.removal.holdingPath)
    const metadata = `metadata-${suffix.repeat(24)}`, path = setupSkillRecordPath('own-skills')
    mkdirSync(join(agentsDirectory(), 'state'), { recursive: true })
    const value = { id: metadata, kind: 'setup-skill-metadata', setup: {
      configInstall: { version: 1, phase: 'complete', path, directory: join(agentsDirectory(), 'state') },
      configInstallHolding: { ...held(metadata, path), holdingPath: join(agentsDirectory(), 'state', `.bmn-hold-${metadata}-${'a'.repeat(16)}`) } } }
    put(join(folder, refresh, metadata), value); expected.push(value.setup.configInstallHolding.holdingPath)
  }
  const result = readSetupRecovery(setupId)
  assert.equal(result.code, 'OK'); assert.deepEqual(paths(result).sort(), expected.sort())
})

it('reports interrupted staged files even before an ownership entry exists', () => {
  const value = { id: id(1), kind: 'setup-skill', state: 'failed', setup: { setupId,
    target: { kind: 'own-skills', app: 'source', path: join(root, 'plan'), entry: 'plan' },
    staging: { version: 1, kind: 'skill', sourcePath: join(root, 'plan'), path: join(root, `.bmn-stage-${id(1)}-${'a'.repeat(16)}`) } } }
  put(join(transactions, value.id), value)
  const result = readSetupRecovery(setupId)
  assert.equal(result.code, 'OK'); assert(paths(result).includes(value.setup.staging.path))
})

for (const hostile of ['symlink', 'hardlink', 'malformed', 'oversized', 'wrong-id', 'escaped-path']) it(`refuses ${hostile} history and keeps valid siblings`, () => {
  const good = hook(1); put(join(transactions, good.id), good)
  const bad = hook(2), folder = join(transactions, bad.id)
  mkdirSync(folder)
  if (hostile === 'symlink' || hostile === 'hardlink') {
    const outside = join(root, 'synthetic-private-canary'); writeFileSync(outside, 'DO-NOT-READ-OR-RETURN synthetic canary')
    if (hostile === 'symlink') symlinkSync(outside, join(folder, 'manifest.json')); else linkSync(outside, join(folder, 'manifest.json'))
  } else {
    if (hostile === 'wrong-id') bad.id = '../outside'
    if (hostile === 'escaped-path') bad.setup.configInstallHolding.holdingPath = '/outside/../secret'
    writeFileSync(join(folder, 'manifest.json'), hostile === 'malformed' ? '{bad json' : hostile === 'oversized' ? 'x'.repeat(2 * 1024 * 1024 + 1) : JSON.stringify(bad))
  }
  const result = readSetupRecovery(setupId)
  assert.equal(result.code, 'RECOVERY_INCOMPLETE'); assert(paths(result).includes(good.setup.configInstallHolding.holdingPath))
  assert(!JSON.stringify(result).includes('DO-NOT-READ-OR-RETURN'))
})

it('does not traverse a redirected transaction directory or mix another setup identity', () => {
  const other = hook(1); other.setup.setupId = 'another-setup'; put(join(transactions, other.id), other)
  assert.deepEqual(paths(readSetupRecovery(setupId)), [])
  const outside = join(root, 'outside'); mkdirSync(outside); symlinkSync(outside, join(transactions, id(2)))
  assert.equal(readSetupRecovery(setupId).code, 'RECOVERY_INCOMPLETE')
})

it('makes path, entry and byte overflow explicit without silently claiming complete history', () => {
  for (const n of [1, 2]) put(join(transactions, id(n)), hook(n))
  const limited = readSetupRecovery(setupId, { maxPaths: 1 })
  assert.equal(limited.code, 'RECOVERY_INCOMPLETE'); assert.equal(paths(limited).length, 1)
  assert.equal(readSetupRecovery(setupId, { maxEntries: 1 }).code, 'RECOVERY_INCOMPLETE')
  assert.equal(readSetupRecovery(setupId, { maxBytes: 1 }).code, 'RECOVERY_INCOMPLETE')
  assert.equal(readSetupRecovery(setupId, { maxOutputBytes: 1 }).code, 'RECOVERY_INCOMPLETE')
  assert(JSON.parse(readFileSync(join(transactions, id(1), 'manifest.json'), 'utf8')).setup.configInstallHolding)
})
