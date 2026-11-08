// MODULE: away-skills-startup.test.mjs - 113.3 method 3: replay the real captured startup screens and their mutations
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { classifyScreen, startupStep, visibleScreen } from '../test/away-skills-startup.mjs'

const fixtures = JSON.parse(readFileSync(new URL('./fixtures/away-skills-startup-captures.json', import.meta.url), 'utf8'))
const { codex, claude } = fixtures.apps
// Method 4's first codex qualification: trust, the composer 715 ms after Enter (footer still "default"), then settled.
const codexQualified = fixtures.qualifications.codex
// Method 4's first Claude qualification: negative default, Down, affirmative, Enter, then the composer as its footer rotates.
const claudeQualified = fixtures.qualifications.claude
const replace = (screen, from, to) => screen.map(line => line === from ? to : line)
const blankBelow = (lines, rows = 32) => [...lines, ...Array(Math.max(0, rows - lines.length)).fill('')]

// Driver loop over a fixed screen sequence: what the state machine would send, observation by observation.
function drive(app, screens, fixture, { stepMs = 2000 } = {}) {
  const history = [], sent = []
  let answered = false, downSent = false
  for (const [index, screen] of screens.entries()) {
    const { state, detail } = classifyScreen(app, screen, fixture)
    history.push({ at: index * stepMs, state, detail, screen: screen.join('\n') })
    const step = startupStep(history, { answered, downSent, keys: sent.length })
    if (step.action === 'down' || step.action === 'enter') { if (step.action === 'enter') answered = true; else downSent = true; sent.push(step.action); continue }
    if (step.action === 'ready' || step.action === 'fail') return { sent, outcome: step }
  }
  return { sent, outcome: { action: 'timeout' } }
}

const codexComposer = codexQualified.sequence.at(-1).screen
// The earlier raw capture (native-clean/codex-startup-screen.raw) showed this transient composer-like frame before the trust dialog.
const codexTransient = blankBelow(['╭───────────────────────────────────────╮', '│ >_ OpenAI Codex (v0.167.0)            │', '╰───────────────────────────────────────╯', '', '  loading', '', '› Ask Codex to do anything'])
const claudeComposer = claudeQualified.sequence.at(-1).screen

describe('captured trust dialogs', () => {
  it('codex: the real screen is its fixture trust dialog with the affirmative option selected', () => {
    expect(classifyScreen('codex', codex.screen, codex.fixture)).toMatchObject({ state: 'trust' })
  })
  it('claude: the real screen is its fixture trust dialog with the default negative option selected', () => {
    expect(classifyScreen('claude', claude.screen, claude.fixture)).toMatchObject({ state: 'trust-negative' })
  })
  it('claude with the selector moved to "Yes, I trust this folder" is the affirmative trust state', () => {
    const moved = replace(replace(claude.screen, ' ❯ No, exit', '   No, exit'), '   Yes, I trust this folder', ' ❯ Yes, I trust this folder')
    expect(classifyScreen('claude', moved, claude.fixture)).toMatchObject({ state: 'trust' })
  })
  it('a fixture path the shell echoed is not enough: the dialog block must carry it', () => {
    // Only the dialog's own path line changes; the launch echo above still carries the right path.
    const otherPath = claude.screen.map(line => line === ' ive-m3/capture-claude/project' ? ' ive-m3/capture-claude/other' : line)
    expect(otherPath.join('\n')).toContain('native-m3/capture-claude/project')
    expect(otherPath).not.toEqual(claude.screen)
    const prefixOnly = claude.screen.map(line => line === ' ive-m3/capture-claude/project' ? ' ive-m3/capture-claude/project/sub' : line)
    expect(classifyScreen('claude', prefixOnly, claude.fixture)).toMatchObject({ state: 'dialog', detail: 'trust dialog without this fixture path' })
    expect(classifyScreen('claude', otherPath, claude.fixture)).toMatchObject({ state: 'dialog', detail: 'trust dialog without this fixture path' })
    expect(classifyScreen('codex', codex.screen.map(line => line.replace('ative-m3/capture-codex/project', 'ative-m3/capture-codex/elsewhere')), codex.fixture)).toMatchObject({ state: 'dialog' })
  })
  it('another fixture, a changed selection, a third option or a missing footer is a dialog', () => {
    expect(classifyScreen('codex', codex.screen, `${codex.fixture}2`).state).toBe('dialog')
    const second = replace(replace(codex.screen, '› 1. Trust and continue', '  1. Trust and continue'), '  2. Back to Agent Command Center', '› 2. Back to Agent Command Center')
    expect(classifyScreen('codex', second, codex.fixture)).toMatchObject({ state: 'dialog', detail: 'trust dialog with another selection' })
    const third = codex.screen.map(line => line === '  2. Back to Agent Command Center' ? `${line}\n` : line).flatMap(line => line.endsWith('\n') ? [line.trimEnd(), '  3. Always trust'] : [line])
    expect(classifyScreen('codex', third, codex.fixture)).toMatchObject({ state: 'dialog', detail: 'trust dialog options differ from the captured ones' })
    expect(classifyScreen('claude', replace(claude.screen, ' Enter to confirm · Esc to cancel', ''), claude.fixture).state).toBe('dialog')
    const noSelector = replace(claude.screen, ' ❯ No, exit', '   No, exit')
    expect(classifyScreen('claude', noSelector, claude.fixture)).toMatchObject({ state: 'dialog', detail: 'trust dialog without exactly one selected option' })
  })
  it('one app never reads the other app\'s trust dialog as its own', () => {
    expect(classifyScreen('claude', codex.screen, codex.fixture).state).toBe('dialog')
    expect(classifyScreen('codex', claude.screen, claude.fixture).state).toBe('dialog')
  })
})

