import { describe, expect, it, vi } from 'vitest'
import type { ConversationResumePreview, MissingConversationBinding } from '@bmn/protocol'
import {
  conversationBindingPresentation,
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

  it('names OpenCode and shows its own session command', () => {
    const shown = resumeConfirmationPresentation({
      ...preview,
      agentCli: 'opencode',
      conversationReference: 'ses_f5656e404ffehVbLiXJ8YHJQjV',
      command: '/usr/bin/opencode --session ses_f5656e404ffehVbLiXJ8YHJQjV --model provider/model',
      notCarried: '--prompt'
    }, 'Research')
    expect(shown).toEqual({
      message: 'Resume the OpenCode conversation in "Research". This command runs:',
      command: '/usr/bin/opencode --session ses_f5656e404ffehVbLiXJ8YHJQjV --model provider/model',
      notCarried: { names: '--prompt', reason: 'opencode resume does not accept them.' }
    })
  })
})
