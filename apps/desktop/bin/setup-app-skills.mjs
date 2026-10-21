// MODULE: setup-app-skills.mjs - Route the existing qualified app plan through setup ownership before legacy writes
import { closeSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writePrivate } from './agents-rules.mjs'
import { agentsDirectory } from './agents-roster.mjs'
import { optionalDefaultsOwnership } from './defaults-ownership.mjs'
import { installSetupSkill, refreshSetupSkill, retireSetupSkill } from './setup-skill-defaults.mjs'
import { readSetupSkillRecords, writeSetupSkillRecords } from './setup-skill-records.mjs'
import { setupFileParent } from './setup-file-defaults.mjs'
import { observeSetupSkill } from './setup-skill-fs.mjs'

const conflict = message => Object.assign(new Error(message), { code: 'REVISION_CONFLICT' })
const same = (a, b) => a.kind === b.kind && a.hash === b.hash && a.parent === b.parent && a.object === b.object

/** A source's public classification is usable only while its completed setup ancestry still matches. */
function assertSourceBinding(source) {
  if (!source) throw conflict('the app skill no longer has its original setup source')
  const journal = optionalDefaultsOwnership()
  if (!journal) throw conflict('the setup source ownership is missing')
  const entries = Object.values(journal.snapshot().entries), checked = new Set(), visiting = new Set()
  const visit = row => {
    if (!row || row.stage !== 'installed' || row.optOut || visiting.has(row.transaction)) throw conflict('the setup skill source has an unresolved or opted-out dependency')
    if (checked.has(row.transaction)) return
    visiting.add(row.transaction)
    const parent = setupFileParent(row.target.path)
    try {
      if (!same(observeSetupSkill(row.target.path, parent), row.current.fingerprint)) throw conflict(`${row.target.path} changed outside BMN; no setup skill is propagated`)
    } finally { closeSync(parent.fd) }
    for (const dependency of row.dependencies) {
      visit(entries.find(entry => entry.transaction === dependency.backingInstallId && entry.target.path === dependency.backingPath))
      if (dependency.viaSourceInstallId !== null) visit(entries.find(entry => entry.transaction === dependency.viaSourceInstallId && entry.target.app === 'source'))
    }
    visiting.delete(row.transaction); checked.add(row.transaction)
  }
  visit(entries.find(entry => entry.transaction === source.transaction && entry.target.path === source.target.path))
}

export function assertCompatibleSkillMetadata() {
  const journal = optionalDefaultsOwnership()
  return journal ? readSetupSkillRecords(journal, 'skills-written', { initialize: true }) : null
}

export function writeCompatibleSkillMetadata(value, folder) {
  const journal = optionalDefaultsOwnership()
  if (!journal) { writePrivate(join(agentsDirectory(), 'state/rules/skills-written.json'), JSON.stringify(value, null, 2)); return }
  const prior = readSetupSkillRecords(journal, 'skills-written', { initialize: true })
  writeSetupSkillRecords(journal, 'skills-written', prior, value, { folder })
}

/** The caller already revalidated exact-version folder qualification, route, eligibility and its displayed plan. */
export function applySetupSkillPlan(planned, { now, beforeTarget, afterTarget } = {}) {
  const journal = optionalDefaultsOwnership()
  if (!journal) return null
  readSetupSkillRecords(journal, 'skills-written', { initialize: true })
  const setupId = journal.snapshot().setupId, entries = Object.values(journal.snapshot().entries)
  const legacy = [], written = [], transactions = []
  for (const [index, row] of planned.targets.entries()) {
    const owned = entries.find(entry => entry.target.kind === 'skills' && entry.target.app === row.harness && entry.target.path === row.path)
    const source = entries.find(entry => entry.target.kind === 'skills' && entry.target.app === 'source' && entry.target.path === join(planned.source, row.skill))
    if (!owned && !source) { legacy.push(row); continue }
    try {
      beforeTarget?.(row, index)
      const target = { kind: 'skills', app: row.harness, path: row.path, entry: row.skill }
      let result
      if (owned?.optOut) result = { code: 'OK', written: [], state: 'opted-out' }
      else if (row.action === 'remove') result = owned ? retireSetupSkill(target, { setupId }) : { code: 'REVISION_CONFLICT', message: 'an unowned app entry is left as it is' }
      else {
        assertSourceBinding(source)
        if (!owned) mkdirSync(dirname(row.path), { recursive: true, mode: 0o700 })
        const desired = row.action === 'link' ? { kind: 'link', text: row.wanted.target } :
          { kind: 'tree', source: realpathSync(join(planned.source, row.skill)), expectedHash: row.wanted.source_hash,
            header: { name: row.skill, sourceHash: row.wanted.source_hash } }
        result = owned ? refreshSetupSkill(target, desired, { setupId, beforeHold: () => assertSourceBinding(source) }) :
          installSetupSkill(target, desired, { setupId, now, beforePublish: () => assertSourceBinding(source) })
      }
      if (result.code !== 'OK') return { ...result, written: [...written, ...(result.written ?? [])], legacy,
        transactions: [...transactions, ...(result.transaction ? [result.transaction] : [])], exposed: planned.exposed }
      afterTarget?.(row, index)
      if (result.transaction) transactions.push(result.transaction)
      if (row.action === 'remove' || result.written?.length) written.push({ harness: row.harness, skill: row.skill, path: row.path, action: row.action })
    } catch (error) { return { code: error.code ?? 'INSTALL_FAILED', message: error.message, written, legacy, transactions, exposed: planned.exposed } }
  }
  return { code: 'OK', transaction: transactions[0] ?? null, written, transactions, legacy, exposed: planned.exposed }
}
