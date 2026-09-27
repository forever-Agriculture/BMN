// MODULE: remote-answer.test.ts - the answer engine: refusals, claims, epochs, key scripts and honest outcomes
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttentionEvidence, AttentionPrompt, AttentionRecord } from '@bmn/protocol'
import { RemoteAnswers, answerRoute, evidenceConfirms, type AnswerOutcome, type RemoteAnswer, type ScreenLike } from './remote-answer'

const SCREENS = join(__dirname, 'test-fixtures', 'remote-answers', 'screens')
const screen = (name: string): string[] => readFileSync(join(SCREENS, name), 'utf8').split('\n')
const BLANK = ['']

class FakeScreen implements ScreenLike {
  private readonly listeners = new Set<() => void>()
  constructor(private current: string[]) {}
  lines(): string[] {
    return this.current
  }
  settled(): Promise<void> {
    return Promise.resolve()
  }
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  show(lines: string[]): void {
    this.current = lines
    for (const listener of [...this.listeners]) listener()
  }
}

const question = (text: string, ...labels: string[]) => ({
  id: null, header: null, text, multiSelect: false, options: labels.map((label) => ({ label, description: null }))
})

const CLAUDE_SINGLE: AttentionPrompt = {
  type: 'questions', harness: 'claude', shape: 'choice', requestRef: null, toolUseId: 'toolu_single',
  questions: [question('Which auth method should the API use?', 'JWT', 'Session cookies', 'OAuth only')]
}
const CLAUDE_THREE: AttentionPrompt = {
  type: 'questions', harness: 'claude', shape: 'choice', requestRef: null, toolUseId: 'toolu_three',
  questions: [
    question('Which database should store users?', 'Postgres', 'SQLite'),
    question('Add integration tests now?', 'Yes', 'Later'),
    question('Where to deploy first?', 'Staging', 'Production')
  ]
}
const CODEX_TWO: AttentionPrompt = {
  type: 'questions', harness: 'codex', shape: 'choice', requestRef: null, toolUseId: 'call_two',
  questions: [
    { ...question('Which database should store users?', 'Postgres', 'SQLite'), id: 'database' },
    { ...question('Add integration tests now?', 'Yes', 'Later'), id: 'tests' }
  ]
}
const CLAUDE_BASH: AttentionPrompt = {
  type: 'permission', harness: 'claude', shape: 'permission', requestRef: null, toolUseId: null,
  tool: 'Bash', command: 'touch spike-allow.txt', cwd: '/work/project'
}
const OPENCODE_QUESTION: AttentionPrompt = {
  type: 'questions', harness: 'opencode', shape: 'choice', requestRef: 'que_1', toolUseId: null,
  questions: [question('Which auth method should the API use?', 'JWT', 'Session cookies')]
}
const OPENCODE_PERMISSION: AttentionPrompt = {
  type: 'permission', harness: 'opencode', shape: 'permission', requestRef: 'per_1', toolUseId: null,
  tool: 'bash', command: 'touch oc-c.txt', cwd: null
}

function record(prompt: AttentionPrompt, overrides: Partial<AttentionRecord> = {}): AttentionRecord {
  return {
    requestId: 'request-1', sessionId: 's1', incarnationId: 'inc-1',
    requestKey: `${prompt.harness}:${prompt.type === 'permission' ? 'permission' : 'question'}`,
    kind: prompt.type === 'permission' ? 'permission' : 'question',
    title: 'Asked', body: null, state: 'open', resolution: null, openedAt: '2026-09-27T12:00:00.000Z',
    expiresAt: null, resolvedAt: null, seenAt: null, revision: 1, openedBy: null, resolvedBy: null, prompt,
    ...overrides
  }
}

function evidence(fields: Partial<AttentionEvidence>): AttentionEvidence {
  return { toolUseId: null, requestRef: null, answers: null, permission: null, tool: null, command: null, ...fields }
}

