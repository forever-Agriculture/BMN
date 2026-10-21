// MODULE: setup-defaults.mjs - Fresh-profile defaults joined through existing qualified, journaled adapters
import { closeSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { agentsDirectory, HARNESSES, sha256 } from './agents-roster.mjs'
import { readApproved } from './agents-state.mjs'
import { masterPath, parseMaster, render, targetPath } from './agents-rules.mjs'
import { withDefaultsAdmission } from './defaults-admission.mjs'
import { initializeDefaultsOwnership, readDefaultsOwnership } from './defaults-ownership.mjs'
import { DEFAULT_SETUP_MASTER, installSetupMaster } from './setup-master-template.mjs'
import { installSetupFile, observeSetupFile, setupFileParent } from './setup-file-defaults.mjs'
import { installOwnSkills, shippedSkillNames } from './agents-own-skills.mjs'
import { installSkills } from './agents-skills.mjs'
import { installSetupHook, setupHookPath } from './setup-hook-defaults.mjs'
import { setupHookGroups } from './bmn-hooks.mjs'
import { installSetupOpenCodeHooks } from './setup-opencode-hooks.mjs'
import { installSetupTool } from './setup-tool-defaults.mjs'
import { readSetupRecovery } from './setup-recovery.mjs'

const fail = code => Object.assign(new Error(code), { code })
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const identity = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value)

export function setupSkillsSource() { return join(agentsDirectory(), 'skills') }

/** A durable SQLite claim, supplied by main, is the only automatic creation authority. */
export function validSetupDefaultsRequest(value) {
  return exact(value, ['mode', 'claim', 'ready']) && ['prepare', 'apply'].includes(value.mode) &&
    exact(value.claim, ['setupId', 'initialize']) && identity(value.claim.setupId) && typeof value.claim.initialize === 'boolean' &&
    Array.isArray(value.ready) && value.ready.length <= HARNESSES.length &&
    new Set(value.ready.map(row => row?.app)).size === value.ready.length && value.ready.every(row =>
      exact(row, ['app', 'version']) && HARNESSES.includes(row.app) && typeof row.version === 'string' &&
      /^[0-9][a-zA-Z0-9.+_-]{0,79}$/.test(row.version))
}

function directory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 })
  const entry = lstatSync(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw fail('DEFAULTS_STATE_UNAVAILABLE')
}

function prepare(claim) {
  return withDefaultsAdmission(() => {
    const journal = claim.initialize ? initializeDefaultsOwnership(claim.setupId) : readDefaultsOwnership(claim.setupId)
    const source = setupSkillsSource()
    directory(source)
    return { journal, source, names: shippedSkillNames() }
  })
}

/** Project fixed result fields only; never relay raw CLI/config text or exceptions into setup's state. */
function project(kind, app, result) {
  const recovery = result?.recovery
  const paths = [...new Set((result?.written ?? []).map(row => row.path).filter(path => typeof path === 'string' && isAbsolute(path)))]
  const recoveryPaths = [...new Set([...(Array.isArray(result?.recoveryPaths) ? result.recoveryPaths : []), ...(Array.isArray(recovery?.holdingPaths) ? recovery.holdingPaths : []),
    recovery?.holdingPath, recovery?.stagingPath, recovery?.stagedPath].filter(path => typeof path === 'string' && isAbsolute(path)))]
  return { kind, app, code: typeof result?.code === 'string' ? result.code : result?.ok === true ? 'OK' : 'INSTALL_FAILED',
    state: typeof result?.state === 'string' ? result.state : paths.length > 0 ? 'installed' : 'waiting',
    transaction: typeof result?.transaction === 'string' ? result.transaction : null, paths, recoveryPaths }
}

function ownedMaster(setupId) {
  const path = masterPath(), parent = setupFileParent(path)
  try {
    const journal = readDefaultsOwnership(setupId), observed = observeSetupFile(path, parent)
    return journal.inspect({ kind: 'master', app: 'master', path, entry: 'master' }, observed) === 'installed' &&
      observed.hash === sha256(DEFAULT_SETUP_MASTER)
  } finally { closeSync(parent.fd) }
}

