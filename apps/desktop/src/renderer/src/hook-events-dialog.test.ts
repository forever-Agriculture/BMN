// MODULE: hook-events-dialog.test.ts - the plain words the hook event list shows for an event and its effects
import { describe, expect, it } from 'vitest'
import { hookEffectWords, hookEventWords } from './hook-events-dialog'

describe('hook event words', () => {
  it('names the event, the tool it ran and the source the harness gave', () => {
    expect(hookEventWords({ agent: 'claude', event: 'PostToolUse', toolName: 'Bash', source: null })).toBe('PostToolUse · Bash')
    expect(hookEventWords({ agent: 'claude', event: 'PostToolUseFailure', toolName: 'Bash', source: null, repeat: 3 }))
      .toBe('PostToolUseFailure · Bash · same call ×3')
    expect(hookEventWords({ agent: 'claude', event: 'SessionStart', toolName: null, source: 'resume' })).toBe('SessionStart · resume')
    expect(hookEventWords({ agent: 'codex', event: 'Stop', toolName: null, source: null })).toBe('Stop')
  })

  it('reads every counted compaction as "Conversation compacted" and leaves the rest in the harness words', () => {
    const words = (agent: 'claude' | 'codex' | 'opencode' | 'cursor', event: string, source: string | null) =>
      hookEventWords({ agent, event, source, toolName: null })
    expect(words('claude', 'SessionStart', 'compact')).toBe('Conversation compacted')
    expect(words('codex', 'SessionStart', 'compact')).toBe('Conversation compacted')
    expect(words('codex', 'PostCompact', 'manual')).toBe('Conversation compacted')
    expect(words('opencode', 'session.compacted', null)).toBe('Conversation compacted')
    // Counted once: Codex's automatic PostCompact is followed by its SessionStart compact.
    expect(words('codex', 'PostCompact', 'auto')).toBe('PostCompact · auto')
    expect(words('codex', 'PreCompact', 'manual')).toBe('PreCompact · manual')
    expect(words('opencode', 'session.compacted', 'subagent')).toBe('session.compacted · subagent')
    expect(words('claude', 'SessionStart', 'startup')).toBe('SessionStart · startup')
    expect(words('cursor', 'SessionStart', 'compact')).toBe('SessionStart · compact')
  })

  it('says what the event changed, including when it changed nothing', () => {
    expect(hookEffectWords([])).toBe('changed nothing')
    expect(hookEffectWords(['opened'])).toBe('opened a request')
    expect(hookEffectWords(['answered'])).toBe('answered a request')
    expect(hookEffectWords(['withdrew', 'opened'])).toBe('withdrew a request and opened a request')
    expect(hookEffectWords(['answered', 'withdrew', 'opened']))
      .toBe('answered a request, withdrew a request and opened a request')
  })
})