interface Harness {
  engine: RemoteAnswers
  records: Map<string, AttentionRecord>
  screens: Map<string, FakeScreen>
  writes: string[]
  live: Map<string, string>
  permissions: { on: boolean }
  /** What the program draws next when it reads a key. */
  onKey: ((key: string) => void) | undefined
}

const engines: RemoteAnswers[] = []
afterEach(() => {
  for (const engine of engines.splice(0)) engine.dispose()
})

function harness(initial?: { record: AttentionRecord; lines?: string[] }): Harness {
  const h: Harness = {
    engine: undefined as unknown as RemoteAnswers,
    records: new Map(),
    screens: new Map(),
    writes: [],
    live: new Map([['s1', 'inc-1'], ['s2', 'inc-2']]),
    permissions: { on: true },
    onKey: undefined
  }
  h.engine = new RemoteAnswers({
    getAttention: async (requestId) => h.records.get(requestId) ?? null,
    liveIncarnationId: (sessionId) => h.live.get(sessionId),
    screen: (sessionId, incarnationId) => h.live.get(sessionId) === incarnationId ? h.screens.get(sessionId) : undefined,
    write: (_sessionId, bytes) => {
      const key = new TextDecoder().decode(bytes)
      h.writes.push(key)
      h.onKey?.(key)
    },
    answerPermissions: async () => h.permissions.on,
    timing: { stepMs: 200, confirmMs: 250, pickupMs: 150, lateMs: 2_000, watchMs: 5 }
  })
  engines.push(h.engine)
  if (initial) open(h, initial.record, initial.lines)
  return h
}

function open(h: Harness, request: AttentionRecord, lines?: string[]): number {
  h.records.set(request.requestId, request)
  if (lines) h.screens.set(request.sessionId, h.screens.get(request.sessionId) ?? new FakeScreen(lines))
  h.engine.hookReported(request.sessionId)
  h.engine.track(request)
  return h.engine.epochOf(request.requestId)!
}

const choose = (...choices: number[]): RemoteAnswer => ({ type: 'choices', choices })
const allow: RemoteAnswer = { type: 'permission', decision: 'allow' }
const deny: RemoteAnswer = { type: 'permission', decision: 'deny' }
const ask = (h: Harness, answer: RemoteAnswer, overrides: { revision?: number; epoch?: number; incarnationId?: string } = {}) =>
  h.engine.answer({
    requestId: 'request-1',
    revision: overrides.revision ?? 1,
    epoch: overrides.epoch ?? h.engine.epochOf('request-1') ?? 1,
    incarnationId: overrides.incarnationId ?? 'inc-1',
    answer
  })
const settle = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

