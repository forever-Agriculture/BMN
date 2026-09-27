// MODULE: remote-answer.test.ts - the answer engine: refusals, claims, epochs, key scripts and honest outcomes
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { AttentionEvidence, AttentionPrompt, AttentionRecord } from '@bmn/protocol'
import { RemoteAnswers, answerRoute, cleanTypedAnswer, evidenceConfirms, type AnswerOutcome, type QuestionChoice, type RemoteAnswer, type ScreenLike } from './remote-answer'

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
  tool: 'Bash', command: 'touch spike-allow.txt', cwd: '/work/project', description: 'Create spike-allow.txt file'
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
    timing: { stepMs: 200, confirmMs: 250, pickupMs: 150, lateMs: 2_000 }
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

describe('dialogs that leave while another answer is in flight (Astra recheck)', () => {
  it('counts a departure and return drawn back to back, with no time between them', async () => {
    const h = harness({ record: record(CLAUDE_BASH), lines: screen('claude-bash-permission.txt') })
    await settle()
    const sent = h.engine.epochOf('request-1')!
    h.screens.get('s1')!.show(BLANK)
    h.screens.get('s1')!.show(screen('claude-bash-permission.txt'))
    await expect(ask(h, allow, { epoch: sent })).resolves.toEqual({ state: 'refused', reason: 'changed' })
    expect(h.writes).toEqual([])
  })

  it('keeps watching a successor dialog while an earlier answer waits for its report (R1)', async () => {
    const h = harness({ record: record(CLAUDE_BASH), lines: screen('claude-bash-permission.txt') })
    const first = ask(h, allow)
    await settle()
    expect(h.writes).toEqual(['1'])
    h.engine.closed(record(CLAUDE_BASH, { state: 'answered' }))
    const successor = record(CLAUDE_BASH, { requestId: 'request-2' })
    const drawn = open(h, successor)
    h.screens.get('s1')!.show(screen('claude-bash-permission.txt'))
    h.screens.get('s1')!.show(BLANK)
    h.screens.get('s1')!.show(screen('claude-bash-permission.txt'))
    await first
    const outcome = await h.engine.answer({ requestId: 'request-2', revision: 1, epoch: drawn, incarnationId: 'inc-1', answer: allow })
    expect(outcome).toEqual({ state: 'refused', reason: 'changed' })
    expect(h.writes).toEqual(['1'])
  })
})

describe('one answer types into a session at a time', () => {
  it('refuses a second answer while the first is still walking its steps, so neither loses its guard', async () => {
    const h = harness({ record: record(CODEX_TWO), lines: screen('codex-two-step1.txt') })
    const first = ask(h, choose(1, 0))
    await settle()
    expect(h.writes).toEqual(['2'])
    const second = open(h, record(CODEX_TWO, { requestId: 'request-2' }))
    await expect(h.engine.answer({ requestId: 'request-2', revision: 1, epoch: second, incarnationId: 'inc-1', answer: choose(0, 0) }))
      .resolves.toEqual({ state: 'refused', reason: 'changed' })
    expect(h.writes).toEqual(['2'])
    await expect(first).resolves.toEqual({ state: 'partial', sent: ['SQLite'], total: 2 })
  })
})

describe('reports that speak for another dialog after expiry or an owner close (R2)', () => {
  it('never lets a successor confirm an answer whose request was dropped by retain', async () => {
    const h = harness({ record: record(CLAUDE_BASH), lines: screen('claude-bash-permission.txt') })
    const late: string[] = []
    h.engine.onLateOutcome((requestId) => late.push(requestId))
    await expect(ask(h, allow)).resolves.toEqual({ state: 'sent-unconfirmed', sent: ['Allow once'] })
    h.engine.retain(new Set())
    open(h, record(CLAUDE_BASH, { requestId: 'request-2' }))
    const report = evidence({ permission: 'allowed', tool: 'Bash', command: 'touch spike-allow.txt' })
    expect(h.engine.evidence('s1', 'claude:permission', report)).toBeNull()
    expect(late).toEqual([])
  })
})

