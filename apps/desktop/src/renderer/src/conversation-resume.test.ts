import { describe, expect, it, vi } from 'vitest'
import type {
  ConversationBindingState,
  ConversationResumePreview,
  MissingConversationBinding,
  ReportedResumePreview
} from '@bmn/protocol'
import {
  conversationBindingPresentation,
  reportedResumeConfirmation,
  reportedResumeLine,
  resumeAvailable,
  resumeBoundConversation,
  resumeConfirmationPresentation
} from './conversation-resume'

describe('visible conversation resume decisions', () => {
  it('surfaces a missing reference and never invokes the resume process action', async () => {
    const binding: MissingConversationBinding = {
      sessionId: 'session-1',
      agentCli: 'claude',
      status: 'missing',
      conversationReference: '11111111-1111-4111-8111-111111111111',
      captureRoute: 'claude-session-id',
      launchContext: {
        cwd: '/workspace',
        executable: '/usr/bin/claude',
        argv: [],
        environment: {}
      },
      detail: 'The bound Claude conversation reference is missing; no process was started',
      capturedAt: '2026-09-12T12:00:00.000Z'
    }
    const resume = vi.fn(async () => ({ incarnationId: 'new-process' }))

    expect(conversationBindingPresentation(binding)).toEqual({
      label: 'Chat unavailable',
      detail: binding.detail,
      canResume: false,
      canLocate: true,
      canStartNew: true
    })
    await expect(resumeBoundConversation(binding, resume)).resolves.toEqual({
      started: false,
      message: binding.detail
    })
    expect(resume).not.toHaveBeenCalled()
  })
})

describe('the confirmation shown before Resume starts anything', () => {
  const preview: ConversationResumePreview = {
    sessionId: 'session-1',
    agentCli: 'codex',
    conversationReference: '01a0b657-0000-4000-8000-000000000001',
    command: '/usr/bin/codex resume 01a0b657-0000-4000-8000-000000000001 --model gpt-6',
    notCarried: '--search, 1 positional argument'
  }

  it('shows the utility\u2019s own command untouched, and names what is left behind', () => {
    expect(resumeConfirmationPresentation(preview, 'BMN lead')).toEqual({
      message: 'Resume the Codex conversation in "BMN lead". This command runs:',
      command: preview.command,
      notCarried: { names: '--search, 1 positional argument', reason: 'codex resume does not accept them.' }
    })
  })

  it('says nothing about dropped arguments when everything is carried', () => {
    expect(resumeConfirmationPresentation({ ...preview, notCarried: '' }, 'BMN lead').notCarried)
      .toBeNull()
  })

  it('names Claude Code by the name the owner knows it by', () => {
    expect(resumeConfirmationPresentation({ ...preview, agentCli: 'claude' }, 'Review').message)
      .toBe('Resume the Claude Code conversation in "Review". This command runs:')
  })

  it('names Cursor and says BMN chose what to leave behind', () => {
    const cursor = { ...preview, agentCli: 'cursor' as const, command: '/usr/bin/cursor-agent --resume=c741bb07-352f-457b-8e7c-ee00517cd9ff', notCarried: '--force' }
    expect(resumeConfirmationPresentation(cursor, 'Cursor')).toEqual({
      message: 'Resume the Cursor conversation in "Cursor". This command runs:',
      command: cursor.command,
      notCarried: { names: '--force', reason: 'BMN carries only --model and --workspace into cursor-agent --resume.' }
    })
  })

  it('names OpenCode and shows its own session command', () => {
    const shown = resumeConfirmationPresentation({
      ...preview,
      agentCli: 'opencode',
      conversationReference: 'ses_0123456789abSyntheticTest0',
      command: '/usr/bin/opencode --session ses_0123456789abSyntheticTest0 --model provider/model',
      notCarried: '--prompt'
    }, 'Research')
    expect(shown).toEqual({
      message: 'Resume the OpenCode conversation in "Research". This command runs:',
      command: '/usr/bin/opencode --session ses_0123456789abSyntheticTest0 --model provider/model',
      notCarried: { names: '--prompt', reason: 'opencode resume does not accept them.' }
    })
  })
})