describe('which shapes have a route (decision 7)', () => {
  it('answers only the verified cells', () => {
    expect(answerRoute(CLAUDE_SINGLE)).toBe('claude-keys')
    expect(answerRoute(CODEX_TWO)).toBe('codex-keys')
    expect(answerRoute(OPENCODE_QUESTION)).toBe('opencode-api')
    expect(answerRoute(CLAUDE_BASH)).toBe('claude-keys')
    expect(answerRoute(OPENCODE_PERMISSION)).toBe('opencode-api')
    expect(answerRoute(null)).toBeNull()
    expect(answerRoute({ ...CLAUDE_SINGLE, shape: 'multi-select' })).toBeNull()
    expect(answerRoute({ ...CODEX_TWO, shape: 'async-choice' })).toBeNull()
    expect(answerRoute({ ...OPENCODE_QUESTION, shape: 'subagent' })).toBeNull()
    expect(answerRoute({ ...CLAUDE_BASH, tool: 'Edit' })).toBeNull()
    expect(answerRoute({ ...CLAUDE_BASH, command: null })).toBeNull()
    expect(answerRoute({ ...CLAUDE_BASH, harness: 'codex' })).toBeNull()
    expect(answerRoute({ ...OPENCODE_PERMISSION, shape: 'sandbox-network' })).toBeNull()
  })

  it('confirms only a report naming exactly the answer sent', () => {
    expect(evidenceConfirms(CLAUDE_THREE, choose(0, 1, 0), evidence({ toolUseId: 'toolu_three', answers: [['Postgres'], ['Later'], ['Staging']] }))).toBe(true)
    expect(evidenceConfirms(CLAUDE_THREE, choose(0, 1, 0), evidence({ toolUseId: 'toolu_three', answers: [['Postgres'], ['Yes'], ['Staging']] }))).toBe(false)
    expect(evidenceConfirms(CLAUDE_THREE, choose(0, 1, 0), evidence({ toolUseId: 'toolu_other', answers: [['Postgres'], ['Later'], ['Staging']] }))).toBe(false)
    expect(evidenceConfirms(CLAUDE_BASH, allow, evidence({ permission: 'allowed', tool: 'Bash', command: 'touch spike-allow.txt' }))).toBe(true)
    expect(evidenceConfirms(CLAUDE_BASH, allow, evidence({ permission: 'allowed', tool: 'Bash', command: 'touch other.txt' }))).toBe(false)
    expect(evidenceConfirms(OPENCODE_PERMISSION, deny, evidence({ requestRef: 'per_1', permission: 'denied' }))).toBe(true)
    expect(evidenceConfirms(OPENCODE_PERMISSION, deny, evidence({ requestRef: 'per_2', permission: 'denied' }))).toBe(false)
    expect(evidenceConfirms(OPENCODE_QUESTION, choose(0), evidence({ answers: [['JWT']] }))).toBe(false)
  })
})

