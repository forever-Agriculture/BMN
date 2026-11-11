// MODULE: agent-team.test.ts - bounded whole-line team context and public-only disclosure (Epic 115)
import { describe, expect, it } from 'vitest'
import { AGENT_TEAM_LIMIT, AGENT_TEAM_POINTER, AGENT_TEAM_ROUTE, agentTeamBlock, agentTeamNotice } from './agent-team'

describe('the session team block', () => {
  for (const count of [3, 8, 40]) {
    const roles = Array.from({ length: count }, (_, index) => ({ id: `role-${index}`, candidates: ['second-configured', 'first-configured'] }))
    it(`keeps ${count} roles in configured order, whole lines, within 900 characters`, () => {
      const { block } = agentTeamBlock(142, roles, true)
      const lines = block.split('\n')
      expect(block.length).toBeLessThanOrEqual(AGENT_TEAM_LIMIT)
      expect(lines[0]).toBe('BMN team: approved version 142')
      expect(lines[1]).toBe(AGENT_TEAM_ROUTE)
      expect(lines.at(-1)).toBe(AGENT_TEAM_POINTER)
      const included = lines.slice(2, lines.at(-2) === 'more: bmn roster' ? -2 : -1)
      expect(included).toEqual(roles.slice(0, included.length).map(role => `${role.id} (configured order): second-configured, first-configured`))
      expect(included.length === count || lines.at(-2) === 'more: bmn roster').toBe(true)
    })
    it(`discloses no roster field for a public-only app with ${count} roles`, () => {
      const team = agentTeamBlock(142, roles, false)
      expect(team.block.split('\n')).toEqual(['BMN team: approved version 142', AGENT_TEAM_ROUTE, AGENT_TEAM_POINTER])
      expect(team.block).not.toMatch(/second-configured|first-configured|role-\d/u)
      expect(agentTeamNotice(team)).toBe(`[Context from BMN, not a new task.]\n${team.block}`)
    })
  }
  it('omits an oversized first line whole and keeps the mandatory lines', () => {
    const team = agentTeamBlock(Number.MAX_SAFE_INTEGER, [{ id: 'huge', candidates: ['x'.repeat(2000)] }], true)
    expect(team.block.length).toBeLessThanOrEqual(900)
    expect(team.block.split('\n')).toEqual([`BMN team: approved version ${Number.MAX_SAFE_INTEGER}`, AGENT_TEAM_ROUTE, 'more: bmn roster', AGENT_TEAM_POINTER])
  })
})
