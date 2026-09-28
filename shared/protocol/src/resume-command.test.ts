// MODULE: resume-command.test.ts - the rules a reported resume command must meet (Story 43.1 AC2)
import { describe, expect, it } from 'vitest'
import {
  REPORTED_RESUME_MAX_ARGUMENTS,
  REPORTED_RESUME_MAX_ARGUMENT_BYTES,
  isReportedResumePreview,
  isSessionRecord,
  parseReportedResumeCommand,
  reportedResumeArgvProblem,
  type ConversationResumePreview,
  type ReportedResumePreview,
  type SessionRecord
} from './index'

describe('what a program may report as its resume command', () => {
  it('accepts a plain name with its arguments, empty ones included', () => {
    expect(reportedResumeArgvProblem(['my-agent', '--resume', 'ses 1', '', 'model=é'])).toBeNull()
  })

  it.each([
    ['nothing', [], 'The command is missing'],
    ['not a list', 'my-agent --resume', 'The command is missing'],
    ['a path', ['/usr/local/bin/my-agent'], 'plain command name found on PATH, not a path: "/usr/local/bin/my-agent"'],
    ['a relative path', ['./my-agent'], 'not a path'],
    ['an empty name', [''], 'not a path: ""'],
    ['a dot', ['..'], 'not a path'],
    ['too many parts', Array.from({ length: REPORTED_RESUME_MAX_ARGUMENTS + 1 }, () => 'x'), 'has 65 parts; at most 64'],
    ['a part that is not text', ['my-agent', 7], 'Part 2 of the command is not text'],
    ['an oversized part', ['my-agent', 'é'.repeat(REPORTED_RESUME_MAX_ARGUMENT_BYTES / 2 + 1)], 'Part 2 of the command is 1026 bytes; each may be at most 1024'],
    ['too much in all', ['my-agent', ...Array.from({ length: 9 }, () => 'x'.repeat(1000))], 'is 9008 bytes in all; at most 8192'],
    ['a control character', ['my-agent', 'a\nb'], 'Part 2 of the command contains a control or invisible formatting character'],
    ['a direction override', ['my-agent', 'safe\u202Eexe'], 'contains a control or invisible formatting character'],
    ['a zero-width joiner', ['my-agent', 'a\u200Db'], 'contains a control or invisible formatting character']
  ])('refuses %s, naming the rule', (_label, argv, rule) => {
    expect(reportedResumeArgvProblem(argv)).toContain(rule)
  })

  it('reads a stored command back only when it still meets the rules', () => {
    expect(parseReportedResumeCommand({ argv: ['my-agent', '-r'], reportedAt: '2026-09-29T10:15:00.000Z', incarnationId: 'i-1' }))
      .toEqual({ argv: ['my-agent', '-r'], reportedAt: '2026-09-29T10:15:00.000Z' })
    expect(parseReportedResumeCommand({ argv: ['/bin/sh'], reportedAt: '2026-09-29T10:15:00.000Z' })).toBeNull()
    expect(parseReportedResumeCommand({ argv: ['my-agent'], reportedAt: 'yesterday' })).toBeNull()
    expect(parseReportedResumeCommand(null)).toBeNull()
  })

  it('lets a session record carry one, and refuses a record whose command breaks the rules', () => {
    const record: SessionRecord = {
      sessionId: 'session-1', workspaceId: 'workspace-1', name: 'Wrapper', cwd: '/work', executable: '/bin/bash', argv: [],
      position: 0, backgroundChoice: null, terminalGraphics: null, revision: 1, createdAt: '2026-09-29T10:00:00.000Z',
      archivedAt: null, lastProcess: null
    }
    expect(isSessionRecord(record)).toBe(true)
    expect(isSessionRecord({ ...record, reportedResume: { argv: ['my-agent'], reportedAt: '2026-09-29T10:15:00.000Z' } })).toBe(true)
    expect(isSessionRecord({ ...record, reportedResume: { argv: ['/bin/sh'], reportedAt: '2026-09-29T10:15:00.000Z' } })).toBe(false)
  })

  it('tells a reported preview from a conversation one', () => {
    const reported: ReportedResumePreview = {
      sessionId: 'session-1', source: 'reported', argv: ['my-agent'], program: '/usr/bin/my-agent', cwd: '/work',
      reportedAt: '2026-09-29T10:15:00.000Z', command: '/usr/bin/my-agent', refusal: null
    }
    const conversation: ConversationResumePreview = {
      sessionId: 'session-1', agentCli: 'codex', conversationReference: '01a0b657-0000-4000-8000-000000000001',
      command: '/usr/bin/codex resume 01a0b657-0000-4000-8000-000000000001', notCarried: ''
    }
    expect(isReportedResumePreview(reported)).toBe(true)
    expect(isReportedResumePreview(conversation)).toBe(false)
  })
})
