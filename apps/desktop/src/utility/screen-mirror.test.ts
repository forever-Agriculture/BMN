// MODULE: screen-mirror.test.ts - the headless screen copy and the dialog rules checked against recorded screens
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OutputTail,
  ScreenMirror,
  claudePermissionOnScreen,
  claudeReviewOnScreen,
  normalizeScreenText,
  questionOnScreen,
  type ScreenQuestion
} from './screen-mirror'

const SCREENS = join(__dirname, 'test-fixtures', 'remote-answers', 'screens')
const screen = (name: string): string[] => readFileSync(join(SCREENS, name), 'utf8').split('\n')
const question = (text: string, ...labels: string[]): ScreenQuestion => ({ text, options: labels.map((label) => ({ label })) })

const AUTH = question('Which auth method should the API use?', 'JWT', 'Session cookies', 'OAuth only')
const ROLLOUT = question(
  'Which rollout plan should we follow for the new authentication service across all regional clusters this quarter?',
  'Gradual regional rollout starting with Europe', 'Big bang'
)
const DATABASE = question('Which database should store users?', 'Postgres', 'SQLite')
const TESTS = question('Add integration tests now?', 'Yes', 'Later')
const DEPLOY = question('Where to deploy first?', 'Staging', 'Production')

describe('OutputTail', () => {
  it('keeps at least the limit of the newest bytes, oldest first', () => {
    const tail = new OutputTail(8)
    for (const chunk of ['abc', 'def', 'ghi', 'jkl']) tail.push(new TextEncoder().encode(chunk))
    const kept = new TextDecoder().decode(tail.read())
    expect(kept.endsWith('jkl')).toBe(true)
    expect(kept.length).toBeGreaterThanOrEqual(8)
    expect('abcdefghijkl'.endsWith(kept)).toBe(true)
  })

  it('keeps only the end of one oversized chunk', () => {
    const tail = new OutputTail(4)
    tail.push(new TextEncoder().encode('0123456789'))
    expect(new TextDecoder().decode(tail.read())).toBe('6789')
  })
})

describe('ScreenMirror', () => {
  it('draws what the program printed, seeded from the tail, and joins soft-wrapped rows without losing spaces', async () => {
    const mirror = new ScreenMirror(10, 4, new TextEncoder().encode('seeded\r\n'))
    mirror.write(new TextEncoder().encode('hello big world\r\n'))
    await mirror.settled()
    expect(mirror.lines().slice(0, 2)).toEqual(['seeded', 'hello big world'])
    mirror.dispose()
  })

  it('follows a resize and tells listeners the screen changed', async () => {
    const mirror = new ScreenMirror(20, 4)
    let changes = 0
    const stop = mirror.onChange(() => (changes += 1))
    mirror.write(new TextEncoder().encode('x'))
    await mirror.settled()
    mirror.resize(30, 5)
    expect(mirror.lines()).toHaveLength(5)
    expect(changes).toBeGreaterThanOrEqual(2)
    stop()
    mirror.dispose()
    // A disposed mirror ignores late output instead of throwing on the PTY path.
    mirror.write(new TextEncoder().encode('late'))
  })
})

