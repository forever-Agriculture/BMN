// MODULE: attention-prompt.test.ts - validation and merging of the structured prompts hooks report
import { describe, expect, it } from 'vitest'
import { ATTENTION_PROMPT_LIMITS, mergeSamePrompt, parseAttentionPrompt, readStoredPrompt, type AttentionPrompt } from './attention-prompt'

const question: AttentionPrompt = {
  type: 'questions',
  harness: 'claude',
  shape: 'choice',
  requestRef: null,
  toolUseId: 'toolu_1',
  questions: [{
    id: null,
    header: 'Auth method',
    text: 'Which auth method should the API use?',
    multiSelect: false,
    options: [{ label: 'JWT', description: 'Stateless tokens' }, { label: 'Session cookies', description: null }]
  }]
}

const permission: AttentionPrompt = {
  type: 'permission',
  harness: 'opencode',
  shape: 'permission',
  requestRef: 'per_1',
  toolUseId: null,
  tool: 'bash',
  command: 'touch oc-c.txt',
  cwd: null
}

describe('parseAttentionPrompt', () => {
  it('accepts a question and a permission prompt exactly as stored', () => {
    expect(parseAttentionPrompt(question)).toEqual({ ok: true, value: question })
    expect(parseAttentionPrompt(permission)).toEqual({ ok: true, value: permission })
  })

  it('keeps line breaks in question text and descriptions but no other control', () => {
    const multiline = { ...question, questions: [{ ...question.questions[0], text: 'Line one\nLine two' }] }
    expect(parseAttentionPrompt(multiline).ok).toBe(true)
    const bell = { ...question, questions: [{ ...question.questions[0], text: 'Ring\u0007' }] }
    expect(parseAttentionPrompt(bell)).toEqual({ ok: false, error: 'prompt question text must not contain control characters' })
    const labelBreak = { ...question, questions: [{ ...question.questions[0], options: [{ label: 'A\nB', description: null }] }] }
    expect(parseAttentionPrompt(labelBreak).ok).toBe(false)
  })

  it.each([
    ['an unknown type', { ...question, type: 'survey' }],
    ['an unknown harness', { ...question, harness: 'gemini' }],
    ['a permission shape on questions', { ...question, shape: 'permission' }],
    ['a question shape on a permission', { ...permission, shape: 'choice' }],
    ['an extra key', { ...question, extra: 1 }],
    ['a missing key', Object.fromEntries(Object.entries(question).filter(([key]) => key !== 'toolUseId'))],
    ['no questions', { ...question, questions: [] }],
    ['too many questions', { ...question, questions: Array(ATTENTION_PROMPT_LIMITS.questions + 1).fill(question.questions[0]) }],
    ['an option without a label', { ...question, questions: [{ ...question.questions[0], options: [{ label: '', description: null }] }] }],
    ['a long label', { ...question, questions: [{ ...question.questions[0], options: [{ label: 'x'.repeat(201), description: null }] }] }],
    ['a non-boolean multiSelect', { ...question, questions: [{ ...question.questions[0], multiSelect: 'no' }] }],
    ['an empty tool', { ...permission, tool: '' }],
    ['a long request id', { ...permission, requestRef: 'p'.repeat(129) }],
    ['not an object', 'prompt']
  ])('refuses %s', (_label, value) => {
    expect(parseAttentionPrompt(value).ok).toBe(false)
  })

  it('reads a stored row back, and a row that no longer parses as a plain request', () => {
    expect(readStoredPrompt(JSON.stringify(question))).toEqual(question)
    expect(readStoredPrompt(null)).toBeNull()
    expect(readStoredPrompt('{"type":"survey"}')).toBeNull()
    expect(readStoredPrompt('not json')).toBeNull()
  })
})

describe('mergeSamePrompt', () => {
  it('keeps the tool call id one report of the same dialog knew', () => {
    const fromPermissionRequest = { ...question, toolUseId: null }
    expect(mergeSamePrompt(fromPermissionRequest, question)).toEqual(question)
    expect(mergeSamePrompt(question, fromPermissionRequest)).toEqual(question)
  })

  it('treats different content, or two different known ids, as different dialogs', () => {
    const other = { ...question, questions: [{ ...question.questions[0], text: 'Which database?' }] }
    expect(mergeSamePrompt(question, other)).toBeNull()
    expect(mergeSamePrompt(question, { ...question, toolUseId: 'toolu_2' })).toBeNull()
    expect(mergeSamePrompt(permission, { ...permission, requestRef: 'per_2' })).toBeNull()
  })
})
