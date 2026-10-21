// MODULE: setup-master-template.test.mjs - Approved master rendering, approval boundary and absent-only Undo
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { initializeDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'
import { masterPath, parseMaster, readMaster, render, restoreTransaction } from '../../apps/desktop/bin/agents-rules.mjs'
import { sha256 } from '../../apps/desktop/bin/agents-roster.mjs'
import { readValidRoster } from '../../apps/desktop/bin/agents-state.mjs'
import { DEFAULT_SETUP_MASTER, installSetupMaster } from '../../apps/desktop/bin/setup-master-template.mjs'
import { approveRoster } from '../../apps/desktop/src/main/agents-approval.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/setup-master-rendering.json', import.meta.url), 'utf8'))
const example = readFileSync(new URL('../../apps/desktop/src/utility/test-fixtures/agents/roster-example.md', import.meta.url), 'utf8')
const setupId = 'synthetic-master-79'
let root, oldHome
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-master-')); oldHome = process.env.HOME; process.env.HOME = root
  mkdirSync(dirname(masterPath()), { recursive: true })
  withDefaultsAdmission(() => initializeDefaultsOwnership(setupId))
})
afterEach(() => { process.env.HOME = oldHome; rmSync(root, { recursive: true, force: true }) })
function approve() {
  writeFileSync(join(dirname(masterPath()), 'roster.md'), example.replaceAll('private_work: allowed', 'private_work: public_only'))
  approveRoster({ generation: null, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
}

describe('approved default master', () => {
  it('keeps the exact approved text and recorded rendering for every app and privacy setting', () => {
    assert.equal(sha256(DEFAULT_SETUP_MASTER), fixture.masterSha256)
    const parsed = parseMaster(DEFAULT_SETUP_MASTER); assert.deepEqual(parsed.errors, [])
    const master = { path: fixture.masterPath, hash: fixture.masterSha256, parts: parsed.parts }
    for (const row of fixture.cases) {
      const generation = { data: { agents: [], providers: [{ id: 'synthetic', name: 'Synthetic provider', private_work: row.privateWork }],
        harness_routes: [{ harness: row.app, provider: 'synthetic', basis: 'inspected' }] } }
      const rendered = render(master, row.app, generation)
      assert.equal(rendered.kind, row.kind, `${row.app} ${row.privateWork}`)
      assert.equal(rendered.text, fixture.rendering, `${row.app} ${row.privateWork}`)
    }
  })

  it('requires an approved team before creating the master', () => {
    assert.equal(installSetupMaster({ setupId }).code, 'NOT_APPROVED')
    assert(!existsSync(masterPath()))
  })

  it('installs the approved bytes once and existing Undo makes removal durable', async () => {
    approve()
    const result = installSetupMaster({ setupId }); assert.equal(result.code, 'OK', result.message)
    assert.equal(readMaster().text, DEFAULT_SETUP_MASTER)
    assert.equal(installSetupMaster({ setupId }).state, 'installed')
    assert.equal((await restoreTransaction(result.transaction, { yes: true, asJson: true })).code, 'OK')
    assert(!existsSync(masterPath()))
    assert.equal(installSetupMaster({ setupId }).state, 'opted-out'); assert(!existsSync(masterPath()))
  })

  it('leaves an existing personal master unchanged', () => {
    approve(); writeFileSync(masterPath(), '# Synthetic personal master\n')
    assert.equal(installSetupMaster({ setupId }).code, 'FOREIGN_TARGET')
    assert.equal(readFileSync(masterPath(), 'utf8'), '# Synthetic personal master\n')
  })
})