describe('answering by keys', () => {
  it('types the chosen digit into Claude\'s question and confirms it from the harness report', async () => {
    const h = harness({ record: record(CLAUDE_SINGLE), lines: screen('claude-single-200.txt') })
    const pending = ask(h, choose(1))
    await settle()
    expect(h.writes).toEqual(['2'])
    expect(h.engine.evidence('s1', 'claude:question', evidence({ toolUseId: 'toolu_single', answers: [['Session cookies']] }))).toBe('request-1')
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: ['Session cookies'] })
  })

  it('reports sent-unconfirmed without a report, never retries, and upgrades on a late report', async () => {
    const h = harness({ record: record(CLAUDE_SINGLE), lines: screen('claude-single-200.txt') })
    const late: Array<[string, AnswerOutcome]> = []
    h.engine.onLateOutcome((requestId, outcome) => late.push([requestId, outcome]))
    await expect(ask(h, choose(0))).resolves.toEqual({ state: 'sent-unconfirmed', sent: ['JWT'] })
    expect(h.writes).toEqual(['1'])
    // A second tap cannot send it again.
    await expect(ask(h, choose(0))).resolves.toEqual({ state: 'refused', reason: 'claimed' })
    h.engine.evidence('s1', 'claude:question', evidence({ toolUseId: 'toolu_single', answers: [['JWT']] }))
    expect(late).toEqual([['request-1', { state: 'confirmed', sent: ['JWT'] }]])
  })

  it('steps through Claude\'s three questions, checking each on screen, then submits the review', async () => {
    const h = harness({ record: record(CLAUDE_THREE), lines: screen('claude-three-step1.txt') })
    const next = [screen('claude-three-step2.txt'), screen('claude-three-step3.txt'), screen('claude-three-review.txt'), BLANK]
    h.onKey = () => queueMicrotask(() => h.screens.get('s1')!.show(next.shift()!))
    const pending = ask(h, choose(0, 1, 0))
    await settle(60)
    expect(h.writes).toEqual(['1', '2', '1', '1'])
    h.engine.evidence('s1', 'claude:question', evidence({ toolUseId: 'toolu_three', answers: [['Postgres'], ['Later'], ['Staging']] }))
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: ['Postgres', 'Later', 'Staging'] })
  })

  it('stops at once and reports partial when a later question is not on screen', async () => {
    const h = harness({ record: record(CLAUDE_THREE), lines: screen('claude-three-step1.txt') })
    // The dialog moves on to something else after the first key.
    h.onKey = () => queueMicrotask(() => h.screens.get('s1')!.show(screen('claude-bash-denied.txt')))
    await expect(ask(h, choose(0, 1, 0))).resolves.toEqual({ state: 'partial', sent: ['Postgres'], total: 3 })
    expect(h.writes).toEqual(['1'])
  })

  it('reports partial when the review does not list the answers sent', async () => {
    const h = harness({ record: record(CLAUDE_THREE), lines: screen('claude-three-step1.txt') })
    const next = [screen('claude-three-step2.txt'), screen('claude-three-step3.txt'), screen('claude-three-review.txt')]
    h.onKey = () => queueMicrotask(() => h.screens.get('s1')!.show(next.shift() ?? BLANK))
    // The review on screen says "Later" for question two; this answer chose "Yes".
    await expect(ask(h, choose(0, 0, 0))).resolves.toEqual({ state: 'partial', sent: ['Postgres', 'Yes', 'Staging'], total: 3 })
    expect(h.writes).toEqual(['1', '1', '1'])
  })

  it('answers Codex\'s two questions one digit each, the last one submitting', async () => {
    const h = harness({ record: record(CODEX_TWO), lines: screen('codex-two-step1.txt') })
    const next = [screen('codex-two-step2.txt'), BLANK]
    h.onKey = () => queueMicrotask(() => h.screens.get('s1')!.show(next.shift()!))
    const pending = ask(h, choose(1, 0))
    await settle(60)
    expect(h.writes).toEqual(['2', '1'])
    h.engine.evidence('s1', 'codex:question', evidence({ toolUseId: 'call_two', answers: [['SQLite'], ['Yes']] }))
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: ['SQLite', 'Yes'] })
  })

  it('allows a Claude permission once with the digit read from screen, and confirms from the tool that ran', async () => {
    const h = harness({ record: record(CLAUDE_BASH), lines: screen('claude-bash-permission.txt') })
    const pending = ask(h, allow)
    await settle()
    expect(h.writes).toEqual(['1'])
    h.engine.evidence('s1', 'claude:permission', evidence({ permission: 'allowed', tool: 'Bash', command: 'touch spike-allow.txt' }))
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: ['Allow once'] })
  })

  it('denies a Claude permission with its "No" digit and says it cannot be confirmed', async () => {
    const h = harness({ record: record(CLAUDE_BASH), lines: screen('claude-bash-permission.txt') })
    await expect(ask(h, deny)).resolves.toEqual({ state: 'sent-unconfirmed', sent: ['Deny'] })
    expect(h.writes).toEqual(['3'])
  })
})

