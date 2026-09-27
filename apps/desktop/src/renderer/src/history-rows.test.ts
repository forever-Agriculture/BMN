// MODULE: history-rows.test.ts - the words Preferences → History shows, pending and settled, as the Design section draws them
import { describe, expect, it } from 'vitest'
import type { AgentHistoryAgentRow, AgentHistoryClaudeFolder, AgentHistoryStatus } from '@bmn/protocol'
import { agentFailure, agentValue, claudeDaysLabel, confirmSentence, folderValue, keepHelp, shortDate } from './history-rows'

const AT = new Date(2026, 8, 28, 14, 2).toISOString()

function folder(overrides: Partial<AgentHistoryClaudeFolder> = {}): AgentHistoryClaudeFolder {
  return { path: '/h/.claude', name: 'Claude Code', displayPath: '~/.claude', currentDays: null, targetDays: 30, pending: true, ...overrides }
}

function status(overrides: Partial<AgentHistoryStatus> = {}): AgentHistoryStatus {
  return { keepDays: 30, confirmedKeepDays: undefined, needsConfirmation: true, running: false, claude: [], agents: [], ...overrides }
}

const codex: AgentHistoryAgentRow = { agent: 'codex', state: 'managed', sessions: 863, candidates: 412 }

describe('History rows', () => {
  it('shows a pending folder as now → next, with Claude default for an unset value', () => {
    expect(folderValue(folder())).toEqual({ kind: 'pending', now: 'Claude default', next: '30 days' })
    expect(folderValue(folder({ currentDays: 30 }))).toEqual({ kind: 'pending', now: '30 days', next: '30 days' })
    expect(claudeDaysLabel(36_500)).toBe('Never')
  })

  it('shows a settled folder with the date it was applied, ISO in the title', () => {
    expect(folderValue(folder({ currentDays: 30, pending: false, applied: { days: 30, at: AT } })))
      .toEqual({ kind: 'settled', text: '30 days · applied 28 Sep', title: AT })
    expect(shortDate(AT)).toBe('28 Sep')
  })

  it('counts what a confirmation would delete, then what the run did', () => {
    expect(agentValue(codex, status())).toEqual({ kind: 'settled', text: '412 to delete' })
    const settled = status({ needsConfirmation: false, confirmedKeepDays: 30 })
    expect(agentValue({ ...codex, lastRun: { at: AT, deleted: 200, remaining: 212, failures: [] } }, settled))
      .toEqual({ kind: 'settled', text: '200 deleted 28 Sep 14:02 · 212 next run', title: AT })
    expect(agentValue({ ...codex, candidates: 0 }, settled)).toEqual({ kind: 'settled', text: 'nothing to delete' })
  })

  it('puts failures on a second line that starts with the count and keeps detail in the title', () => {
    expect(agentFailure({ ...codex, lastRun: { at: AT, deleted: 3, remaining: 0, failures: [{ id: 'a', reason: 'session is open elsewhere' }] } }))
      .toEqual({ text: '1 failed: session is open elsewhere', title: 'a: session is open elsewhere' })
    expect(agentFailure({ agent: 'opencode', state: 'unrecognised', detail: 'session has no time_updated' }))
      .toEqual({ text: 'not recognised: session has no time_updated', title: 'session has no time_updated' })
    expect(agentFailure(codex)).toBeNull()
  })

  it('writes one confirm sentence with counts, and says batches past 200', () => {
    expect(confirmSentence(status({ claude: [folder()], agents: [codex, { agent: 'opencode', state: 'managed', sessions: 8, candidates: 3 }] })))
      .toBe('Sets 1 Claude folder to 30 days; deletes 415 sessions for good, in batches of 200.')
    expect(confirmSentence(status({ agents: [{ ...codex, candidates: 3 }] }))).toBe('Deletes 3 sessions for good.')
    expect(confirmSentence(status({ claude: [folder(), folder({ path: '/g' })] }))).toBe('Sets 2 Claude folders to 30 days.')
    expect(confirmSentence(status({ keepDays: null, agents: [codex] }))).toBe('Applies Never to every agent.')
  })

  it('says which limit stays in force while a shorter one waits', () => {
    expect(keepHelp(status({ keepDays: 7, confirmedKeepDays: 30 }))).toBe('30 days stays in force until you confirm 7 days.')
    expect(keepHelp(status())).toBe('Each agent deletes sessions untouched longer.')
  })
})

describe('Cursor\'s history row (Story 31.3 AC3)', () => {
  it('reads "keeps its own history · not managed by BMN" with its reason as the title', () => {
    const row: AgentHistoryAgentRow = { agent: 'cursor', state: 'own', detail: 'Cursor has no command to delete a chat' }
    const status: AgentHistoryStatus = { keepDays: 30, confirmedKeepDays: 30, needsConfirmation: false, running: false, claude: [], agents: [row] }
    expect(agentValue(row, status)).toEqual({
      kind: 'settled', text: 'keeps its own history · not managed by BMN', title: 'Cursor has no command to delete a chat'
    })
    expect(agentFailure(row)).toBeNull()
  })
})
