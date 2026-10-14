// MODULE: turn-marks.test.ts - the hook's table of recorded apps is the protocol's, a mark names where and which turn and never what was typed, and the switch is read from BMN's own word beside its socket
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  TURN_END_KINDS, TURN_MARK_CONFIRMED_STATUSES, TURN_MARK_LIMIT_MS as PROTOCOL_LIMIT_MS, TURN_RECORDED_APPS, TURN_SWITCH_FOLDER, TURN_APP_NAMES
} from '@bmn/protocol'
import { TURN_MARKS, TURN_MARK_CONFIRMED, TURN_MARK_LIMIT_MS, turnFacts, turnMark, turnMarksWanted, turnStanding, turnSwitchFile } from '../../bin/turn-marks.mjs'

const CONVERSATION = '01a0b657-21a8-7f00-addd-b73646828f5b'
const folders: string[] = []
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

describe('the hook\'s turn marks', () => {
  it('holds the same apps, versions, limit and confirmed statuses as the protocol', () => {
    expect(TURN_MARKS).toEqual(TURN_RECORDED_APPS)
    expect(TURN_MARKS).toEqual({
      claude: { version: '2.1.296', promptEvent: 'UserPromptSubmit', promptArrives: 'typed' },
      codex: { version: '0.162.1', promptEvent: 'UserPromptSubmit', promptArrives: 'taken' }
    })
    expect(TURN_MARK_LIMIT_MS).toBe(PROTOCOL_LIMIT_MS)
    expect(TURN_MARK_LIMIT_MS).toBe(300)
    expect(TURN_MARK_CONFIRMED).toEqual(TURN_MARK_CONFIRMED_STATUSES)
    expect(turnSwitchFile('/run/bmn/control', 'session-1')).toBe(join('/run/bmn/control', TURN_SWITCH_FOLDER, 'session-1'))
    for (const app of Object.keys(TURN_MARKS)) expect(turnStanding(app)).toContain(`${TURN_APP_NAMES[app]} ${TURN_MARKS[app]?.version}`)
  })

  it('marks a start with the conversation, the turn and the folder, and nothing of the prompt', () => {
    const event = { hook_event_name: 'UserPromptSubmit', session_id: CONVERSATION.toUpperCase(), prompt_id: 'p-1', turn_id: 't-1', cwd: '/work/app', prompt: 'SECRET words' }
    expect(turnMark('claude', event)).toEqual({ edge: 'start', app: 'claude', conversation: CONVERSATION, turn: 'p-1', folder: '/work/app' })
    expect(turnMark('codex', event)).toEqual({ edge: 'start', app: 'codex', conversation: CONVERSATION, turn: 't-1', folder: '/work/app' })
    expect(turnMark('codex', { ...event, turn_id: undefined, cwd: 'relative' })).toEqual({ edge: 'start', app: 'codex', conversation: CONVERSATION })
    expect(turnMark('claude', { ...event, prompt: '<task-notification>done' })).toMatchObject({ continued: true })
    // Codex has no such prompt of its own.
    expect(turnMark('codex', { ...event, prompt: '<task-notification>done' })).not.toHaveProperty('continued')
  })

  it('marks an end only at an event that was measured to end a turn', () => {
    const stop = { hook_event_name: 'Stop', session_id: CONVERSATION, prompt_id: 'p-1', turn_id: 't-1' }
    expect(turnMark('claude', stop)).toEqual({ edge: 'end', kind: 'finished', app: 'claude', conversation: CONVERSATION, turn: 'p-1' })
    expect(turnMark('claude', { ...stop, background_tasks: [{}] })).toMatchObject({ kind: 'continues' })
    expect(turnMark('codex', { ...stop, background_tasks: [{}] })).toMatchObject({ kind: 'finished' })
    expect(turnMark('codex', { ...stop, hook_event_name: 'Interrupt' })).toMatchObject({ kind: 'interrupted' })
    expect(turnMark('claude', { ...stop, hook_event_name: 'Interrupt' })).toBeNull()
    for (const kind of ['finished', 'continues', 'interrupted']) expect(TURN_END_KINDS).toContain(kind)
  })

  it('marks nothing for a sub-agent, an app that is not recorded, another event, or an event without a conversation', () => {
    const event = { hook_event_name: 'UserPromptSubmit', session_id: CONVERSATION, prompt_id: 'p-1' }
    expect(turnMark('claude', { ...event, agent_id: 'a-1' })).toBeNull()
    expect(turnMark('opencode', event)).toBeNull()
    expect(turnMark('constructor', event)).toBeNull()
    expect(turnMark('claude', { ...event, hook_event_name: 'PostToolUse' })).toBeNull()
    expect(turnMark('claude', { ...event, session_id: 'no reference' })).toBeNull()
  })

  it('says of any event which conversation and turn it belongs to, and whether a sub-agent speaks', () => {
    expect(turnFacts('codex', { session_id: CONVERSATION, turn_id: 't-9', agent_id: 'a-1' })).toEqual({ conversation: CONVERSATION, turn: 't-9', nested: true })
    expect(turnFacts('claude', { session_id: CONVERSATION, prompt_id: 'has a space' })).toEqual({ conversation: CONVERSATION })
    expect(turnFacts('claude', { session_id: 'no reference', prompt_id: 'p-1' })).toEqual({})
    expect(turnFacts('opencode', { session_id: CONVERSATION })).toEqual({})
  })

  it('wants marks only where BMN wrote down that this very session records', () => {
    const control = mkdtempSync(join(tmpdir(), 'bmn-turn-marks-'))
    folders.push(control)
    const socket = join(control, 'control.sock')
    expect(turnMarksWanted(socket, 'session-1')).toBe(false)
    mkdirSync(join(control, TURN_SWITCH_FOLDER))
    writeFileSync(join(control, TURN_SWITCH_FOLDER, 'session-1'), '')
    expect(turnMarksWanted(socket, 'session-1')).toBe(true)
    expect(turnMarksWanted(socket, 'session-2')).toBe(false)
    expect(turnMarksWanted(socket, '../turn-marks/session-1')).toBe(false)
    expect(turnMarksWanted(socket, undefined)).toBe(false)
    expect(turnMarksWanted(undefined, 'session-1')).toBe(false)
  })
})