describe('recognising the recorded dialogs', () => {
  it('normalises frame and cursor glyphs away', () => {
    expect(normalizeScreenText('│ Which  rollout ❯ ☐')).toBe('Which rollout')
  })

  it('finds a Claude question at 200 and 80 columns, including text wrapped with a frame', () => {
    expect(questionOnScreen(screen('claude-single-200.txt'), 'claude', AUTH)).toBe(true)
    expect(questionOnScreen(screen('claude-single-80.txt'), 'claude', ROLLOUT)).toBe(true)
  })

  it('does not take the owner\'s echoed prompt, a changed label or a missing option for the dialog', () => {
    const lines = screen('claude-single-200.txt')
    expect(questionOnScreen(lines, 'claude', question(AUTH.text, 'JWT', 'Session cookies'))).toBe(false)
    expect(questionOnScreen(lines, 'claude', question(AUTH.text, 'JWT', 'OAuth only', 'Session cookies'))).toBe(false)
    expect(questionOnScreen(lines, 'claude', question('Which auth method?', 'JWT', 'Session cookies', 'OAuth only'))).toBe(false)
    // The echoed prompt names the question but has no option list under it.
    expect(questionOnScreen(screen('claude-three-review.txt'), 'claude', AUTH)).toBe(false)
    // Codex numbers its extra entry differently, so one harness's rule never reads the other's dialog.
    expect(questionOnScreen(lines, 'codex', AUTH)).toBe(false)
  })

  it('follows each step of Claude\'s three-question dialog and reads its review', () => {
    expect(questionOnScreen(screen('claude-three-step1.txt'), 'claude', DATABASE)).toBe(true)
    expect(questionOnScreen(screen('claude-three-step2.txt'), 'claude', TESTS)).toBe(true)
    expect(questionOnScreen(screen('claude-three-step2.txt'), 'claude', DATABASE)).toBe(false)
    expect(questionOnScreen(screen('claude-three-step3.txt'), 'claude', DEPLOY)).toBe(true)
    const review = screen('claude-three-review.txt')
    expect(claudeReviewOnScreen(review, [DATABASE, TESTS, DEPLOY], ['Postgres', 'Later', 'Staging'])).toBe(1)
    expect(claudeReviewOnScreen(review, [DATABASE, TESTS, DEPLOY], ['Postgres', 'Yes', 'Staging'])).toBeNull()
    expect(claudeReviewOnScreen(review, [DATABASE, TESTS, DEPLOY], null)).toBe(1)
    expect(claudeReviewOnScreen(screen('claude-three-step3.txt'), [DATABASE, TESTS, DEPLOY], null)).toBeNull()
  })

  it('does not read Claude\'s multi-select dialog as a single choice', () => {
    const lines = screen('claude-multiselect.txt')
    expect(questionOnScreen(lines, 'claude', question('Which features should ship first?', 'Rate limiting', 'Audit log', 'SSO'))).toBe(false)
  })

  it('reads the allow-once and deny digits of Claude\'s Bash permission for exactly that command', () => {
    const lines = screen('claude-bash-permission.txt')
    expect(claudePermissionOnScreen(lines, 'Bash', 'touch spike-allow.txt')).toEqual({ allow: 1, deny: 3 })
    expect(claudePermissionOnScreen(lines, 'Bash', 'touch spike-allow')).toBeNull()
    expect(claudePermissionOnScreen(lines, 'Bash', 'touch spike-allow.txt other.txt')).toBeNull()
    expect(claudePermissionOnScreen(lines, 'Edit', 'touch spike-allow.txt')).toBeNull()
    expect(claudePermissionOnScreen(screen('claude-bash-denied.txt'), 'Bash', 'touch spike-allow.txt')).toBeNull()
  })

  it('finds a Codex question at 200 and 80 columns, with its description column beside the labels', () => {
    expect(questionOnScreen(screen('codex-single-200.txt'), 'codex', AUTH, { index: 0, count: 1 })).toBe(true)
    expect(questionOnScreen(screen('codex-single-80.txt'), 'codex', ROLLOUT, { index: 0, count: 1 })).toBe(true)
  })

  it('checks Codex\'s own step counter, so a step is never mistaken for another', () => {
    const first = screen('codex-two-step1.txt')
    const second = screen('codex-two-step2.txt')
    expect(questionOnScreen(first, 'codex', DATABASE, { index: 0, count: 2 })).toBe(true)
    expect(questionOnScreen(first, 'codex', DATABASE, { index: 1, count: 2 })).toBe(false)
    expect(questionOnScreen(second, 'codex', TESTS, { index: 1, count: 2 })).toBe(true)
    expect(questionOnScreen(second, 'codex', DATABASE, { index: 0, count: 2 })).toBe(false)
  })

  it('finds no answerable dialog in Codex\'s async question, which is only a message', () => {
    expect(questionOnScreen(screen('codex-async.txt'), 'codex', question('Which color should the logo use?', 'Gold', 'Black'))).toBe(false)
  })
})