describe('reports that speak for another dialog (Astra A5)', () => {
  it('never lets an identical successor\'s report confirm an earlier answer or credit it to the phone', async () => {
    const h = harness({ record: record(CLAUDE_BASH), lines: screen('claude-bash-permission.txt') })
    const late: string[] = []
    h.engine.onLateOutcome((requestId) => late.push(requestId))
    await expect(ask(h, allow)).resolves.toEqual({ state: 'sent-unconfirmed', sent: ['Allow once'] })
    h.engine.closed(record(CLAUDE_BASH, { state: 'answered' }))
    open(h, record(CLAUDE_BASH, { requestId: 'request-2' }))
    const report = evidence({ permission: 'allowed', tool: 'Bash', command: 'touch spike-allow.txt' })
    expect(h.engine.evidence('s1', 'claude:permission', report)).toBeNull()
    expect(late).toEqual([])
  })

  it('ignores a report from a later process of the same session', async () => {
    const h = harness({ record: record(CLAUDE_BASH), lines: screen('claude-bash-permission.txt') })
    const pending = ask(h, allow)
    await settle()
    h.live.set('s1', 'inc-9')
    expect(h.engine.evidence('s1', 'claude:permission', evidence({ permission: 'allowed', tool: 'Bash', command: 'touch spike-allow.txt' }))).toBeNull()
    await expect(pending).resolves.toEqual({ state: 'sent-unconfirmed', sent: ['Allow once'] })
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

  it('drops a queued Deny once another permission has opened, because reject would answer both (Astra A2)', async () => {
    const h = harness({ record: record(OPENCODE_PERMISSION) })
    const pending = ask(h, deny)
    await settle()
    open(h, record({ ...OPENCODE_PERMISSION, requestRef: 'per_2' }, { requestId: 'request-2' }))
    await expect(h.engine.take('s1', 'inc-1', 0)).resolves.toEqual([])
    await expect(pending).resolves.toEqual({ state: 'refused', reason: 'changed' })
  })

  it('tells the card when OpenCode refuses the reply after the answer was already reported unconfirmed, and frees the request (R3)', async () => {
    const h = harness({ record: record(OPENCODE_QUESTION) })
    const late: Array<[string, unknown]> = []
    h.engine.onLateOutcome((requestId, outcome) => late.push([requestId, outcome]))
    const pending = ask(h, choose(1))
    await expect(h.engine.take('s1', 'inc-1', 500)).resolves.toHaveLength(1)
    await expect(pending).resolves.toEqual({ state: 'sent-unconfirmed', sent: ['Session cookies'] })
    await h.engine.take('s1', 'inc-1', 0, { requestRef: 'que_1', delivered: false })
    expect(late).toEqual([['request-1', { state: 'refused', reason: 'api-refused' }]])
    // Nothing was applied, so the owner may tap again.
    const retry = ask(h, choose(0), { epoch: h.engine.epochOf('request-1')! })
    await expect(h.engine.take('s1', 'inc-1', 500)).resolves.toHaveLength(1)
    await expect(retry).resolves.toEqual({ state: 'sent-unconfirmed', sent: ['JWT'] })
  })

  it('drops a queued answer whose dialog changed before the plugin collected it (R4)', async () => {
    const h = harness({ record: record(OPENCODE_QUESTION) })
    const pending = ask(h, choose(1))
    await settle()
    h.engine.hookReported('s1')
    await expect(h.engine.take('s1', 'inc-1', 0)).resolves.toEqual([])
    await expect(pending).resolves.toEqual({ state: 'refused', reason: 'changed' })
  })

  it('confirms or refuses from what OpenCode\'s server told the plugin, and only for the process it handed the answer to', async () => {
    const h = harness({ record: record(OPENCODE_QUESTION) })
    const pending = ask(h, choose(1))
    await expect(h.engine.take('s1', 'inc-1', 500)).resolves.toHaveLength(1)
    // Another process, or a request it was never handed, cannot settle it.
    await h.engine.take('s1', 'inc-old', 0, { requestRef: 'que_1', delivered: true })
    await h.engine.take('s1', 'inc-1', 0, { requestRef: 'que_9', delivered: true })
    await h.engine.take('s1', 'inc-1', 0, { requestRef: 'que_1', delivered: true })
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: ['Session cookies'] })

    const refused = harness({ record: record(OPENCODE_QUESTION) })
    const failed = ask(refused, choose(1))
    await expect(refused.engine.take('s1', 'inc-1', 500)).resolves.toHaveLength(1)
    await refused.engine.take('s1', 'inc-1', 0, { requestRef: 'que_1', delivered: false })
    await expect(failed).resolves.toEqual({ state: 'refused', reason: 'api-refused' })
  })
})

