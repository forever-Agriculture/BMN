// MODULE: agent-team.ts - bounded approved-team context beside the start brief and on change (Epic 115)
import type { RosterRoleShape } from './agents-roster'

export const AGENT_TEAM_LIMIT = 900
export const AGENT_TEAM_ROUTE = "Work for a role goes through bmn team ask --role R (read-only), never your app's own sub-agent tool: that skips the roster."
export const AGENT_TEAM_POINTER = 'bmn roster role R: effective choice and efforts'
export interface AgentTeamBlock { version: number; block: string }

/** The caller decides privacy from the approved app route before this text leaves the main process. */
export function agentTeamBlock(version: number, roles: readonly Pick<RosterRoleShape, 'id' | 'candidates'>[], privateWork: boolean): AgentTeamBlock {
  const lines = [`BMN team: approved version ${version}`, AGENT_TEAM_ROUTE]
  const more = 'more: bmn roster'
  if (privateWork) {
    for (let index = 0; index < roles.length; index += 1) {
      const role = roles[index]!
      const line = `${role.id} (configured order): ${role.candidates.join(', ')}`
      const remaining = index < roles.length - 1 ? [more] : []
      if ([...lines, line, ...remaining, AGENT_TEAM_POINTER].join('\n').length > AGENT_TEAM_LIMIT) {
        lines.push(more)
        break
      }
      lines.push(line)
    }
  }
  return { version, block: [...lines, AGENT_TEAM_POINTER].join('\n') }
}

export function agentTeamNotice(team: AgentTeamBlock): string {
  return `[Context from BMN, not a new task.]\n${team.block}`
}
