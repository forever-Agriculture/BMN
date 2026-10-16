// MODULE: shell-menus.test.ts - Story 75.10 AC2: the menus hold what the owner does by hand; the read-only views open from the palette
import { describe, expect, it } from 'vitest'
import type { MenuEntry } from './popup-menu'
import { paneMenu, readOnlyViewCommands, sessionMenu, workspaceMenu } from './shell-menus'

const noop = (): void => {}
/** A menu as the owner reads it: each entry's words, a rule for a separator, the group's name for a choice. */
const read = (entries: MenuEntry[]): string[] => entries.map((entry) => entry === 'separator' ? '—' : 'group' in entry ? `[${entry.group}]` : entry.label)
const MARKER = { group: 'Marker', selected: 'none', options: [{ value: 'none', label: 'None' }], onChoose: noop }
const READ_ONLY = ['Review results…', 'Messages…', 'Progress details', 'Turn changes…', 'Hook events…', 'dev-auto runs…', 'Plan use…']
const sessionActs = { splitBeside: noop, details: noop, toggleQuiet: noop, editLaunch: noop, move: noop, stop: noop, startAgain: noop, archive: noop }
const paneActs = { details: noop, search: noop, copy: noop, paste: noop, selectAll: noop, sendNextKey: noop, resetModes: noop, arrange: noop, newSession: noop, editLaunch: noop, stop: noop }
const viewActs = { results: noop, messages: noop, progress: noop, turnChanges: noop, hookEvents: noop, devAutoRuns: noop, planUse: noop }

describe('the menus hold only what the owner does by hand (Story 75.10 AC2)', () => {
  it('Workspace ⋯: Pinned files…, New session here, Rename…, Move up, Move down, the marker, Archive', () => {
    const menu = workspaceMenu({ archived: false, running: false, first: true, last: false }, MARKER, { pins: noop, newSession: noop, rename: noop, move: noop, archive: noop })
    expect(read(menu)).toEqual(['Pinned files…', 'New session here', 'Rename…', 'Move up', 'Move down', '—', '[Marker]', '—', 'Archive workspace'])
    expect(read(workspaceMenu({ archived: true, running: false, first: false, last: true }, MARKER, { pins: noop, newSession: noop, rename: noop, move: noop, archive: noop })).at(-1)).toBe('Restore workspace')
    const running = workspaceMenu({ archived: false, running: true, first: false, last: false }, MARKER, { pins: noop, newSession: noop, rename: noop, move: noop, archive: noop }).at(-1)
    expect(running).toMatchObject({ label: 'Archive workspace', disabled: true, title: 'Stop this workspace’s running sessions before archiving.' })
  })

  it('Session ⋯: Split beside, Session details, quiet hours, Edit launch settings, Move up, Move down, Stop or Start again, Archive', () => {
    const state = { archived: false, live: true, first: false, last: false, quietAllowed: false, quietFull: false, launchDisabled: undefined }
    expect(read(sessionMenu(state, sessionActs))).toEqual(['Split beside', 'Session details', 'Allow through quiet hours', 'Edit launch settings', 'Move up', 'Move down', '—', 'Stop session…', 'Archive session'])
    expect(read(sessionMenu({ ...state, live: false, quietAllowed: true }, sessionActs))).toEqual(['Split beside', 'Session details', 'Stop allowing through quiet hours', 'Edit launch settings', 'Move up', 'Move down', '—', 'Start again', 'Archive session'])
    expect(read(sessionMenu({ ...state, archived: true }, sessionActs))).toEqual(['Session details', '—', 'Restore session'])
  })

  it('Pane More: the terminal\'s own commands, the layout and Stop', () => {
    const menu = paneMenu({ live: true, panes: 2, stacked: false, canStartHere: true }, paneActs)
    expect(read(menu)).toEqual(['Session details', 'Search output', 'Copy selection', 'Paste', 'Select all', 'Send next key to terminal', 'Reset terminal modes', 'Arrange stacked',
      'New session in this workspace', 'Edit launch settings', '—', 'Stop session…'])
  })

  it('no menu offers a read-only view, a launch set or a switch 75.3 and 75.4 removed', () => {
    const all = [
      ...workspaceMenu({ archived: false, running: false, first: false, last: false }, MARKER, { pins: noop, newSession: noop, rename: noop, move: noop, archive: noop }),
      ...sessionMenu({ archived: false, live: true, first: false, last: false, quietAllowed: false, quietFull: false, launchDisabled: undefined }, sessionActs),
      ...paneMenu({ live: true, panes: 1, stacked: true, canStartHere: true }, paneActs)
    ]
    for (const words of [...READ_ONLY, 'Save a launch set…', 'Launch set…', 'Receive messages', 'Record what each turn changes', 'Resume recording…', 'Sessions here may message each other']) {
      expect(read(all)).not.toContain(words)
    }
  })
})

describe('the read-only views open from the palette (Story 75.10 AC2)', () => {
  it('lists them together, each with the workspace or session it is about', () => {
    const commands = readOnlyViewCommands({ workspace: 'BMN', session: 'Lead', progress: true, turnRecorded: true }, viewActs)
    expect(commands.map((command) => command.label)).toEqual(READ_ONLY)
    expect(commands.map((command) => command.context)).toEqual(['BMN', 'BMN', 'Lead', 'Lead', 'Lead', undefined, undefined])
    expect(commands.every((command) => command.group === 'Commands' && command.disabled !== true)).toBe(true)
  })

  it('leaves out what has nothing to show: Progress details before any report, Turn changes… before a recorded turn, the session views with no session', () => {
    const quiet = readOnlyViewCommands({ workspace: 'BMN', session: 'Lead', progress: false, turnRecorded: false }, viewActs)
    expect(quiet.filter((command) => command.disabled === true).map((command) => command.label)).toEqual(['Progress details', 'Turn changes…'])
    const none = readOnlyViewCommands({ workspace: null, session: null, progress: false, turnRecorded: false }, viewActs)
    expect(none.filter((command) => command.disabled !== true).map((command) => command.label)).toEqual(['dev-auto runs…', 'Plan use…'])
  })

  it('opens what its menu entry opened', () => {
    const opened: string[] = []
    const acts = Object.fromEntries(Object.keys(viewActs).map((key) => [key, () => { opened.push(key) }])) as typeof viewActs
    for (const command of readOnlyViewCommands({ workspace: 'BMN', session: 'Lead', progress: true, turnRecorded: true }, acts)) command.run()
    expect(opened).toEqual(['results', 'messages', 'progress', 'turnChanges', 'hookEvents', 'devAutoRuns', 'planUse'])
  })
})
