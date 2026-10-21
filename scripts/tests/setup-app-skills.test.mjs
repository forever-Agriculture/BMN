// MODULE: setup-app-skills.test.mjs - Existing qualified app install routes setup assets through checked transactions
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { approveRoster } from '../../apps/desktop/src/main/agents-approval.ts'
import { readValidRoster } from '../../apps/desktop/bin/agents-state.mjs'
import { installSkills, skillsTestsPath, treeHash } from '../../apps/desktop/bin/agents-skills.mjs'
import { ownCopiesRoot } from '../../apps/desktop/bin/agents-own-skills.mjs'
import { restoreTransaction } from '../../apps/desktop/bin/agents-rules.mjs'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { defaultsTargetKey, initializeDefaultsOwnership, readDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'
import { installSetupSkill, refreshSetupSkill } from '../../apps/desktop/bin/setup-skill-defaults.mjs'
import { readSetupSkillRecords } from '../../apps/desktop/bin/setup-skill-records.mjs'

let root, home, environment, backing, source, target
const setupId = 'synthetic-app-skills', version = '0.163.0'
const entry = () => readDefaultsOwnership(setupId).snapshot().entries[defaultsTargetKey(target)]
const tested = link => appendFileSync(skillsTestsPath(), `${JSON.stringify({ harness: 'codex', kind: 'capability', version, outcome: 'pass', roots: [{ root: '.agents/skills', folder: true, link }] })}\n`)
const install = () => installSkills(['codex'], { yes: true, asJson: true, absent: true, environment, versions: { codex: version } })
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-app-skills-')); home = process.env.HOME; process.env.HOME = root
  mkdirSync(join(root, 'stubs'))
  writeFileSync(join(root, 'stubs/codex'), `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex ${version}"; exit 0; fi\nexit 64\n`, { mode: 0o755 })
  environment = { HOME: root, PATH: `${root}/stubs:/usr/bin:/bin` }
  const agents = join(root, '.config/bmn/agents'); mkdirSync(agents, { recursive: true })
  writeFileSync(join(agents, 'roster.md'), readFileSync(new URL('../../apps/desktop/src/utility/test-fixtures/agents/roster-example.md', import.meta.url), 'utf8'))
  approveRoster({ generation: null, fileHash: readValidRoster().hash }, { checkInspectedRoutes: () => {} })
  backing = { kind: 'own-skills', app: 'source', path: join(ownCopiesRoot(environment), 'plan'), entry: 'plan' }
  source = { kind: 'skills', app: 'source', path: join(root, '.claude/skills/plan'), entry: 'plan' }
  target = { kind: 'skills', app: 'codex', path: join(root, '.agents/skills/plan'), entry: 'plan' }
  const shipped = join(root, 'shipped/plan'); mkdirSync(shipped, { recursive: true }); writeFileSync(join(shipped, 'SKILL.md'), '---\nname: plan\ndescription: Synthetic plan\n---\nSynthetic v1')
  for (const path of [backing.path, source.path, target.path]) mkdirSync(dirname(path), { recursive: true })
  withDefaultsAdmission(() => initializeDefaultsOwnership(setupId))
  for (const [path, desired] of [[backing, { kind: 'tree', source: shipped }], [source, { kind: 'link', text: backing.path }]]) {
    const result = installSetupSkill(path, desired, { setupId }); assert.equal(result.code, 'OK', result.message)
  }
})
afterEach(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; rmSync(root, { recursive: true, force: true }) })

describe('qualified app skills with setup ownership', () => {
  it('creates a separate setup transaction for a newly ready app and preserves its opt-out on later reads', async () => {
    tested(true)
    const result = await install(); assert.equal(result.code, 'OK', result.message)
    assert.equal(entry()?.stage, 'installed', JSON.stringify(result))
    assert.equal(entry().dependencies[0].viaSourceInstallId, readDefaultsOwnership(setupId).snapshot().entries[defaultsTargetKey(source)].transaction)
    assert.equal((await restoreTransaction(entry().transaction, { yes: true, asJson: true })).code, 'OK')
    assert.equal((await install()).code, 'OK'); assert.equal(existsSync(target.path), false)
  })

  it('refreshes a qualified copy through its checked current revision and original Undo', async () => {
    tested(false)
    const copied = installSetupSkill(target, { kind: 'tree', source: backing.path, header: { name: 'plan', sourceHash: treeHash(backing.path) } }, { setupId })
    assert.equal(copied.code, 'OK', copied.message)
    writeFileSync(join(root, 'shipped/plan/SKILL.md'), '---\nname: plan\ndescription: Synthetic plan\n---\nSynthetic v2')
    assert.equal(refreshSetupSkill(backing, { kind: 'tree', source: join(root, 'shipped/plan') }, { setupId }).code, 'OK')
    const result = await install(); assert.equal(result.code, 'OK', result.message)
    assert.equal(entry().current.revision, 2)
    assert(readFileSync(join(target.path, 'SKILL.md'), 'utf8').includes('Synthetic v2'))
    assert.equal((await restoreTransaction(copied.transaction, { yes: true, asJson: true })).code, 'OK')
  })

  it('keeps a non-setup skill install compatible with the witnessed shared record', async () => {
    tested(true); const first = await install(); assert.equal(first.code, 'OK', first.message)
    const privateSkill = join(root, '.claude/skills/alpha'); mkdirSync(privateSkill); writeFileSync(join(privateSkill, 'SKILL.md'), '---\nname: alpha\ndescription: Synthetic alpha\n---\nSynthetic alpha')
    const result = await install(); assert.equal(result.code, 'OK', result.message)
    assert(existsSync(join(root, '.agents/skills/alpha')))
    assert.doesNotThrow(() => readSetupSkillRecords(readDefaultsOwnership(setupId), 'skills-written'))
  })

  it('changes a tested app route from link to copy and preserves original Undo', async () => {
    tested(true); assert.equal((await install()).code, 'OK')
    const original = structuredClone(entry())
    tested(false); const changed = await install(); assert.equal(changed.code, 'OK', changed.message)
    assert.equal(entry().current.fingerprint.kind, 'tree'); assert.equal(entry().current.revision, 2)
    assert.deepEqual(entry().after, original.after); assert.equal(entry().dependencies.length, 0)
    tested(true); const linked = await install(); assert.equal(linked.code, 'OK', linked.message)
    assert.equal(entry().current.fingerprint.kind, 'link'); assert.equal(entry().current.revision, 3); assert.equal(entry().dependencies.length, 1)
    assert.equal((await restoreTransaction(original.transaction, { yes: true, asJson: true })).code, 'OK')
    assert.equal(existsSync(target.path), false)
  })

  it('refuses to propagate an externally changed setup backing into a newly ready app', async () => {
    tested(false)
    writeFileSync(join(backing.path, 'SKILL.md'), 'synthetic foreign replacement text')
    const result = await install()
    assert.notEqual(result.code, 'OK', JSON.stringify(result))
    assert.equal(existsSync(target.path), false)
    assert.equal(readFileSync(join(backing.path, 'SKILL.md'), 'utf8'), 'synthetic foreign replacement text')
  })
})
