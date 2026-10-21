// MODULE: setup-skill-records.test.mjs - Strict compatibility metadata and durable evidence of absence
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, it } from 'vitest'
import { withDefaultsAdmission } from '../../apps/desktop/bin/defaults-admission.mjs'
import { initializeDefaultsOwnership, readDefaultsOwnership } from '../../apps/desktop/bin/defaults-ownership.mjs'
import { newTransaction } from '../../apps/desktop/bin/agents-rules.mjs'
import { readSetupSkillRecords, setupSkillRecordPath, writeSetupSkillRecords } from '../../apps/desktop/bin/setup-skill-records.mjs'

let root, home, journalPath, folder
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bmn-setup-skill-records-')); home = process.env.HOME; process.env.HOME = root
  journalPath = join(root, 'ownership.json')
  withDefaultsAdmission(() => { folder = newTransaction(new Date()).folder })
})
afterEach(() => { if (home === undefined) delete process.env.HOME; else process.env.HOME = home; rmSync(root, { recursive: true, force: true }) })
const admitted = work => withDefaultsAdmission(work, { directory: root })
const readJournal = () => readDefaultsOwnership('synthetic-records', { path: journalPath })
const linkRecord = () => ({ [join(root, 'codex/plan')]: { harness: 'codex', skill: 'plan', kind: 'link', target: join(root, 'source/plan') } })

describe('setup skill compatibility records', () => {
  it('binds first absence durably, preserves the previous whole record, and reads back both legacy writer shapes', () => admitted(() => {
    const journal = initializeDefaultsOwnership('synthetic-records', { path: journalPath })
    for (const kind of ['own-skills', 'skills-written']) {
      const first = readSetupSkillRecords(journal, kind, { initialize: true })
      assert.equal(first.hash, null)
      const value = kind === 'own-skills' ? { version: 1, skills: { plan: { path: join(root, 'source/plan'), copy: join(root, 'backing/plan'), at: new Date(0).toISOString() } }, removed: {} } : linkRecord()
      const saved = writeSetupSkillRecords(journal, kind, first, value, { folder })
      assert.deepEqual(readSetupSkillRecords(readJournal(), kind).value, value)
      const next = structuredClone(value)
      if (kind === 'own-skills') next.skills.plan.at = new Date(1).toISOString()
      else next[join(root, 'codex/plan')] = { harness: 'codex', skill: 'plan', kind: 'copy', hash: 'a'.repeat(64), source_hash: 'b'.repeat(64) }
      const changed = writeSetupSkillRecords(journal, kind, saved, next, { folder })
      assert.equal(changed.recoveryPaths.length, 1)
      assert.deepEqual(JSON.parse(readFileSync(changed.recoveryPaths[0], 'utf8')), value)
    }
  }))

  it('refuses missing provenance, unexpected disappearance, links and malformed existing records', () => admitted(() => {
    const journal = initializeDefaultsOwnership('synthetic-records', { path: journalPath }), path = setupSkillRecordPath('skills-written')
    assert.throws(() => readSetupSkillRecords(journal, 'skills-written'), /provenance/)
    mkdirSync(dirname(path), { recursive: true })
    for (const value of [[], null, { [join(root, 'codex/plan')]: { ...linkRecord()[join(root, 'codex/plan')], extra: true } },
      { relative: { harness: 'codex', skill: 'plan', kind: 'link', target: 'relative' } }]) {
      writeFileSync(path, JSON.stringify(value))
      assert.throws(() => readSetupSkillRecords(journal, 'skills-written', { initialize: true }), /invalid|corrupt/)
    }
    rmSync(path); symlinkSync(join(root, 'not-read'), path)
    assert.throws(() => readSetupSkillRecords(journal, 'skills-written', { initialize: true }))
    rmSync(path); const empty = readSetupSkillRecords(journal, 'skills-written', { initialize: true })
    writeSetupSkillRecords(journal, 'skills-written', empty, linkRecord(), { folder })
    rmSync(path)
    assert.throws(() => readSetupSkillRecords(readJournal(), 'skills-written'), /changed|disappeared/)
  }))

  it('blocks every subsequent read after an interrupted physical metadata publication, even when bytes match', () => admitted(() => {
    const journal = initializeDefaultsOwnership('synthetic-records', { path: journalPath })
    const first = readSetupSkillRecords(journal, 'skills-written', { initialize: true })
    assert.throws(() => writeSetupSkillRecords(journal, 'skills-written', first, linkRecord(), {
      folder, afterCommit: () => { throw new Error('synthetic interruption') }
    }), /synthetic interruption/)
    assert(existsSync(setupSkillRecordPath('skills-written')))
    assert.throws(() => readSetupSkillRecords(readJournal(), 'skills-written'), /interrupted/)
  }))

  it('refuses unknown fields, contradictory own removals and malformed timestamps before changing metadata', () => admitted(() => {
    const journal = initializeDefaultsOwnership('synthetic-records', { path: journalPath }), first = readSetupSkillRecords(journal, 'own-skills', { initialize: true })
    for (const value of [{ version: 1, skills: {}, removed: {}, extra: true }, { version: 1, skills: { plan: { path: '/source/plan', copy: '/backing/plan', at: 'yesterday' } }, removed: {} },
      { version: 1, skills: { plan: { path: '/source/plan', copy: '/backing/plan', at: new Date(0).toISOString() } }, removed: { plan: new Date(0).toISOString() } }]) {
      assert.throws(() => writeSetupSkillRecords(journal, 'own-skills', first, value, { folder }), /invalid|corrupt/)
    }
    assert.equal(existsSync(setupSkillRecordPath('own-skills')), false)
  }))
})
