// MODULE: setup-skill-legacy-routing.test.mjs - Setup assets never reach legacy adoption, refresh or destructive Undo
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { defaultsOwnershipPath, defaultsTargetKey, initializeDefaultsOwnership, readDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'
import { installOwnSkills, ownCopiesRoot } from '../../apps/desktop/bin/agents-own-skills.mjs'
import { restoreSkillsTransaction } from '../../apps/desktop/bin/agents-skills.mjs'
import { installSetupSkill } from '../../apps/desktop/bin/setup-skill-defaults.mjs'

let root, savedHome, source, shipped, environment, backing, sourceTarget
const setupId = 'synthetic-routing'
const entry = target => readDefaultsOwnership(setupId).snapshot().entries[defaultsTargetKey(target)]
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-skill-routing-')); savedHome = process.env.HOME; process.env.HOME = root
  source = join(root, 'source'); shipped = join(root, 'shipped'); environment = { HOME: root, BMN_SHIPPED_SKILLS: shipped }
  mkdirSync(source); mkdirSync(join(shipped, 'plan'), { recursive: true }); writeFileSync(join(shipped, 'manifest.json'), JSON.stringify({ skills: ['plan'], retired: [] }))
  writeFileSync(join(shipped, 'plan/SKILL.md'), 'synthetic v1')
  backing = { kind: 'own-skills', app: 'source', path: join(ownCopiesRoot(environment), 'plan'), entry: 'plan' }
  sourceTarget = { kind: 'skills', app: 'source', path: join(source, 'plan'), entry: 'plan' }; mkdirSync(dirname(backing.path), { recursive: true })
  withDefaultsAdmission(() => initializeDefaultsOwnership(setupId))
  for (const [target, desired] of [[backing, { kind: 'tree', source: join(shipped, 'plan') }], [sourceTarget, { kind: 'link', text: backing.path }]]) {
    const result = installSetupSkill(target, desired, { setupId }); assert.equal(result.code, 'OK', result.message)
  }
})
afterEach(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; rmSync(root, { recursive: true, force: true }) })

describe('setup ownership before legacy skill paths', () => {
  it('routes startup refresh through the original checked revision and preserves the previous tree', () => {
    writeFileSync(join(shipped, 'plan/SKILL.md'), 'synthetic v2')
    const result = installOwnSkills({ source, environment })
    assert.equal(result.ok, true, result.message); assert.equal(entry(backing).current.revision, 2)
    assert.equal(readFileSync(join(backing.path, 'SKILL.md'), 'utf8'), 'synthetic v2')
    assert.equal(readFileSync(join(result.rows[0].recovery.holdingPath, 'SKILL.md'), 'utf8'), 'synthetic v1')
  })

  it('retires a setup source first and retains backing for an app link after the source becomes dangling', () => {
    const target = { kind: 'skills', app: 'codex', path: join(root, 'codex/plan'), entry: 'plan' }; mkdirSync(dirname(target.path))
    const installed = installSetupSkill(target, { kind: 'link', text: sourceTarget.path }, { setupId }); assert.equal(installed.code, 'OK', installed.message)
    writeFileSync(join(shipped, 'manifest.json'), JSON.stringify({ skills: [], retired: ['plan'] }))
    const result = installOwnSkills({ source, environment })
    assert.equal(result.ok, true, result.message); assert.equal(entry(sourceTarget).stage, 'opted-out'); assert.equal(entry(backing).stage, 'retained')
    assert.equal(existsSync(sourceTarget.path), false); assert.equal(readFileSync(join(backing.path, 'SKILL.md'), 'utf8'), 'synthetic v1')
    assert.equal(installOwnSkills({ source, environment }).rows[0].state, 'retired')
  })

  it('blocks startup on a corrupt setup journal instead of falling back to legacy adoption or refresh', () => {
    writeFileSync(join(shipped, 'plan/SKILL.md'), 'synthetic v2'); writeFileSync(defaultsOwnershipPath(), '{}')
    const result = installOwnSkills({ source, environment })
    assert.equal(result.ok, false); assert.equal(readFileSync(join(backing.path, 'SKILL.md'), 'utf8'), 'synthetic v1')
  })

  it('refuses an old legacy Undo against a path that now has a different setup transaction', async () => {
    const target = { kind: 'skills', app: 'codex', path: join(root, 'codex/plan'), entry: 'plan' }; mkdirSync(dirname(target.path))
    const installed = installSetupSkill(target, { kind: 'link', text: sourceTarget.path }, { setupId }); assert.equal(installed.code, 'OK', installed.message)
    const result = await restoreSkillsTransaction({ id: 'legacy', targets: [{ harness: 'codex', path: target.path, done: true, prior: { kind: 'missing' }, prior_record: null,
      written: { kind: 'link', target: sourceTarget.path } }] }, root, { yes: true, asJson: true })
    assert.equal(result.code, 'REVISION_CONFLICT'); assert.equal(entry(target).stage, 'installed')
    assert.equal(existsSync(target.path), true)
  })
})
