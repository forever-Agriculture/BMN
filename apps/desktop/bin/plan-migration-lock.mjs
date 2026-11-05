// MODULE: plan-migration-lock.mjs - Epic 107 one common Git lease for installed writers and migration recovery
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { PlanError } from './plan-board.mjs'
import { lockBoard } from './plan-cli.mjs'

export function migrationPaths(repo) {
  const result = spawnSync('git', ['-C', repo, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' })
  if (result.status !== 0) throw new PlanError('NO_REPOSITORY', 'the migration writer lease needs the project Git repository')
  const common = resolve(repo, result.stdout.trim()), folder = join(common, 'bmn-plan-cutover')
  return { common, folder, journal: join(folder, 'state.json'), lock: join(common, '.bmn-plan-cutover.lock') }
}

export async function withMigrationWriter(repo, operation, { waitMs = 60_000 } = {}) {
  const paths = migrationPaths(repo), release = await lockBoard(join(paths.common, 'bmn-plan-cutover'), { waitMs })
  try {
    const state = existsSync(paths.journal) ? JSON.parse(readFileSync(paths.journal, 'utf8')) : null
    if (state?.fenced || state?.restore_errors?.length) throw new PlanError('RECOVERY_REQUIRED', `permission recovery is incomplete; rerun migration for ${repo}`)
    if (state?.rollback_commit && state.phase !== 'rolled-back') throw new PlanError('ROLLBACK_INTERRUPTED', 'rollback must finish its journal before another writer starts')
    const committed = state?.switch_commit && spawnSync('git', ['-C', repo, 'merge-base', '--is-ancestor', state.switch_commit, 'HEAD']).status === 0
    if (state?.switch_commit && !committed && existsSync(join(repo, 'plan'))) throw new PlanError('MIGRATION_INTERRUPTED', 'the installed plan is waiting for its recorded commit; rerun migration before writing')
    return await operation()
  } finally { release() }
}
