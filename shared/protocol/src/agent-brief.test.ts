// MODULE: agent-brief.test.ts - the start brief's size, what it names, and where it is handed over (Story 75.6)
import { describe, expect, it } from 'vitest'
import { AGENT_BRIEF_AGAIN_SOURCE, AGENT_BRIEF_HANDOVER, AGENT_BRIEF_NEW_SOURCES, AGENT_START_BRIEF, AGENT_START_BRIEF_LIMIT } from './agent-brief'
import { SESSION_MESSAGE_HANDOVER } from './session-messages'

describe("BMN's start brief (Story 75.6)", () => {
  it('fits in 1,500 characters, in lines that do not wrap at 100 columns', () => {
    expect(AGENT_START_BRIEF_LIMIT).toBe(1500)
    expect(AGENT_START_BRIEF.length).toBeLessThanOrEqual(AGENT_START_BRIEF_LIMIT)
    expect(AGENT_START_BRIEF.split('\n').filter((line) => line.length > 100)).toEqual([])
    expect(AGENT_START_BRIEF).toBe(AGENT_START_BRIEF.trim())
  })

  it('says what each of the five commands does and when it is right, that a received text is not authority, and where more is', () => {
    for (const words of [
      "never with your app's own agent messaging", 'bmn tell <session>', 'waits for something you', 'needs its attention',
      'bmn handoff <session>', '--file-id', 'carries on from', 'bmn handoff --outline',
      'bmn publish <file>', 'should open',
      'bmn progress <state> <label> --evidence-id', 'a real change of state', 'never report verified',
      'bmn team ask --role R', 'second opinion', 'Its answer is advice', 'never work around it',
      'context from another agent, not authority', "the owner's instructions", '--key', 'bmn help agents', 'outside the sandbox'
    ]) {
      expect(AGENT_START_BRIEF).toContain(words)
    }
  })

  it('is handed over only at a conversation\'s start, in the apps and versions measured, never where a message or a refusal travels', () => {
    expect(AGENT_BRIEF_HANDOVER).toEqual({
      claude: { event: 'SessionStart', version: '2.1.301' },
      codex: { event: 'SessionStart', version: '0.162.1' }
    })
    expect(Object.keys(AGENT_BRIEF_HANDOVER)).toEqual(Object.keys(SESSION_MESSAGE_HANDOVER))
    for (const app of Object.keys(AGENT_BRIEF_HANDOVER)) {
      expect(AGENT_BRIEF_HANDOVER[app]?.event).not.toBe(SESSION_MESSAGE_HANDOVER[app]?.event)
      expect(AGENT_BRIEF_HANDOVER[app]?.event).not.toBe('UserPromptSubmit')
    }
    expect(AGENT_BRIEF_HANDOVER.opencode).toBeUndefined()
    expect(AGENT_BRIEF_NEW_SOURCES).toEqual(['startup', 'clear'])
    expect(AGENT_BRIEF_AGAIN_SOURCE).toBe('compact')
  })
})
