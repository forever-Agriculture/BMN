// MODULE: hook-events-dialog.test.ts - the plain words the hook event list shows for an event and its effects
import { describe, expect, it } from 'vitest'
import { hookEffectWords, hookEventWords } from './hook-events-dialog'

describe('hook event words', () => {
  it('names the event, the tool it ran and the source the harness gave', () => {
    expect(hookEventWords({ event: 'PostToolUse', toolName: 'Bash', source: null })).toBe('PostToolUse · Bash')
    expect(hookEventWords({ event: 'SessionStart', toolName: null, source: 'resume' })).toBe('SessionStart · resume')
    expect(hookEventWords({ event: 'Stop', toolName: null, source: null })).toBe('Stop')
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