/*
 * Epic 31: multi-select, typed answers. The simulators draw each harness's dialog the way the spike recorded it
 * (docs/remote-answers.md) and move it the way its keys did, so every key BMN writes must match the screen.
 */
const DOWN = '\u001b[B'

class ClaudeDialog {
  cursor = 0
  ticked: boolean[]
  other: string | null = null
  otherTicked = false
  submitted = false
  constructor(
    private readonly screenOf: () => FakeScreen,
    private readonly text: string,
    private readonly labels: string[],
    private readonly multi: boolean,
    /** What shows once the question is left: the review, or nothing. */
    private readonly after: string[]
  ) {
    this.ticked = labels.map(() => false)
  }

  lines(): string[] {
    if (this.submitted) return this.after
    const n = this.labels.length
    const mark = (row: number): string => (this.cursor === row ? '❯' : ' ')
    const box = (on: boolean): string => (this.multi ? `[${on ? '✔' : ' '}] ` : '')
    return [
      '←  ☐ Features  ✔ Submit  →',
      this.text,
      ...this.labels.flatMap((label, index) => [`${mark(index)} ${index + 1}. ${box(this.ticked[index]!)}${label}`, '     A description.']),
      `${mark(n)} ${n + 1}. ${box(this.otherTicked)}${this.other ?? (this.multi ? 'Type something' : 'Type something.')}`,
      ...(this.multi ? [`${mark(n + 1)}    Submit`] : []),
      '────────────────────────────────────────',
      `  ${n + 2}. Chat about this`,
      'Enter to select · ↑/↓ to navigate · Esc to cancel'
    ]
  }

  key(key: string): void {
    const n = this.labels.length
    const typing = this.cursor === n && (this.other !== null || !this.multi)
    if (key === DOWN) this.cursor = Math.min(this.cursor + 1, this.multi ? n + 1 : n)
    else if (key === '\r') this.submitted = !this.multi || this.cursor === n + 1
    else if (/^\d$/.test(key) && !(this.cursor === n && this.other !== null)) {
      const digit = Number(key)
      if (this.multi && digit <= n) this.ticked[digit - 1] = !this.ticked[digit - 1]
      else if (digit === n + 1) this.cursor = n
    } else if (this.cursor === n || typing) {
      this.other = (this.other ?? '') + key
      this.otherTicked = true
    }
    queueMicrotask(() => this.screenOf().show(this.lines()))
  }
}

class CodexDialog {
  cursor = 0
  notes: string | null = null
  submitted = false
  constructor(private readonly screenOf: () => FakeScreen, private readonly text: string, private readonly labels: string[]) {}