describe('refusals, each with its reason and no keys written', () => {
  it('gone: the request closed, its process ended, or another process owns the session now', async () => {
    const closed = harness({ record: record(CLAUDE_SINGLE), lines: screen('claude-single-200.txt') })
    closed.records.set('request-1', record(CLAUDE_SINGLE, { state: 'answered' }))
    await expect(ask(closed, choose(0))).resolves.toEqual({ state: 'refused', reason: 'gone' })
    const ended = harness({ record: record(CLAUDE_SINGLE), lines: screen('claude-single-200.txt') })
    ended.live.delete('s1')
    await expect(ask(ended, choose(0))).resolves.toEqual({ state: 'refused', reason: 'gone' })
    const replaced = harness({ record: record(CLAUDE_SINGLE), lines: screen('claude-single-200.txt') })
    await expect(ask(replaced, choose(0), { incarnationId: 'inc-old' })).resolves.toEqual({ state: 'refused', reason: 'gone' })
    for (const h of [closed, ended, replaced]) expect(h.writes).toEqual([])
  })

  it('changed: another revision, or a hook reported the prompt again since the card was sent', async () => {
    const h = harness({ record: record(CLAUDE_SINGLE), lines: screen('claude-single-200.txt') })
    await expect(ask(h, choose(0), { revision: 2 })).resolves.toEqual({ state: 'refused', reason: 'changed' })
    const epoch = h.engine.epochOf('request-1')!
    h.engine.hookReported('s1')
    await expect(ask(h, choose(0), { epoch })).resolves.toEqual({ state: 'refused', reason: 'changed' })
    expect(h.writes).toEqual([])
  })

  it('not-on-screen: the mirror does not show that dialog', async () => {
    const h = harness({ record: record(CLAUDE_SINGLE), lines: screen('claude-bash-permission.txt') })
    await expect(ask(h, choose(0))).resolves.toEqual({ state: 'refused', reason: 'not-on-screen' })
    const permission = harness({ record: record(CLAUDE_BASH), lines: screen('claude-single-200.txt') })
    await expect(ask(permission, allow)).resolves.toEqual({ state: 'refused', reason: 'not-on-screen' })
    expect([...h.writes, ...permission.writes]).toEqual([])
  })

  it('unsupported: an unverified shape, or an answer that does not fit the prompt', async () => {
    for (const prompt of [{ ...CLAUDE_SINGLE, shape: 'multi-select' as const }, { ...CODEX_TWO, shape: 'async-choice' as const }, { ...CLAUDE_BASH, harness: 'codex' as const }]) {
      const h = harness({ record: record(prompt), lines: screen('claude-single-200.txt') })
      await expect(ask(h, prompt.type === 'permission' ? allow : choose(0))).resolves.toEqual({ state: 'refused', reason: 'unsupported' })
      expect(h.writes).toEqual([])
    }
    const h = harness({ record: record(CLAUDE_SINGLE), lines: screen('claude-single-200.txt') })
    for (const answer of [choose(3), choose(0, 1), choose(-1), allow]) {
      await expect(ask(h, answer)).resolves.toEqual({ state: 'refused', reason: 'unsupported' })
    }
    expect(h.writes).toEqual([])
  })

  it('permissions-off: the owner has not allowed answering permissions from the phone', async () => {
    const h = harness({ record: record(CLAUDE_BASH), lines: screen('claude-bash-permission.txt') })
    h.permissions.on = false
    await expect(ask(h, allow)).resolves.toEqual({ state: 'refused', reason: 'permissions-off' })
    await expect(ask(h, deny)).resolves.toEqual({ state: 'refused', reason: 'permissions-off' })
    expect(h.writes).toEqual([])
  })

  it('claimed: of two answers raced for one request, only the first is written', async () => {
    const h = harness({ record: record(CLAUDE_SINGLE), lines: screen('claude-single-200.txt') })
    const first = ask(h, choose(0))
    const second = ask(h, choose(1))
    await expect(second).resolves.toEqual({ state: 'refused', reason: 'claimed' })
    await settle()
    expect(h.writes).toEqual(['1'])
    h.engine.evidence('s1', 'claude:question', evidence({ toolUseId: 'toolu_single', answers: [['JWT']] }))
    await expect(first).resolves.toMatchObject({ state: 'confirmed' })
  })

  it('frees the claim after a refusal, so a later tap on the current card can still answer', async () => {
    const h = harness({ record: record(CLAUDE_SINGLE), lines: BLANK })
    await expect(ask(h, choose(0))).resolves.toEqual({ state: 'refused', reason: 'not-on-screen' })
    h.screens.get('s1')!.show(screen('claude-single-200.txt'))
    const pending = ask(h, choose(0))
    await settle()
    expect(h.writes).toEqual(['1'])
    h.engine.evidence('s1', 'claude:question', evidence({ toolUseId: 'toolu_single', answers: [['JWT']] }))
    await expect(pending).resolves.toMatchObject({ state: 'confirmed' })
  })
})

