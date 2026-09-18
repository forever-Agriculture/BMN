import { describe, expect, it, vi } from 'vitest'
import type { MissingConversationBinding } from '@bmn/protocol'
import {
  conversationBindingPresentation,
  resumeBoundConversation
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