  lines(): string[] {
    if (this.submitted) return BLANK
    const n = this.labels.length
    const mark = (row: number): string => (this.cursor === row ? '›' : ' ')
    return [
      '  Question 1/1 (1 unanswered)',
      `  ${this.text}`,
      ...this.labels.map((label, index) => `  ${mark(index)} ${index + 1}. ${label.padEnd(18)}A description`),
      `  ${mark(n)} ${n + 1}. None of the above  Optionally, add details in notes (tab)`,
      ...(this.notes === null ? [] : [`  › ${this.notes === '' ? 'Add notes' : this.notes}`]),
      '',
      '  tab to add notes | enter to submit answer'
    ]
  }

  key(key: string): void {
    const n = this.labels.length
    if (key === DOWN) this.cursor = Math.min(this.cursor + 1, n)
    else if (key === '\t' && this.cursor === n) this.notes = ''
    else if (key === '\r') this.submitted = true
    else if (this.notes !== null) this.notes += key
    queueMicrotask(() => this.screenOf().show(this.lines()))
  }
}

const multiQuestion = (text: string, ...labels: string[]) => ({ ...question(text, ...labels), multiSelect: true })
const CLAUDE_FEATURES: AttentionPrompt = {
  type: 'questions', harness: 'claude', shape: 'multi-select', requestRef: null, toolUseId: 'toolu_features',
  questions: [multiQuestion('Which features should the first release include?', 'Rate limiting', 'Audit log', 'Webhooks')]
}
const CODEX_AUTH: AttentionPrompt = {
  type: 'questions', harness: 'codex', shape: 'choice', requestRef: null, toolUseId: 'call_auth',
  questions: [{ ...question('Which auth method should the API use?', 'JWT', 'Sessions'), id: 'auth' }]
}
const OPENCODE_FEATURES: AttentionPrompt = {
  type: 'questions', harness: 'opencode', shape: 'multi-select', requestRef: 'que_2', toolUseId: null,
  questions: [
    multiQuestion('Which features should v1 include?', 'SSO', 'Rate limiting', 'Audit log'),
    question('Which auth method?', 'JWT', 'Sessions')
  ]
}
const answers = (...choices: QuestionChoice[]): RemoteAnswer => ({ type: 'choices', choices })
const REVIEW = (question: string, answer: string): string[] =>
  ['Review your answers', ` ● ${question}`, `   → ${answer}`, 'Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel']

function claudeHarness(prompt: AttentionPrompt, after: string[]): { h: Harness; dialog: ClaudeDialog } {
  const q = (prompt as Extract<AttentionPrompt, { type: 'questions' }>).questions[0]!
  // The dialog reads the harness's screen lazily, so the harness is assigned after it.
  // eslint-disable-next-line prefer-const
  let h!: Harness
  const dialog = new ClaudeDialog(() => h.screens.get('s1')!, q.text, q.options.map((option) => option.label), q.multiSelect, after)
  h = harness({ record: record(prompt), lines: dialog.lines() })
  h.onKey = (key) => {
    // The review answers the Submit digit by closing.
    if (dialog.submitted && key === '1') return queueMicrotask(() => h.screens.get('s1')!.show(BLANK))
    for (const char of key === DOWN || key === '\r' ? [key] : [...key]) dialog.key(char)
  }
  return { h, dialog }
}