/** Each adapter takes admission independently; no lease spans a child process or native capability test. */
export async function coordinateSetupDefaults(request) {
  if (!validSetupDefaultsRequest(request)) return { code: 'INVALID_ARGUMENT', source: null, names: [], rows: [] }
  const finish = report => {
    const recovery = readSetupRecovery(request.claim.setupId)
    return { ...report, code: recovery.code !== 'OK' && report.code === 'OK' ? 'DEFAULTS_PARTIAL' : report.code, rows: [...report.rows, ...recovery.rows] }
  }
  let prepared, generation
  const rows = []
  const run = async (kind, app, work) => {
    try { const result = await work(); const row = project(kind, app, result); rows.push(row); return row }
    catch (error) { const row = project(kind, app, { code: typeof error?.code === 'string' ? error.code : 'INSTALL_FAILED' }); rows.push(row); return row }
  }
  try {
    // Apply never creates an asset before approval. Prepare creates only the empty portable folder and journal.
    if (request.mode === 'apply') generation = readApproved()
    prepared = prepare(request.claim)
  } catch (error) {
    return finish({ code: typeof error?.code === 'string' ? error.code : 'DEFAULTS_STATE_UNAVAILABLE', source: null, names: [], rows: [] })
  }
  const { source, names } = prepared, setupId = request.claim.setupId
  if (request.mode === 'prepare') return finish({ code: 'OK', source, names, rows })
  if (generation.data.skills_source !== source) return finish({ code: 'DEFAULTS_SOURCE_CHANGED', source, names, rows })
  await run('master', null, () => installSetupMaster({ setupId }))
  let ownResult
  const own = await run('own-skills', null, () => { ownResult = installOwnSkills({ source }); return ownResult })
  if (ownResult?.rows?.length) {
    rows.pop()
    for (const row of ownResult.rows) rows.push(project('own-skills', null, {
      code: row.state === 'unavailable' ? 'DEFAULTS_STATE_UNAVAILABLE' : 'OK', state: row.state,
      written: [row.path, row.copy].filter(path => typeof path === 'string').map(path => ({ path })), recovery: row.recovery
    }))
  }
  const versions = Object.fromEntries(request.ready.map(row => [row.app, row.version]))
  for (const { app } of request.ready) {
    await run('rules', app, () => withDefaultsAdmission(() => {
      if (!ownedMaster(setupId)) return { code: 'DEFAULTS_MASTER_UNAVAILABLE' }
      const latest = readApproved()
      if (latest.hash !== generation.hash) return { code: 'REVISION_CONFLICT' }
      const path = targetPath(app)
      directory(dirname(path))
      const master = { path: masterPath(), hash: sha256(DEFAULT_SETUP_MASTER), parts: parseMaster(DEFAULT_SETUP_MASTER).parts }
      return installSetupFile({ kind: 'rules', app, path, entry: 'rules' }, render(master, app, latest).text, { setupId })
    }))
    if (app === 'opencode') await run('hooks', app, () => installSetupOpenCodeHooks({ setupId }))
    else {
      const path = setupHookPath(app)
      // Event names come from the native hook contract; adapters reread each actual config under admission.
      for (const event of Object.keys(setupHookGroups(app, '{}').groups)) {
        await run('hooks', app, () => installSetupHook(app, event, { setupId }))
      }
      // Keep the row's path available even where an existing foreign group made no write.
      for (const row of rows.filter(row => row.kind === 'hooks' && row.app === app)) if (row.paths.length === 0) row.paths.push(path)
    }
    if (own.code === 'OK') await run('skills', app, () => installSkills([app], { yes: true, asJson: true, absent: true, versions }))
    else rows.push(project('skills', app, { code: 'DEFAULTS_SOURCE_UNAVAILABLE' }))
    for (const tool of generation.data.tools ?? []) await run('tools', app, () => installSetupTool(app, tool.id, { setupId, versions }))
  }
  return finish({ code: rows.every(row => row.code === 'OK') ? 'OK' : 'DEFAULTS_PARTIAL', source, names, rows })
}

/** Internal desktop child invocation: no socket, profile reads or native prompts of its own. */
export async function runSetupDefaultsCommand(argv) {
  if (argv.length !== 3 || argv[0] !== '--request' || argv[2] !== '--json' || argv[1].length > 16_384) return 2
  let request
  try { request = JSON.parse(argv[1]) } catch { return 2 }
  const result = await coordinateSetupDefaults(request)
  process.stdout.write(`${JSON.stringify(result)}\n`)
  return result.code === 'OK' ? 0 : 1
}
