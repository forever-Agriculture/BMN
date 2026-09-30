// MODULE: attention-prompt.test.ts - validation and merging of the structured prompts hooks report
import { describe, expect, it } from 'vitest'
import { ATTENTION_PROMPT_LIMITS, mergeSamePrompt, parseAttentionEvidence, parseAttentionPrompt, readStoredPrompt, type AttentionPrompt } from './attention-prompt'

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
  it('keeps a Codex Default typed-only question without inventing choices or widening blocking shapes', () => {
    const typed = { ...question, harness: 'codex', shape: 'async-choice', questions: [{ ...question.questions[0], options: [] }] }
    expect(parseAttentionPrompt(typed)).toEqual({ ok: true, value: typed })
    expect(parseAttentionPrompt({ ...typed, shape: 'choice' }).ok).toBe(false)
    expect(parseAttentionPrompt({ ...typed, harness: 'claude' }).ok).toBe(false)
  })
  it('accepts a question and a permission prompt exactly as stored', () => {
    expect(parseAttentionPrompt(question)).toEqual({ ok: true, value: question })
    expect(parseAttentionPrompt(permission)).toEqual({ ok: true, value: permission })
    const described = { ...permission, description: 'Create the file\nfor the test' }
    expect(parseAttentionPrompt(described)).toEqual({ ok: true, value: described })
    expect(parseAttentionPrompt({ ...permission, description: null })).toEqual({ ok: true, value: { ...permission, description: null } })
  })

  it('accepts every harness in the closed list, Cursor included, and nothing else', () => {
    for (const harness of ['claude', 'codex', 'opencode', 'cursor'] as const) {
      expect(parseAttentionPrompt({ ...question, harness })).toEqual({ ok: true, value: { ...question, harness } })
    }
    expect(parseAttentionPrompt({ ...question, harness: 'agent' }).ok).toBe(false)
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
    ['a long description', { ...permission, description: 'd'.repeat(501) }],
    ['a description on questions', { ...question, description: 'Create it' }],
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

describe('parseAttentionEvidence', () => {
  const evidence = { toolUseId: 'toolu_1', requestRef: null, answers: [['JWT']], permission: null, tool: null, command: null }

  it('accepts the evidence a hook sends exactly as given', () => {
    expect(parseAttentionEvidence(evidence)).toEqual({ ok: true, value: evidence })
    const permission = { ...evidence, answers: null, permission: 'allowed', tool: 'Bash', command: 'touch a\nb' }
    expect(parseAttentionEvidence(permission)).toEqual({ ok: true, value: permission })
  })

  it.each([
    ['an extra key', { ...evidence, confirmed: true }],
    ['a missing key', Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== 'command'))],
    ['an unknown permission word', { ...evidence, permission: 'always' }],
    ['an empty label list', { ...evidence, answers: [[]] }],
    ['a label with a control character', { ...evidence, answers: [['J\u0007WT']] }],
    ['too many questions', { ...evidence, answers: Array(ATTENTION_PROMPT_LIMITS.questions + 1).fill(['x']) }],
    ['an answer longer than the bound', { ...evidence, answers: [['x'.repeat(ATTENTION_PROMPT_LIMITS.answer + 1)]] }],
    ['not an object', 'evidence']
  ])('refuses %s', (_label, value) => {
    expect(parseAttentionEvidence(value).ok).toBe(false)
  })

  it('accepts a typed answer or Claude\'s joined labels up to the answer bound (Epic 31)', () => {
    const long = { ...evidence, answers: [['x'.repeat(ATTENTION_PROMPT_LIMITS.answer)], ['None of the above', 'user_note: Passkeys']] }
    expect(parseAttentionEvidence(long)).toEqual({ ok: true, value: long })
  })
})

describe('OpenCode\'s custom flag (Epic 31)', () => {
  it('keeps custom when a question carries it, and still reads prompts stored without it', () => {
    const custom = { ...question, harness: 'opencode', questions: [{ ...question.questions[0]!, custom: false }] }
    expect(parseAttentionPrompt(custom)).toEqual({ ok: true, value: custom })
    expect(parseAttentionPrompt(question)).toEqual({ ok: true, value: question })
    expect(parseAttentionPrompt({ ...question, questions: [{ ...question.questions[0]!, custom: 'no' }] }).ok).toBe(false)
  })
})

describe('format characters in a prompt (Story 34.1)', () => {
  const spoofed = (patch: Record<string, unknown>) => ({
    ...question,
    questions: [{ ...(question as { questions: object[] }).questions[0], ...patch }]
  })

  it('removes them from the header, question text and descriptions, and keeps option labels exact (Astra review)', () => {
    const parsed = parseAttentionPrompt(spoofed({
      header: 'Auth​ method',
      text: 'Which ‮auth‬ method?',
      options: [{ label: 'J⁦WT⁩', description: 'Stateless﻿ tokens' }, { label: 'Keep \u{1F468}‍\u{1F469}', description: null }]
    }))
    expect(parsed.ok && parsed.value.type === 'questions' && parsed.value.questions[0]).toMatchObject({
      header: 'Auth method',
      text: 'Which auth method?',
      options: [{ label: 'J⁦WT⁩', description: 'Stateless tokens' }, { label: 'Keep \u{1F468}‍\u{1F469}', description: null }]
    })
  })

  it('rejects question text that held only format characters, as empty text', () => {
    const parsed = parseAttentionPrompt(spoofed({ text: '‮​' }))
    expect(parsed).toEqual({ ok: false, error: `prompt question text must be 1..${ATTENTION_PROMPT_LIMITS.text} characters` })
  })

  it('keeps labels that differ only by format characters apart: a label is the answer sent back', () => {
    const parsed = parseAttentionPrompt(spoofed({ options: [{ label: 'A​B', description: null }, { label: 'AB', description: null }] }))
    expect(parsed.ok && parsed.value.type === 'questions' && parsed.value.questions[0]!.options.map((option) => option.label))
      .toEqual(['A​B', 'AB'])
  })

  it('never rewrites the tool, command or folder an answer is matched against', () => {
    const parsed = parseAttentionPrompt({ ...permission, command: 'touch a​b.txt', cwd: '/tmp/⁦x' })
    expect(parsed.ok && parsed.value.type === 'permission' && [parsed.value.command, parsed.value.cwd])
      .toEqual(['touch a​b.txt', '/tmp/⁦x'])
  })
})