describe('answering multi-select and typed answers (Epic 31)', () => {
  it('ticks Claude options in option order, leaves by Down to Submit and Enter, and submits the review', async () => {
    const { h, dialog } = claudeHarness(CLAUDE_FEATURES, REVIEW('Which features should the first release include?', 'Rate limiting, Webhooks'))
    const pending = ask(h, answers({ set: [0, 2] }))
    await settle(120)
    expect(h.writes).toEqual(['1', '3', DOWN, DOWN, DOWN, DOWN, '\r', '1'])
    expect(dialog.ticked).toEqual([true, false, true])
    // Claude reports the labels in the order they were ticked, which is option order.
    expect(h.engine.evidence('s1', 'claude:question', evidence({ toolUseId: 'toolu_features', answers: [['Rate limiting, Webhooks']] }))).toBe('request-1')
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: ['Rate limiting · Webhooks'] })
  })

  it('types a Claude multi-select answer into its own row, only once the cursor is there', async () => {
    const typed = 'Passkeys first, then JWT as a fallback for older clients'
    const { h, dialog } = claudeHarness(CLAUDE_FEATURES, REVIEW('Which features should the first release include?', `Audit log, ${typed}`))
    const pending = ask(h, answers({ set: [1], typed }))
    await settle(200)
    const keys = h.writes
    expect(keys.slice(0, 4)).toEqual(['2', DOWN, DOWN, DOWN])
    // Typed text goes out in pieces no harness takes for a paste, and nothing else is typed into the row.
    expect(keys.slice(4, -3).every((piece) => [...piece].length <= 32)).toBe(true)
    expect(keys.slice(4, -3).join('')).toBe(typed)
    expect(keys.slice(-3)).toEqual([DOWN, '\r', '1'])
    expect(dialog.other).toBe(typed)
    h.engine.evidence('s1', 'claude:question', evidence({ toolUseId: 'toolu_features', answers: [[`Audit log, ${typed}`]] }))
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: [`Audit log · “${typed}”`] })
  })

  it('answers a Claude single-choice question with typed text: its row\'s digit, the text, Enter', async () => {
    const { h } = claudeHarness(CLAUDE_SINGLE, BLANK)
    const pending = ask(h, answers({ typed: 'Passkeys' }))
    await settle(80)
    expect(h.writes).toEqual(['4', 'Passkeys', '\r'])
    h.engine.evidence('s1', 'claude:question', evidence({ toolUseId: 'toolu_single', answers: [['Passkeys']] }))
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: ['“Passkeys”'] })
  })

  it('answers Codex with "None of the above" and a note, and confirms from the note it reports', async () => {
    // eslint-disable-next-line prefer-const
    let h!: Harness
    const dialog = new CodexDialog(() => h.screens.get('s1')!, 'Which auth method should the API use?', ['JWT', 'Sessions'])
    h = harness({ record: record(CODEX_AUTH), lines: dialog.lines() })
    h.onKey = (key) => {
      for (const char of key === DOWN || key === '\r' || key === '\t' ? [key] : [...key]) dialog.key(char)
    }
    const pending = ask(h, answers({ typed: 'Passkeys first' }))
    await settle(100)
    expect(h.writes).toEqual([DOWN, DOWN, '\t', 'Passkeys first', '\r'])
    expect(h.engine.evidence('s1', 'codex:question', evidence({ toolUseId: 'call_auth', answers: [['None of the above', 'Passkeys first']] }))).toBeNull()
    expect(h.engine.evidence('s1', 'codex:question', evidence({ toolUseId: 'call_auth', answers: [['None of the above', 'user_note: Passkeys first']] }))).toBe('request-1')
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: ['“Passkeys first”'] })
  })

  it('hands OpenCode every label of a multi-select question, typed text last, through its plugin', async () => {
    const h = harness({ record: record(OPENCODE_FEATURES) })
    const pending = ask(h, answers({ set: [0, 1], typed: 'Webhooks' }, { typed: 'Passkeys' }))
    await settle()
    expect(await h.engine.take('s1', 'inc-1', 0)).toEqual([
      { requestRef: 'que_2', kind: 'question', answers: [['SSO', 'Rate limiting', 'Webhooks'], ['Passkeys']] }
    ])
    h.engine.evidence('s1', 'opencode:question', evidence({ requestRef: 'que_2', answers: [['SSO', 'Rate limiting', 'Webhooks'], ['Passkeys']] }))
    await expect(pending).resolves.toEqual({ state: 'confirmed', sent: ['SSO · Rate limiting · “Webhooks”', '“Passkeys”'] })
  })

  it('refuses answers that do not fit the question, writing nothing', async () => {
    const shapes: Array<[AttentionPrompt, RemoteAnswer]> = [
      [CLAUDE_SINGLE, answers({ set: [0] })],
      [CLAUDE_FEATURES, answers(0)],
      [CLAUDE_FEATURES, answers({ set: [2, 0] })],
      [CLAUDE_FEATURES, answers({ set: [0, 0] })],
      [CLAUDE_FEATURES, answers({ set: [] })],
      [CLAUDE_FEATURES, answers({ set: [3] })],
      [CLAUDE_SINGLE, answers({ typed: '' })],
      [CLAUDE_SINGLE, answers({ typed: 'two\nlines' })],
      [CLAUDE_SINGLE, answers({ typed: ' padded' })],
      [CLAUDE_SINGLE, answers({ typed: 'x'.repeat(2_001) })],
      // OpenCode said this question takes no typed answer.
      [{ ...OPENCODE_QUESTION, questions: [{ ...OPENCODE_QUESTION.questions[0]!, custom: false }] } as AttentionPrompt, answers({ typed: 'Mine' })],
      // Codex asks no multi-select question; a prompt saying so is not its dialog.
      [{ ...CODEX_AUTH, shape: 'multi-select', questions: [{ ...CODEX_AUTH.questions[0]!, multiSelect: true }] } as AttentionPrompt, answers({ set: [0] })]
    ]
    for (const [prompt, answer] of shapes) {
      const h = harness({ record: record(prompt), lines: screen('claude-single-200.txt') })
      await expect(ask(h, answer)).resolves.toEqual({ state: 'refused', reason: 'unsupported' })
      expect(h.writes).toEqual([])
    }
  })

  it('refuses a multi-select question already ticked on screen, and stops at once when a tick does not show', async () => {
    const { h, dialog } = claudeHarness(CLAUDE_FEATURES, BLANK)
    dialog.ticked[1] = true
    h.screens.get('s1')!.show(dialog.lines())
    await expect(ask(h, answers({ set: [0] }))).resolves.toEqual({ state: 'refused', reason: 'not-on-screen' })
    expect(h.writes).toEqual([])

    const stuck = claudeHarness(CLAUDE_FEATURES, BLANK)
    // The program draws nothing after the first key.
    stuck.h.onKey = () => undefined
    await expect(ask(stuck.h, answers({ set: [0, 2] }))).resolves.toEqual({ state: 'partial', sent: [], total: 1 })
    expect(stuck.h.writes).toEqual(['1'])
  })

  it('confirms Claude only for the labels in option order', () => {
    const report = (value: string) => evidence({ toolUseId: 'toolu_features', answers: [[value]] })
    expect(evidenceConfirms(CLAUDE_FEATURES, answers({ set: [0, 2] }), report('Rate limiting, Webhooks'))).toBe(true)
    expect(evidenceConfirms(CLAUDE_FEATURES, answers({ set: [0, 2] }), report('Webhooks, Rate limiting'))).toBe(false)
    expect(evidenceConfirms(CLAUDE_FEATURES, answers({ set: [0], typed: 'Mine' }), report('Rate limiting, Mine'))).toBe(true)
  })

  it('routes Claude and OpenCode multi-select, never a shape that disagrees with its questions', () => {
    expect(answerRoute(CLAUDE_FEATURES)).toBe('claude-keys')
    expect(answerRoute(OPENCODE_FEATURES)).toBe('opencode-api')
    expect(answerRoute({ ...CLAUDE_FEATURES, shape: 'choice' })).toBeNull()
    expect(answerRoute({ ...CLAUDE_SINGLE, shape: 'multi-select' })).toBeNull()
  })

  it('cleans a typed reply: controls and runs of space folded, trimmed, clipped to 2,000 characters', () => {
    expect(cleanTypedAnswer('  Passkeys\n\tfirst \u0007 ok  ')).toBe('Passkeys first ok')
    expect([...cleanTypedAnswer('é'.repeat(2_500))]).toHaveLength(2_000)
    expect(cleanTypedAnswer('\n\t ')).toBe('')
  })
})