describe('Resume for a command a program reported (Epic 43)', () => {
  const launchContext = { cwd: '/work', executable: '/bin/bash', argv: [], environment: {} }
  const none: ConversationBindingState = {
    sessionId: 'session-1', agentCli: 'other', status: 'unsupported', captureRoute: 'unsupported', launchContext,
    detail: 'No conversation binding was captured for this session', capturedAt: '2026-09-29T10:00:00.000Z'
  }
  const bound: ConversationBindingState = {
    sessionId: 'session-1', agentCli: 'codex', status: 'bound', conversationReference: '01a0b657-0000-4000-8000-000000000001',
    captureRoute: 'hook-session-start', launchContext, detail: 'Reported by Codex', capturedAt: '2026-09-29T10:00:00.000Z'
  }
  const missing: ConversationBindingState = { ...bound, status: 'missing' } as ConversationBindingState
  const processStatus = (state: 'live' | 'exited' | 'interrupted') =>
    ({ incarnationId: 'i-1', state, exitCode: null, signal: null, detail: null })
  const reportedResume = { argv: ['my-agent', '--resume', 'ses 1'], reportedAt: '2026-09-29T10:15:00.000Z' }
  const reported = { reportedResume, lastProcess: processStatus('exited') }

  it('offers Resume in the host\'s own order: a captured conversation, else a stopped session\'s reported command', () => {
    expect(resumeAvailable(bound, reported, undefined)).toBe(true)
    expect(resumeAvailable(bound, { lastProcess: processStatus('live') }, 'i-1')).toBe(true)
    expect(resumeAvailable(none, reported, undefined)).toBe(true)
    expect(resumeAvailable(none, { reportedResume, lastProcess: processStatus('interrupted') }, undefined)).toBe(true)
    // A captured conversation that went missing is still the conversation; nothing reported is nothing to offer.
    expect(resumeAvailable(missing, reported, undefined)).toBe(false)
    expect(resumeAvailable(none, { lastProcess: processStatus('exited') }, undefined)).toBe(false)
    expect(resumeAvailable(undefined, reported, undefined)).toBe(false)
  })

  it('offers a reported command once the program has ended, even while its pane still shows the output', () => {
    // The program exited by itself: the window keeps the pane, and the record says that very process ended.
    expect(resumeAvailable(none, reported, 'i-1')).toBe(true)
    // Still running, or a newer process started that the record has not caught up with: nothing to resume.
    expect(resumeAvailable(none, { reportedResume, lastProcess: processStatus('live') }, 'i-1')).toBe(false)
    expect(resumeAvailable(none, reported, 'i-2')).toBe(false)
  })

  it('shows the command exactly as reported in Session details, with the time', () => {
    const line = reportedResumeLine(reported.reportedResume)
    expect(line.label).toBe('Resume command reported by the program:')
    expect(line.argv).toBe("my-agent --resume 'ses 1'")
    expect(line.when).toMatch(/^at \d\d:\d\d$/)
  })

  it('says what runs, where, and who reported it; a program no longer on PATH gets its reason', () => {
    const preview: ReportedResumePreview = {
      sessionId: 'session-1', source: 'reported', argv: ['my-agent', '--resume', 'ses 1'], program: '/opt/bin/my-agent',
      cwd: '/work/app', reportedAt: '2026-09-29T10:15:00.000Z', command: "/opt/bin/my-agent --resume \"ses 1\"", refusal: null
    }
    const shown = reportedResumeConfirmation(preview, 'Wrapper')
    expect(shown).toMatchObject({
      message: 'Resume "Wrapper" with the command a program in it reported. This command runs:',
      argv: "my-agent --resume 'ses 1'",
      program: '/opt/bin/my-agent',
      folder: '/work/app',
      refusal: null
    })
    expect(shown.provenance).toMatch(/^Reported by the program in this session at \d\d:\d\d$/)
    const refused = reportedResumeConfirmation({ ...preview, program: null, command: '', refusal: 'gone' }, 'Wrapper')
    expect(refused).toMatchObject({ program: null, refusal: 'gone' })
    expect(refused.message).toBe('"Wrapper" cannot be resumed with the command a program in it reported:')
  })
})
