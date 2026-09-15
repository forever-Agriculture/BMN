import { describe, expect, it, vi } from 'vitest'
import {
  METHOD_REGISTRY,
  type BoundConversationBinding,
  type ExplicitConversationBinding
} from '@ai-terminal/protocol'
import {
  activateBoundSession,
  loadConversationBinding,
  locateConversationBinding,
  resumeBoundSession,
  startNewConversation
} from './conversation-resume-ipc'

const binding: BoundConversationBinding = {
  sessionId: 'session-1',
  agentCli: 'claude',
  status: 'bound',
  conversationReference: '11111111-1111-4111-8111-111111111111',
  captureRoute: 'claude-session-id',
  launchContext: {
    cwd: '/workspace',
    executable: '/usr/bin/claude',
    argv: ['--model', 'sonnet'],
    environment: {}
  },
  detail: 'pinned before spawn',
  capturedAt: '2026-09-12T12:00:00.000Z'
}

describe('conversation resume main-process routing', () => {
  it('gets binding, consumes the host resume attachment, then activates it', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === METHOD_REGISTRY.sessionBindingGet) return binding
      if (method === METHOD_REGISTRY.sessionResume) {
        return {
          sessionId: 'session-1',
          incarnationId: 'incarnation-2',
          attachmentId: 'attachment-2',
          streamSeq: 0,
          captureStartedAt: '2026-09-13T10:00:00.000Z',
          binding
        }
      }
      return { activated: true }
    })
    const client = { request } as never

    await expect(loadConversationBinding(client, 'session-1')).resolves.toEqual(binding)
    const resumed = await resumeBoundSession(client, 'session-1', { cols: 100, rows: 35 })
    await expect(activateBoundSession(client, resumed.attachmentId)).resolves.toEqual({ activated: true })

    expect(request.mock.calls).toEqual([
      [METHOD_REGISTRY.sessionBindingGet, { sessionId: 'session-1' }],
      [METHOD_REGISTRY.sessionResume, { sessionId: 'session-1', cols: 100, rows: 35 }],
      [METHOD_REGISTRY.terminalActivate, { attachmentId: 'attachment-2' }]
    ])
  })

  it('propagates a host resume refusal without attaching or compensating with stop', async () => {
    const request = vi.fn(async (method: string) => {
      if (method === METHOD_REGISTRY.sessionResume) {
        throw new Error('The bound conversation is already resuming or starting')
      }
      throw new Error(`unexpected method ${method}`)
    })
    const client = { request } as never

    await expect(
      resumeBoundSession(client, 'session-1', { cols: 80, rows: 24 })
    ).rejects.toThrow(/already resuming/)
    expect(request.mock.calls).toEqual([
      [METHOD_REGISTRY.sessionResume, { sessionId: 'session-1', cols: 80, rows: 24 }]
    ])
    expect(request.mock.calls.filter(([method]) => method === METHOD_REGISTRY.sessionStop)).toEqual([])
  })

  it('locates chat A without changing chat B and Start new clears only its own row', async () => {
    const rows = new Map<string, string>([
      ['session-a', JSON.stringify(binding)],
      ['session-b', JSON.stringify({ ...binding, sessionId: 'session-b', conversationReference: '22222222-2222-4222-8222-222222222222' })]
    ])
    const beforeB = rows.get('session-b')
    const replacement: ExplicitConversationBinding = {
      ...binding,
      sessionId: 'session-a',
      conversationReference: '33333333-3333-4333-8333-333333333333',
      captureRoute: 'explicit-resume-reference'
    }
    const client = {
      async request(method: string, params: object): Promise<unknown> {
        if (method === METHOD_REGISTRY.sessionBindingReplace) {
          const next = (params as { binding: ExplicitConversationBinding }).binding
          rows.set(next.sessionId, JSON.stringify(next))
          return next
        }
        const sessionId = (params as { sessionId: string }).sessionId
        const cleared = rows.delete(sessionId)
        return { cleared }
      }
    } as never

    await expect(locateConversationBinding(client, replacement)).resolves.toEqual(replacement)
    expect(rows.get('session-b')).toBe(beforeB)
    await expect(startNewConversation(client, 'session-a')).resolves.toEqual({ cleared: true })
    expect(rows.has('session-a')).toBe(false)
    expect(rows.get('session-b')).toBe(beforeB)
  })
})
