import type { AttentionRecord } from '@bmn/protocol'
import { describe, expect, it, vi } from 'vitest'
import { copyAttentionAnswer, dismissAttentionReminder } from './attention-actions'

const question: AttentionRecord = {
  requestId: 'question-synthetic', sessionId: 'source', incarnationId: 'run-one', requestKey: 'question',
  kind: 'question', title: 'Which color?', body: null, state: 'open', resolution: null,
  openedAt: '2026-09-30T00:00:00.000Z', expiresAt: null, resolvedAt: null, seenAt: null,
  revision: 3, openedBy: 'hook:codex:PreToolUse', resolvedBy: null,
  prompt: { type: 'questions', harness: 'codex', shape: 'async-choice', requestRef: null,
    toolUseId: 'call-synthetic', questions: [{ id: 'color', header: null, text: 'Which color?',
      multiSelect: false, options: [{ label: 'Gold', description: null }] }] }
}

function bridge() {
  return {
    listAttention: vi.fn(async () => [question]),
    writeClipboardText: vi.fn(async () => ({ written: true as const })),
    resolveAttention: vi.fn(async (): Promise<AttentionRecord> => ({ ...question, state: 'withdrawn' }))
  }
}

describe('owner attention actions', () => {
  it('dismisses only the reviewed revision without recording an answer or granting permission', async () => {
    const api = bridge()
    await dismissAttentionReminder(api, { ...question, kind: 'permission' })
    expect(api.resolveAttention).toHaveBeenCalledExactlyOnceWith(question.requestId, 'Dismissed in BMN',
      { kind: 'permission', revision: 3 }, 'owner', 'withdrawn')
    expect(api.writeClipboardText).not.toHaveBeenCalled()
  })

  it('copies exact text, then clears the reminder with a not-submitted disposition', async () => {
    const api = bridge()
    await copyAttentionAnswer(api, question, 'Gold')
    expect(api.writeClipboardText).toHaveBeenCalledExactlyOnceWith('Gold')
    expect(api.resolveAttention).toHaveBeenCalledExactlyOnceWith(question.requestId, 'Answer copied; not submitted',
      { kind: 'question', revision: 3 }, 'owner', 'withdrawn')
    expect(api.writeClipboardText.mock.invocationCallOrder[0]).toBeLessThan(api.resolveAttention.mock.invocationCallOrder[0]!)
  })

  it('coalesces rapid repeated dismissal of the same revision', async () => {
    const api = bridge()
    let finish!: (record: AttentionRecord) => void
    api.resolveAttention.mockReturnValue(new Promise((resolve) => { finish = resolve }))
    const first = dismissAttentionReminder(api, question)
    const second = dismissAttentionReminder(api, question)
    expect(api.resolveAttention).toHaveBeenCalledOnce()
    finish({ ...question, state: 'withdrawn' })
    await Promise.all([first, second])
  })

  it.each([
    { ...question, revision: 4 }, { ...question, state: 'withdrawn' as const },
    { ...question, incarnationId: 'run-two' }, { ...question, kind: 'permission' as const },
    { ...question, prompt: null }
  ])('refuses changed or unavailable questions before copying', async (current) => {
    const api = bridge()
    api.listAttention.mockResolvedValue([current])
    await expect(copyAttentionAnswer(api, question, 'Gold')).rejects.toThrow('question changed')
    expect(api.writeClipboardText).not.toHaveBeenCalled()
    expect(api.resolveAttention).not.toHaveBeenCalled()
  })

  it('retains the reminder and draft when the clipboard fails', async () => {
    const api = bridge()
    api.writeClipboardText.mockRejectedValue(new Error('Clipboard unavailable'))
    await expect(copyAttentionAnswer(api, question, 'Gold')).rejects.toThrow('Clipboard unavailable')
    expect(api.resolveAttention).not.toHaveBeenCalled()
  })

  it('reports a successful copy truthfully when a revised reminder refuses dismissal', async () => {
    const api = bridge()
    api.resolveAttention.mockRejectedValue(new Error('Revision changed'))
    await expect(copyAttentionAnswer(api, question, 'Gold')).rejects.toThrow('Answer copied. The reminder could not be cleared')
    expect(api.writeClipboardText).toHaveBeenCalledExactlyOnceWith('Gold')
  })
})