describe('the dialog epoch (decision 3)', () => {
  it('rises when a hook reports again, even identically, and only for that session', () => {
    const h = harness({ record: record(CLAUDE_SINGLE), lines: screen('claude-single-200.txt') })
    open(h, record(CLAUDE_BASH, { requestId: 'other', sessionId: 's2', incarnationId: 'inc-2' }))
    const before = h.engine.epochOf('request-1')!
    const other = h.engine.epochOf('other')!
    open(h, record(CLAUDE_SINGLE))
    expect(h.engine.epochOf('request-1')).toBe(before + 1)
    expect(h.engine.epochOf('other')).toBe(other)
  })

  it('rises when the recognised dialog leaves the screen, and stays risen when it comes back', async () => {
    const h = harness({ record: record(CLAUDE_BASH), lines: screen('claude-bash-permission.txt') })
    await settle()
    const sent = h.engine.epochOf('request-1')!
    h.screens.get('s1')!.show(screen('claude-bash-denied.txt'))
    await settle()
    expect(h.engine.epochOf('request-1')).toBe(sent + 1)
    h.screens.get('s1')!.show(screen('claude-bash-permission.txt'))
    await settle()
    expect(h.engine.epochOf('request-1')).toBe(sent + 1)
    await expect(ask(h, allow, { epoch: sent })).resolves.toEqual({ state: 'refused', reason: 'changed' })
    expect(h.writes).toEqual([])
  })
})

describe('answering OpenCode through its plugin', () => {
  it('hands the plugin the answer by request id, writes no keys, and confirms from the replied event', async () => {
    const h = harness({ record: record(OPENCODE_QUESTION) })
    const pending = ask(h, choose(1))
    await expect(h.engine.take('s1', 'inc-1', 500)).resolves.toEqual([{ requestRef: 'que_1', kind: 'question', answers: [['Session cookies']] }])
    // Consumed: a second collection finds nothing.
    await expect(h.engine.take('s1', 'inc-1', 0)).resolves.toEqual([])
    h.engine.evidence('s1', 'opencode:question', evidence({ requestRef: 'que_1', answers: [['Session cookies']] }))
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: ['Session cookies'] })
    expect(h.writes).toEqual([])
  })

  it('never hands one session\'s answer to another session or process', async () => {
    const h = harness({ record: record(OPENCODE_QUESTION) })
    const pending = ask(h, choose(0))
    await settle()
    await expect(h.engine.take('s2', 'inc-2', 0)).resolves.toEqual([])
    await expect(h.engine.take('s1', 'inc-old', 0)).resolves.toEqual([])
    await expect(h.engine.take('s1', null, 0)).resolves.toEqual([])
    await expect(pending).resolves.toEqual({ state: 'refused', reason: 'not-delivered' })
    // Nothing was sent, so a later tap may try again.
    const retry = ask(h, choose(0))
    await expect(h.engine.take('s1', 'inc-1', 500)).resolves.toHaveLength(1)
    await expect(retry).resolves.toEqual({ state: 'sent-unconfirmed', sent: ['JWT'] })
  })

  it('offers Deny only while this is the session\'s one pending permission, because reject answers them all', async () => {
    const h = harness({ record: record(OPENCODE_PERMISSION) })
    expect(h.engine.canDeny(record(OPENCODE_PERMISSION))).toBe(true)
    open(h, record({ ...OPENCODE_PERMISSION, requestRef: 'per_2' }, { requestId: 'request-2' }))
    expect(h.engine.canDeny(record(OPENCODE_PERMISSION))).toBe(false)
    await expect(ask(h, deny)).resolves.toEqual({ state: 'refused', reason: 'unsupported' })
    h.engine.evidence('s1', 'opencode:permission', evidence({ requestRef: 'per_2', permission: 'allowed' }))
    expect(h.engine.canDeny(record(OPENCODE_PERMISSION))).toBe(true)
    const pending = ask(h, deny, { epoch: h.engine.epochOf('request-1')! })
    await expect(h.engine.take('s1', 'inc-1', 500)).resolves.toEqual([{ requestRef: 'per_1', kind: 'permission', reply: 'reject' }])
    h.engine.evidence('s1', 'opencode:permission', evidence({ requestRef: 'per_1', permission: 'denied' }))
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: ['Deny'] })
  })
})
