// MODULE: launch-template.test.ts - the session form, its agent buttons and the params it sends
import { describe, expect, it } from 'vitest'
import {
  isSessionCreateParams,
  isSessionUpdateParams,
  type SessionRecord
} from '@bmn/protocol'
import {
  INITIAL_SESSION_FORM,
  LAUNCH_AGENTS,
  applyLaunchAgent,
  launchAgentOf,
  quoteArgv,
  sessionCreateParams,
  sessionLaunchForm,
  sessionUpdateParams,
  splitArgv
} from './launch-template'

const typed = {
  ...INITIAL_SESSION_FORM,
  name: 'Codex review',
  executable: '/usr/bin/codex',
  argv: '--model o4',
  cwd: '/workspace/review',
  backgroundChoice: 'hide' as const,
  terminalGraphics: 'sixel' as const
}

describe('the session form', () => {
  it('sends the typed background choice with create and never a template id', () => {
    const params = sessionCreateParams('workspace-1', typed, { cols: 80, rows: 24 })
    expect(params).toEqual({
      workspaceId: 'workspace-1',
      name: 'Codex review',
      cwd: '/workspace/review',
      executable: '/usr/bin/codex',
      argv: ['--model', 'o4'],
      cols: 80,
      rows: 24,
      backgroundChoice: 'hide',
      terminalGraphics: 'sixel'
    })
    expect(isSessionCreateParams(params)).toBe(true)
    expect(isSessionCreateParams({ ...params, templateId: 'template-codex' })).toBe(false)
  })

  it('loads a session into the form and saves its background choice with the edit', () => {
    const session: SessionRecord = {
      sessionId: 'session-1',
      workspaceId: 'workspace-1',
      name: 'Shell',
      cwd: '/workspace',
      executable: '/bin/bash',
      argv: ['-l'],
      position: 0,
      backgroundChoice: 'stop',
      terminalGraphics: null,
      revision: 4,
      createdAt: '2026-09-13T00:00:00.000Z',
      archivedAt: null,
      lastProcess: null
    }
    const form = sessionLaunchForm(session)
    expect(form).toEqual({ name: 'Shell', executable: '/bin/bash', argv: '-l', cwd: '/workspace',
      backgroundChoice: 'stop', terminalGraphics: null })
    const params = sessionUpdateParams(session, { ...form, backgroundChoice: 'hide' })
    expect(params).toMatchObject({ sessionId: 'session-1', expectedRevision: 4, argv: ['-l'], backgroundChoice: 'hide' })
    expect(isSessionUpdateParams(params)).toBe(true)
  })
})

