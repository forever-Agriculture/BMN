// MODULE: setup-own-skills.mjs - Startup maintenance of setup-owned shipped skills before any legacy adoption
import { closeSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { defaultsTargetKey, readDefaultsOwnership } from './defaults-ownership.mjs'
import { installSetupSkill, refreshSetupSkill, retireSetupSkill } from './setup-skill-defaults.mjs'
import { observeSetupSkill, plannedSetupSkillHash } from './setup-skill-fs.mjs'
import { setupFileParent } from './setup-file-defaults.mjs'
import { readSetupSkillRecords } from './setup-skill-records.mjs'

const entryFor = (journal, target) => journal.snapshot().entries[defaultsTargetKey(target)]
const observation = path => {
  const parent = setupFileParent(path)
  try { return observeSetupSkill(path, parent) } finally { closeSync(parent.fd) }
}
const must = result => { if (result.code !== 'OK') throw Object.assign(new Error(result.message), { code: result.code, recovery: result.recovery }); return result }

/** Only a profile with a valid setup journal enters here; ordinary profiles retain their original installer. */
export function maintainSetupOwnSkills({ journal, source, copies, root, names, retired, apply }) {
  const setupId = journal.snapshot().setupId, rows = []
  let ok = true
  for (const name of [...names, ...retired]) {
    const path = join(source, name), copy = join(copies, name), shipped = join(root, name)
    const backing = { kind: 'own-skills', app: 'source', path: copy, entry: name }, link = { kind: 'skills', app: 'source', path, entry: name }
    try {
      journal = readDefaultsOwnership(setupId)
      const oldBacking = entryFor(journal, backing), oldLink = entryFor(journal, link)
      if (retired.includes(name)) {
        if (apply) {
          if (oldLink) must(retireSetupSkill(link, { setupId }))
          const removed = oldBacking ? retireSetupSkill(backing, { setupId }) : { code: 'OK' }
          if (!['OK', 'DEFAULTS_DEPENDENCIES'].includes(removed.code)) must(removed)
          rows.push({ name, path, copy, state: 'retired', retained: removed.code === 'DEFAULTS_DEPENDENCIES', detail: removed.message, ...(removed.recovery ? { recovery: removed.recovery } : {}) })
        } else rows.push({ name, path, copy, state: 'retired', detail: 'setup retirement preserves backing while any destination depends on it' })
        continue
      }
      if (!oldLink && observation(path).kind !== 'absent') { rows.push({ name, path, state: 'foreign', detail: 'not setup-owned; left as it is' }); continue }
      if (oldLink?.optOut || oldBacking?.optOut) { rows.push({ name, path, copy, state: 'removed', detail: 'setup opt-out; never reinstalled or refreshed' }); continue }
      const desired = { kind: 'tree', source: shipped }
      if (!apply) {
        readSetupSkillRecords(journal, 'own-skills'); readSetupSkillRecords(journal, 'skills-written')
        const state = !oldBacking || !oldLink ? 'installed' : observation(copy).hash === plannedSetupSkillHash(desired) ? 'current' : 'updated'
        rows.push({ name, path, copy, state }); continue
      }
      mkdirSync(dirname(copy), { recursive: true, mode: 0o700 })
      const installed = must(installSetupSkill(backing, desired, { setupId }))
      const linked = must(installSetupSkill(link, { kind: 'link', text: copy }, { setupId }))
      if (installed.state === 'opted-out' || linked.state === 'opted-out') { rows.push({ name, path, copy, state: 'removed' }); continue }
      const refreshed = must(refreshSetupSkill(backing, desired, { setupId }))
      rows.push({ name, path, copy, state: refreshed.state === 'updated' ? 'updated' : oldBacking && oldLink ? 'current' : 'installed',
        ...(refreshed.recovery ? { recovery: refreshed.recovery, detail: `previous tree preserved at ${refreshed.recovery.holdingPath}` } : {}) })
    } catch (error) {
      ok = false; rows.push({ name, path, copy, state: 'unavailable', detail: error.message, ...(error.recovery ? { recovery: error.recovery } : {}) })
    }
  }
  return { ok, code: ok ? 'OK' : 'DEFAULTS_STATE_UNAVAILABLE', source, shipped: root, copies, rows }
}
