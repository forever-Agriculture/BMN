// MODULE: setup-status.ts - Setup completion follows approved members and settled defaults; a partial result stays visible
import { SETUP_APPS, type SetupAppsSnapshot, type SetupDefaultsReport } from '@bmn/protocol'

export interface SetupTeamStatus { members: readonly string[] | null; pending: boolean }

export function setupStatus(apps: SetupAppsSnapshot | undefined, team: SetupTeamStatus | undefined, defaults: SetupDefaultsReport | null | undefined): {
  team: string; defaults: string; canFinish: boolean; recoveryPaths: string[]
} {
  const ready = apps?.apps.filter(row => ['ready', 'confirmed'].includes(row.signIn)).map(row => row.app) ?? []
  const members = team?.members?.filter(app => SETUP_APPS.includes(app as typeof SETUP_APPS[number])) ?? []
  const covered = ready.every(app => members.includes(app))
  const approved = team?.members !== null && team?.members !== undefined && members.length > 0 && !team.pending
  const installed = defaults?.rows.filter(row => row.state !== 'recovery') ?? []
  const kinds = ['rules', 'skills', 'hooks', 'tools']
  const complete = defaults?.code === 'OK' && ready.length > 0 && installed.some(row => row.kind === 'master' && row.code === 'OK') &&
    ready.every(app => kinds.every(kind => installed.some(row => row.app === app && row.kind === kind && row.code === 'OK')))
  // Approved design (79.2 notes): Finish follows settled steps; a failed default keeps its row and its retry in Health.
  const settled = complete || defaults?.code === 'DEFAULTS_PARTIAL' && ready.length > 0 && installed.some(row => row.kind === 'master') &&
    ready.every(app => kinds.every(kind => installed.some(row => row.app === app && row.kind === kind)))
  const teamWords = !team ? 'Checking…' : team.pending ? 'Changes need approval'
    : team.members === null ? ready.length ? 'Ready apps need a team' : 'Waiting for a ready app'
      : !members.length ? 'The team needs a member' : !covered ? 'A ready app needs a team member'
        : `Approved · ${members.length} ${members.length === 1 ? 'member' : 'members'}`
  const defaultWords = !defaults ? 'Checking…' : ['NOT_APPROVED', 'WAITING_FOR_TEAM'].includes(defaults.code) ? 'Waiting for team approval'
    : defaults.code !== 'OK' || ready.length > 0 && !complete ? 'Some defaults need attention'
      : !ready.length ? 'Waiting for a ready app' : `Ready for ${ready.length} ${ready.length === 1 ? 'app' : 'apps'}`
  return { team: teamWords, defaults: defaultWords, canFinish: Boolean(approved && covered && settled),
    recoveryPaths: [...new Set(defaults?.rows.flatMap(row => row.recoveryPaths) ?? [])] }
}