describe('launch agents', () => {
  it('offers OpenCode and preserves its launch when reopening the form', () => {
    const form = applyLaunchAgent({ ...INITIAL_SESSION_FORM, cwd: '/work', terminalGraphics: 'sixel' }, 'opencode')
    expect(form).toMatchObject({ name: 'OpenCode', executable: '/bin/bash', cwd: '/work', terminalGraphics: 'sixel' })
    const params = sessionCreateParams('workspace-1', form, { cols: 80, rows: 24 })
    expect(params.argv).toEqual(['-ic', 'opencode; exec bash -i'])
    expect(launchAgentOf(form)).toBe('opencode')
    expect(applyLaunchAgent({ ...form, name: 'My review' }, 'opencode').name).toBe('My review')
    expect(applyLaunchAgent(form, 'codex').name).toBe('Codex')
  })

  it('offers the four choices with no Cursor, and reads a form saved for Cursor as a custom launch (Epic 71)', () => {
    expect(LAUNCH_AGENTS.map((agent) => agent.label)).toEqual(['Terminal', 'Claude Code', 'Codex', 'OpenCode'])
    const saved = { ...INITIAL_SESSION_FORM, name: 'Cursor', executable: '/bin/bash', argv: quoteArgv(['-ic', 'cursor-agent; exec bash -i']) }
    expect(launchAgentOf(saved)).toBeNull()
  })

  it('runs an agent inside an interactive shell that survives the agent exiting', () => {
    const form = applyLaunchAgent({ ...INITIAL_SESSION_FORM, cwd: '/work' }, 'claude')
    expect(form).toMatchObject({ name: 'Claude', executable: '/bin/bash', cwd: '/work' })
    expect(sessionCreateParams('workspace-1', form, { cols: 80, rows: 24 }).argv)
      .toEqual(['-ic', 'claude; exec bash -i'])
    expect(launchAgentOf(form)).toBe('claude')
  })

  it('launches a plain terminal with no arguments', () => {
    const form = applyLaunchAgent(applyLaunchAgent(INITIAL_SESSION_FORM, 'codex'), 'terminal')
    expect(form).toMatchObject({ name: 'Shell', executable: '/bin/bash', argv: '' })
    expect(launchAgentOf(form)).toBe('terminal')
  })

  it('keeps a typed name and follows the pick for a suggested one', () => {
    expect(applyLaunchAgent({ ...INITIAL_SESSION_FORM, name: 'Review' }, 'codex').name).toBe('Review')
    expect(applyLaunchAgent(applyLaunchAgent(INITIAL_SESSION_FORM, 'claude'), 'opencode').name).toBe('OpenCode')
    expect(applyLaunchAgent({ ...INITIAL_SESSION_FORM, name: '  ' }, 'codex').name).toBe('Codex')
  })

  it('reports no agent once the launch was edited by hand', () => {
    const form = applyLaunchAgent(INITIAL_SESSION_FORM, 'claude')
    expect(launchAgentOf({ ...form, argv: `${form.argv} --extra` })).toBeNull()
    expect(launchAgentOf({ ...form, executable: '/usr/bin/zsh' })).toBeNull()
  })
})

describe('launch agents and a typed command', () => {
  it('ignores an unknown agent and never reports a typed command as an agent', () => {
    expect(applyLaunchAgent(INITIAL_SESSION_FORM, 'nope' as never)).toBe(INITIAL_SESSION_FORM)
    expect(launchAgentOf(typed)).toBeNull()
  })

  it('round-trips a typed argument that contains spaces', () => {
    const argv = ['-c', 'echo "hi there"; exit']
    expect(sessionCreateParams('w', { ...typed, argv: quoteArgv(argv) }, { cols: 80, rows: 24 }).argv).toEqual(argv)
  })
})

describe('argument quoting', () => {
  it('round-trips arguments with spaces, quotes and empty values', () => {
    const argv = ['-ic', "claude; exec bash -i", "it's", '', 'plain-arg', 'a"b', 'back\\slash']
    expect(splitArgv(quoteArgv(argv))).toEqual(argv)
  })

  it('reads typed shell-style arguments', () => {
    expect(splitArgv('  --model o4   -c "a b" \'c d\' e\\ f  ')).toEqual(['--model', 'o4', '-c', 'a b', 'c d', 'e f'])
    expect(splitArgv('')).toEqual([])
    expect(splitArgv('a\tb\nc')).toEqual(['a', 'b', 'c'])
  })

  it('keeps an unterminated quote as one argument and a trailing backslash literally', () => {
    expect(splitArgv("--name 'a b")).toEqual(['--name', 'a b'])
    expect(splitArgv('a\\')).toEqual(['a\\'])
  })

  it('edits a session whose argument contains spaces without splitting it', () => {
    const session = { sessionId: 's', revision: 1, argv: ['-ic', 'codex; exec bash -i'] }
    const form = sessionLaunchForm({ ...session, workspaceId: 'w', name: 'Codex', cwd: '/', executable: '/bin/bash',
      position: 0, backgroundChoice: null, terminalGraphics: null, createdAt: '', archivedAt: null, lastProcess: null })
    expect(sessionUpdateParams(session, form).argv).toEqual(session.argv)
    expect(launchAgentOf(form)).toBe('codex')
  })
})
