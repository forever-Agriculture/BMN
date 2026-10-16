// MODULE: agent-briefs.test.ts - BMN's start brief is handed once per conversation and once after each compaction (Story 75.6)
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { AGENT_START_BRIEF } from '@bmn/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import { AGENT_BRIEF_COMPACT_SAME_MS, AGENT_BRIEF_REMEMBERED, AgentBriefs, type AgentBriefEvent } from './agent-briefs'

const CONVERSATION = '0a0a0a0a-1b1b-2c2c-3d3d-4e4e4e4e4e4e'
const OTHER = '9f9f9f9f-1b1b-2c2c-3d3d-4e4e4e4e4e4e'

describe('BMN briefs a conversation once (Story 75.6)', () => {
  let now = 1_000_000
  let live: string | null = 'incarnation-1'
  let briefs: AgentBriefs
  beforeEach(() => {
    now = 1_000_000
    live = 'incarnation-1'
    briefs = new AgentBriefs({ liveIncarnationId: () => live, now: () => now })
  })
  const start = (source: string | null, more: Partial<AgentBriefEvent> = {}): AgentBriefEvent => ({
    sessionId: 'session-1', incarnationId: 'incarnation-1', agent: 'claude', event: 'SessionStart', source,
    turn: { conversation: CONVERSATION, nested: false }, ...more
  })
  const other = { turn: { conversation: OTHER, nested: false } }

  it.each(['claude', 'codex'])('hands %s the brief at a new conversation\'s start and never again for it', (agent) => {
    expect(briefs.answer(start('startup', { agent }))).toBe(AGENT_START_BRIEF)
    // A second hook entry reporting the same start gets nothing; so does a resume of it.
    expect(briefs.answer(start('startup', { agent }))).toBeNull()
    expect(briefs.answer(start('resume', { agent }))).toBeNull()
  })

  it('briefs a cleared conversation, which starts empty under a new id', () => {
    expect(briefs.answer(start('clear'))).toBe(AGENT_START_BRIEF)
  })

  it('never briefs a resumed or forked conversation, which holds what it was told', () => {
    expect(briefs.answer(start('resume'))).toBeNull()
    expect(briefs.answer(start('fork', other))).toBeNull()
    expect(briefs.answer(start('resume', other))).toBeNull()
    // The same conversation id in another session, or for another app, is another conversation.
    expect(briefs.answer(start('startup', { sessionId: 'session-2' }))).toBe(AGENT_START_BRIEF)
    expect(briefs.answer(start('startup', { agent: 'codex' }))).toBe(AGENT_START_BRIEF)
  })

  it('briefs once more after each compaction, counting one compaction\'s repeated starts once', () => {
    expect(briefs.answer(start('startup'))).toBe(AGENT_START_BRIEF)
    now += 5 * 60_000
    expect(briefs.answer(start('compact'))).toBe(AGENT_START_BRIEF)
    now += 1_000
    expect(briefs.answer(start('compact'))).toBeNull()
    now += AGENT_BRIEF_COMPACT_SAME_MS
    expect(briefs.answer(start('compact'))).toBe(AGENT_START_BRIEF)
    // A conversation resumed before BMN knew it loses the brief to a compaction as well.
    expect(briefs.answer(start('resume', other))).toBeNull()
    expect(briefs.answer(start('compact', other))).toBe(AGENT_START_BRIEF)
  })

  it.each([['a prompt', 'UserPromptSubmit'], ['a tool call', 'PostToolUse'], ['the next compaction\'s own event', 'PreCompact'], ['Codex\'s PostCompact', 'PostCompact']])(
    'briefs two compactions under a minute apart when %s lies between them', (_what, event) => {
      expect(briefs.answer(start('startup'))).toBe(AGENT_START_BRIEF)
      expect(briefs.answer(start('compact'))).toBe(AGENT_START_BRIEF)
      now += 10_000
      expect(briefs.answer(start(null, { event }))).toBeNull()
      now += 10_000
      expect(briefs.answer(start('compact'))).toBe(AGENT_START_BRIEF)
      // Another conversation's events end nothing of this one.
      now += 1_000
      expect(briefs.answer(start(null, { event, ...other }))).toBeNull()
      expect(briefs.answer(start('compact'))).toBeNull()
    })

  it('counts repeated reports of one compaction once, without stretching it', () => {
    expect(briefs.answer(start('compact'))).toBe(AGENT_START_BRIEF)
    now += 40_000
    expect(briefs.answer(start('compact'))).toBeNull()
    // Seventy seconds after the first report and thirty after the repeat: the minute counts from the first.
    now += 30_000
    expect(briefs.answer(start('compact'))).toBe(AGENT_START_BRIEF)
  })

  it('a BMN restart briefs nothing again: a resumed conversation is not briefed, a new one is', () => {
    expect(briefs.answer(start('startup'))).toBe(AGENT_START_BRIEF)
    const restarted = new AgentBriefs({ liveIncarnationId: () => 'incarnation-2', now: () => now })
    expect(restarted.answer(start('resume', { incarnationId: 'incarnation-2' }))).toBeNull()
    expect(restarted.answer(start('startup', { incarnationId: 'incarnation-2', ...other }))).toBe(AGENT_START_BRIEF)
  })

  it('answers no other event: not a prompt, a tool call, a stop or a compaction event of its own', () => {
    for (const event of ['UserPromptSubmit', 'PostToolUse', 'Stop', 'PreCompact', 'PostCompact', 'SessionEnd']) {
      expect(briefs.answer(start('startup', { event }))).toBeNull()
    }
    // None of them counted as the start, which is still briefed.
    expect(briefs.answer(start('startup'))).toBe(AGENT_START_BRIEF)
  })

  it('answers nothing for a sub-agent, an app without a measured path, a start without a conversation or source, or a process that is not live', () => {
    expect(briefs.answer(start('startup', { turn: { conversation: CONVERSATION, nested: true } }))).toBeNull()
    expect(briefs.answer(start('startup', { agent: 'opencode' }))).toBeNull()
    expect(briefs.answer(start('startup', { turn: undefined }))).toBeNull()
    expect(briefs.answer(start(null))).toBeNull()
    expect(briefs.answer(start('startup', { incarnationId: null }))).toBeNull()
    live = 'incarnation-0'
    expect(briefs.answer(start('startup'))).toBeNull()
    // None of those was remembered: the live main conversation's start is briefed.
    live = 'incarnation-1'
    expect(briefs.answer(start('startup'))).toBe(AGENT_START_BRIEF)
  })

  it('remembers a bounded number of conversations, forgetting the oldest first', () => {
    const id = (n: number) => ({ turn: { conversation: `${n.toString(16).padStart(8, '0')}-1b1b-2c2c-3d3d-4e4e4e4e4e4e`, nested: false } })
    for (let n = 0; n <= AGENT_BRIEF_REMEMBERED; n += 1) expect(briefs.answer(start('startup', id(n)))).toBe(AGENT_START_BRIEF)
    expect(briefs.answer(start('startup', id(AGENT_BRIEF_REMEMBERED)))).toBeNull()
    expect(briefs.answer(start('startup', id(1)))).toBeNull()
    // The oldest was forgotten; only a start reported twice that far apart is briefed twice.
    expect(briefs.answer(start('startup', id(0)))).toBe(AGENT_START_BRIEF)
  })
})

it('holds the documented brief and the one BMN hands over to one text', async () => {
  const documentation = await readFile(fileURLToPath(new URL('../../../../docs/agent-control.md', import.meta.url)), 'utf8')
  const fenced = /## BMN's start brief[\s\S]*?```text\n([\s\S]*?)```/.exec(documentation)
  expect(fenced?.[1]).toBe(`${AGENT_START_BRIEF}\n`)
})