describe('other screens', () => {
  it('blocking prompts are dialogs, never composers', () => {
    for (const [screen, detail] of [
      [['Hooks need review', '  Esc to continue'], 'hooks review'],
      [['Please sign in to continue', '› 1. Sign in with ChatGPT', '  2. Provide your own API key'], 'login'],
      [['Update available! 0.168.0', '› 1. Update now', '  2. Skip'], 'update'],
      [['Choose the text style that looks best', '❯ 1. Dark mode', '  2. Light mode'], 'onboarding'],
      [['Do you want to run this command?', '› 1. Yes', '  2. No'], 'permission']
    ]) expect(classifyScreen('codex', blankBelow(screen), '/x')).toMatchObject({ state: 'dialog', detail })
    expect(classifyScreen('claude', blankBelow(['Something new', '❯ 1. Fine', '  2. Not fine']), '/x')).toMatchObject({ state: 'dialog', detail: 'unknown option list' })
    expect(classifyScreen('claude', blankBelow(['Something new', 'Enter to confirm · Esc to cancel']), '/x')).toMatchObject({ state: 'dialog', detail: 'unknown dialog footer' })
  })
  it('composers need their ready footer and no dialog markers; the transient codex frame is loading', () => {
    expect(classifyScreen('codex', codexComposer, codex.fixture).state).toBe('composer')
    expect(classifyScreen('codex', codexTransient, codex.fixture).state).toBe('loading')
    expect(classifyScreen('codex', codexComposer.map(line => / · ~\//u.test(line) ? '' : line), codex.fixture).state).toBe('loading')
    expect(classifyScreen('codex', codexComposer.map(line => line.includes('>_ OpenAI Codex') ? '' : line), codex.fixture).state).toBe('loading')
    expect(classifyScreen('codex', [...codexComposer.slice(0, 12), '› second prompt'], codex.fixture).state).toBe('loading')
    expect(classifyScreen('claude', claudeComposer, claude.fixture).state).toBe('composer')
    expect(classifyScreen('claude', [...claudeComposer.slice(0, 8), '  enter continue · esc back'], claude.fixture).state).toBe('dialog')
  })
  it('visibleScreen keeps the last rows, right-trimmed', () => {
    expect(visibleScreen({ bufferLines: ['old', 'a  ', 'b'], rows: 2 })).toEqual(['a', 'b'])
  })
})

describe('startup state machine on replayed sequences', () => {
  it('codex: trust → one Enter → stable composer is ready', () => {
    expect(drive('codex', [codex.screen, codexComposer, codexComposer], codex.fixture)).toEqual({ sent: ['enter'], outcome: { action: 'ready' } })
  })
  it('codex: the real qualification sequence is ready only once its footer has settled', () => {
    const [trust, early, settled] = codexQualified.sequence.map(entry => entry.screen)
    expect(codexQualified.sequence.map(entry => entry.origin)).toEqual(['periodic', 'after enter', 'periodic'])
    for (const screen of [early, settled]) expect(classifyScreen('codex', screen, codexQualified.fixture).state).toBe('composer')
    expect(drive('codex', [trust, early, settled], codexQualified.fixture)).toEqual({ sent: ['enter'], outcome: { action: 'timeout' } })
    expect(drive('codex', [trust, early, settled, settled], codexQualified.fixture)).toEqual({ sent: ['enter'], outcome: { action: 'ready' } })
    // The full transient → trust → default footer → high footer sequence (transient frame from native-clean's raw capture).
    const transient = codexTransient.map(line => line)
    expect(drive('codex', [transient, trust, early, settled, settled], codexQualified.fixture)).toEqual({ sent: ['enter'], outcome: { action: 'ready' } })
  })
  it('claude: the real qualification sequence is Down, Enter, then ready once the rotating footer settles', () => {
    const screens = claudeQualified.sequence.map(entry => entry.screen)
    expect(claudeQualified.sequence.map(entry => entry.origin).slice(0, 3)).toEqual(['periodic', 'after down', 'after enter'])
    expect(screens.slice(2).map(screen => classifyScreen('claude', screen, claudeQualified.fixture).state)).toEqual(screens.slice(2).map(() => 'composer'))
    expect(drive('claude', screens, claudeQualified.fixture)).toEqual({ sent: ['down', 'enter'], outcome: { action: 'timeout' } })
    expect(drive('claude', [...screens, screens.at(-1)], claudeQualified.fixture)).toEqual({ sent: ['down', 'enter'], outcome: { action: 'ready' } })
  })
  it('claude composer negatives: header, rules, footer and a single prompt are all required', () => {
    const settled = claudeQualified.sequence.at(-1).screen
    const at = settled.findIndex(line => /^❯\s/u.test(line)) // Claude puts a no-break space after its prompt glyph
    const without = index => settled.map((line, i) => i === index ? '' : line)
    expect(classifyScreen('claude', settled, claudeQualified.fixture).state).toBe('composer')
    expect(classifyScreen('claude', without(settled.findIndex(line => /Claude Code v/u.test(line))), claudeQualified.fixture).state).toBe('loading')
    expect(classifyScreen('claude', without(at - 1), claudeQualified.fixture).state).toBe('loading')
    expect(classifyScreen('claude', without(at + 1), claudeQualified.fixture).state).toBe('loading')
    expect(classifyScreen('claude', settled.map(line => /⏵⏵/u.test(line) ? '' : line), claudeQualified.fixture).state).toBe('loading')
    expect(classifyScreen('claude', settled.map((line, i) => i === at + 3 ? '❯ again' : line), claudeQualified.fixture)).toMatchObject({ state: 'loading', detail: 'more than one prompt line' })
    expect(classifyScreen('claude', settled.map((line, i) => i === at + 3 ? '  loading' : line), claudeQualified.fixture).state).toBe('loading')
    expect(classifyScreen('claude', settled.map((line, i) => i === at + 3 ? '  Update available! Restart to update' : line), claudeQualified.fixture).state).toBe('dialog')
  })
  it('codex composer negatives: order, missing parts, duplicate prompt, loading and blocking dialogs are never ready', () => {
    const settled = codexQualified.sequence.at(-1).screen
    const prompt = settled.findIndex(line => line.startsWith('› '))
    const footer = settled.findLastIndex(line => / · ~\//u.test(line))
    const swapped = settled.map((line, index) => index === prompt ? settled[footer] : index === footer ? settled[prompt] : line)
    expect(classifyScreen('codex', swapped, codexQualified.fixture).state).toBe('loading')
    expect(classifyScreen('codex', settled.map((line, index) => index === prompt + 1 ? '  loading' : line), codexQualified.fixture).state).toBe('loading')
    for (const [blocking, detail] of [['  Hooks need review', 'hooks review'], ['  Update available! 0.168.0', 'update'], ['  Please sign in', 'login']])
      expect(classifyScreen('codex', settled.map((line, index) => index === prompt - 1 ? blocking : line), codexQualified.fixture)).toMatchObject({ state: 'dialog', detail })
  })
  it('immediate duplicate captures never establish readiness', () => {
    const settled = codexQualified.sequence.at(-1).screen.join('\n')
    expect(startupStep([{ at: 0, state: 'composer', screen: 'a' }, { at: 2500, state: 'composer', screen: settled }, { at: 2700, state: 'composer', screen: settled }], { answered: true })).toEqual({ action: 'wait' })
    expect(startupStep([{ at: 0, state: 'composer', screen: settled }, { at: 2100, state: 'composer', screen: settled }], { answered: true })).toEqual({ action: 'ready' })
  })
  it('the machine only ever asks for Down or Enter: no case prompt can precede readiness', () => {
    const [trust, early, settled] = codexQualified.sequence.map(entry => entry.screen)
    const run = drive('codex', [trust, early, settled, settled], codexQualified.fixture)
    expect(run.sent.every(key => key === 'down' || key === 'enter')).toBe(true)
    expect(run.outcome.action).toBe('ready')
  })
  it('codex: the transient composer frame before trust is never ready', () => {
    expect(drive('codex', [codexTransient, codex.screen, codex.screen], codex.fixture)).toEqual({ sent: ['enter'], outcome: { action: 'fail', reason: 'trust dialog persisted after its one answer' } })
  })
  it('claude: negative default → one Down → affirmative → one Enter → stable composer is ready', () => {
    const moved = replace(replace(claude.screen, ' ❯ No, exit', '   No, exit'), '   Yes, I trust this folder', ' ❯ Yes, I trust this folder')
    expect(drive('claude', [claude.screen, moved, claudeComposer, claudeComposer], claude.fixture)).toEqual({ sent: ['down', 'enter'], outcome: { action: 'ready' } })
  })
  it('claude: a Down that did not move the selection sends nothing more', () => {
    expect(drive('claude', [claude.screen, claude.screen], claude.fixture)).toEqual({ sent: ['down'], outcome: { action: 'fail', reason: 'trust selection did not reach the affirmative option after one Down' } })
  })
  it('a persisting trust dialog after its Enter is never answered twice', () => {
    expect(drive('codex', [codex.screen, codex.screen, codex.screen], codex.fixture).sent).toEqual(['enter'])
    const moved = replace(replace(claude.screen, ' ❯ No, exit', '   No, exit'), '   Yes, I trust this folder', ' ❯ Yes, I trust this folder')
    expect(drive('claude', [claude.screen, moved, moved, moved], claude.fixture)).toEqual({ sent: ['down', 'enter'], outcome: { action: 'fail', reason: 'trust dialog persisted after its one answer' } })
    // The dialog reappearing with its negative default after the Enter: still two keys, then fail.
    expect(drive('claude', [claude.screen, moved, claude.screen, claude.screen], claude.fixture)).toMatchObject({ sent: ['down', 'enter'], outcome: { action: 'fail' } })
  })
  it('replay key counts: malformed 0, unsuccessful Down 1, Down to a loading frame 1, valid Down then Enter 2', () => {
    const duplicate = replace(claude.screen, '   Yes, I trust this folder', ' ❯ Yes, I trust this folder')
    expect(classifyScreen('claude', duplicate, claude.fixture)).toMatchObject({ state: 'dialog' })
    expect(drive('claude', [duplicate], claude.fixture).sent).toEqual([])
    expect(drive('claude', [claude.screen, claude.screen], claude.fixture).sent).toEqual(['down'])
    expect(drive('claude', [claude.screen, blankBelow(['loading'])], claude.fixture)).toEqual({ sent: ['down'], outcome: { action: 'fail', reason: 'trust selection did not reach the affirmative option after one Down' } })
    const moved = replace(replace(claude.screen, ' ❯ No, exit', '   No, exit'), '   Yes, I trust this folder', ' ❯ Yes, I trust this folder')
    expect(drive('claude', [claude.screen, moved, claudeComposer, claudeComposer], claude.fixture).sent).toEqual(['down', 'enter'])
    expect(startupStep([{ at: 0, state: 'trust' }], { answered: false, downSent: true, keys: 2 })).toMatchObject({ action: 'fail' })
  })
  it('unknown, login, update, onboarding and hooks dialogs get zero keys', () => {
    for (const screen of [['Hooks need review'], ['Please log in', '› 1. Sign in'], ['Update available', '› 1. Update now'], ['Welcome to Claude Code', '❯ 1. Dark mode'], ['What now?', '› 1. This', '  2. That']])
      expect(drive('codex', [blankBelow(screen)], '/x')).toMatchObject({ sent: [], outcome: { action: 'fail' } })
  })
  it('wrong path or changed selection get zero keys', () => {
    expect(drive('codex', [codex.screen], `${codex.fixture}x`).sent).toEqual([])
    const second = replace(replace(codex.screen, '› 1. Trust and continue', '  1. Trust and continue'), '  2. Back to Agent Command Center', '› 2. Back to Agent Command Center')
    expect(drive('codex', [second], codex.fixture).sent).toEqual([])
  })
  it('a single composer observation is not ready; a dialog between composers restarts the stability window', () => {
    expect(drive('codex', [codexComposer], codex.fixture).outcome.action).toBe('timeout')
    expect(drive('codex', [codexComposer, codexTransient, codexComposer], codex.fixture).outcome.action).toBe('timeout')
    expect(startupStep([{ at: 0, state: 'composer' }, { at: 1000, state: 'composer' }], { answered: false })).toEqual({ action: 'wait' })
  })
  it('only the driver\'s own keys count: no prompt is ever produced by the machine', () => {
    const actions = new Set()
    for (const state of ['loading', 'composer', 'trust', 'trust-negative', 'dialog']) for (const answered of [false, true]) for (const downSent of [false, true]) for (const keys of [0, 1, 2, 3])
      actions.add(startupStep([{ at: 0, state }, { at: 5000, state }], { answered, downSent, keys }).action)
    expect([...actions].sort()).toEqual(['down', 'enter', 'fail', 'ready', 'wait'])
  })
})
