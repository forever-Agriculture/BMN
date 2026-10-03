// MODULE: launch-template.test.ts - template application and the params the session form sends
import { describe, expect, it } from 'vitest'
import {
  isSessionCreateParams,
  isSessionUpdateParams,
  type LaunchTemplateRecord,
  type SessionRecord
} from '@bmn/protocol'
import {
  INITIAL_SESSION_FORM,
  applyLaunchAgent,
  applyLaunchTemplate,
  launchAgentOf,
  quoteArgv,
  sessionCreateParams,
  sessionLaunchForm,
  sessionUpdateParams,
  splitArgv
} from './launch-template'

const template: LaunchTemplateRecord = {
  templateId: 'template-codex',
  name: 'Codex review',
  executable: '/usr/bin/codex',
  argv: ['--model', 'o4'],
  cwd: '/workspace/review',
  backgroundChoice: 'hide',
  terminalGraphics: 'sixel',
  revision: 1,
  createdAt: '2026-09-13T00:00:00.000Z'
}

describe('launch template application', () => {
  it('fills name, executable, arguments, directory and background choice from the template', () => {
    const edited = { ...INITIAL_SESSION_FORM, name: 'Typed name', backgroundChoice: 'stop' as const }
    expect(applyLaunchTemplate(edited, template)).toEqual({
      name: 'Codex review',
      executable: '/usr/bin/codex',
      argv: '--model o4',
      cwd: '/workspace/review',
      backgroundChoice: 'hide',
      terminalGraphics: 'sixel'
    })
    expect(applyLaunchTemplate(edited, { ...template, backgroundChoice: null }).backgroundChoice).toBeNull()
    expect(applyLaunchTemplate({ ...edited, terminalGraphics: 'standard' }, template).terminalGraphics)
      .toBe('standard')
    expect(edited.name).toBe('Typed name')
  })

  it('keeps the form unchanged when no template is chosen', () => {
    const edited = { ...INITIAL_SESSION_FORM, cwd: '/tmp' }
    expect(applyLaunchTemplate(edited, undefined)).toBe(edited)
  })

  it('keeps the form unchanged when a stored template is unavailable', () => {
    const edited = { ...INITIAL_SESSION_FORM, name: 'Owner input', cwd: '/tmp' }
    expect(applyLaunchTemplate(edited, {
      ...template,
      argv: [],
      launchDisabledReason: 'Template arguments are unavailable'
    })).toBe(edited)
  })

  it('sends the applied background choice with create and never a template id', () => {
    const params = sessionCreateParams('workspace-1', applyLaunchTemplate(INITIAL_SESSION_FORM, template), { cols: 80, rows: 24 })
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
    expect(isSessionCreateParams({ ...params, templateId: template.templateId })).toBe(false)
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
  it('offers Cursor and preserves its launch when reopening the form', () => {
    const form = applyLaunchAgent({ ...INITIAL_SESSION_FORM, cwd: '/work', terminalGraphics: 'sixel' }, 'cursor')
    expect(form).toMatchObject({ name: 'Cursor', executable: '/bin/bash', cwd: '/work', terminalGraphics: 'sixel' })
    const params = sessionCreateParams('workspace-1', form, { cols: 80, rows: 24 })
    expect(params.argv).toEqual(['-ic', 'cursor-agent; exec bash -i'])
    expect(launchAgentOf(form)).toBe('cursor')
    expect(applyLaunchAgent({ ...form, name: 'My review' }, 'cursor').name).toBe('My review')
    expect(applyLaunchAgent(form, 'codex').name).toBe('Codex')
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

describe('launch agents after a template', () => {
  it('replaces a template-suggested name but keeps one the owner typed', () => {
    const fromTemplate = applyLaunchTemplate(INITIAL_SESSION_FORM, template)
    expect(applyLaunchAgent(fromTemplate, 'claude', [template.name]).name).toBe('Claude')
    expect(applyLaunchAgent({ ...fromTemplate, name: 'Mine' }, 'claude', [template.name]).name).toBe('Mine')
  })

  it('ignores an unknown agent and never reports a template launch as an agent', () => {
    expect(applyLaunchAgent(INITIAL_SESSION_FORM, 'nope' as never)).toBe(INITIAL_SESSION_FORM)
    expect(launchAgentOf(applyLaunchTemplate(INITIAL_SESSION_FORM, template))).toBeNull()
  })

  it('round-trips a template argument that contains spaces', () => {
    const spaced = { ...template, argv: ['-c', 'echo "hi there"; exit'] }
    const form = applyLaunchTemplate(INITIAL_SESSION_FORM, spaced)
    expect(sessionCreateParams('w', form, { cols: 80, rows: 24 }).argv).toEqual(spaced.argv)
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

describe('Windows argument field', () => {
  it('keeps unquoted path backslashes and literal shell metacharacters', () => {
    expect(splitArgv(String.raw`C:\work\file.txt %PATH% ^& !name!`, 'win32'))
      .toEqual([String.raw`C:\work\file.txt`, '%PATH%', '^&', '!name!'])
  })

  it('round-trips quoted spaces, literal quotes, empty values and trailing slashes', () => {
    const argv = ['C:\\with space\\', '"a b"', '', '雪', String.raw`a\"b`, '%PATH%', '^&']
    expect(splitArgv(quoteArgv(argv, 'win32'), 'win32')).toEqual(argv)
    expect(quoteArgv(['space value'], 'win32')).toBe('"space value"')
  })
})

describe('Windows launch choices', () => {
  it('keeps a native command prompt after an agent exits', () => {
    const form = applyLaunchAgent(INITIAL_SESSION_FORM, 'codex', [], 'win32')
    expect(form.executable).toBe('cmd.exe')
    expect(splitArgv(form.argv, 'win32')).toEqual(['/d', '/v:off', '/s', '/k', 'codex'])
    expect(launchAgentOf(form, 'win32')).toBe('codex')
    expect(applyLaunchAgent(form, 'terminal', [], 'win32').executable).toBe('powershell.exe')
  })

  it('persists explicit batch text as a command processor launch and reopens that mode', () => {
    const batchCommand = '"C:\\my scripts\\build.cmd" %NAME% & echo finished'
    const params = sessionCreateParams('w', { ...INITIAL_SESSION_FORM, batchCommand }, { cols: 80, rows: 24 })
    expect(params.executable).toBe('cmd.exe')
    expect(params.argv).toEqual(['/d', '/v:off', '/s', '/c', batchCommand])
    const session = { ...params, backgroundChoice: null, terminalGraphics: null, sessionId: 's', revision: 1, position: 0, createdAt: '', archivedAt: null, lastProcess: null }
    const reopened = sessionLaunchForm(session, 'win32')
    expect(reopened.batchCommand).toBe(batchCommand)
    expect(sessionUpdateParams(session, reopened).argv).toEqual(params.argv)
    expect(launchAgentOf(reopened, 'win32')).toBeNull()
    expect(applyLaunchAgent(reopened, 'codex', [], 'win32').batchCommand).toBeUndefined()
  })
})
