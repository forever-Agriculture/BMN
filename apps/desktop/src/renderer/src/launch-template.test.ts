// MODULE: launch-template.test.ts - template application and the params the session form sends
import { describe, expect, it } from 'vitest'
import {
  isSessionCreateParams,
  isSessionUpdateParams,
  type LaunchTemplateRecord,
  type SessionRecord
} from '@ai-terminal/protocol'
import {
  INITIAL_SESSION_FORM,
  applyLaunchTemplate,
  sessionCreateParams,
  sessionLaunchForm,
  sessionUpdateParams
} from './launch-template'

const template: LaunchTemplateRecord = {
  templateId: 'template-codex',
  name: 'Codex review',
  executable: '/usr/bin/codex',
  argv: ['--model', 'o4'],
  cwd: '/workspace/review',
  backgroundChoice: 'hide',
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
      backgroundChoice: 'hide'
    })
    expect(applyLaunchTemplate(edited, { ...template, backgroundChoice: null }).backgroundChoice).toBeNull()
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
      backgroundChoice: 'hide'
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
      revision: 4,
      createdAt: '2026-09-13T00:00:00.000Z',
      lastProcess: null
    }
    const form = sessionLaunchForm(session)
    expect(form).toEqual({ name: 'Shell', executable: '/bin/bash', argv: '-l', cwd: '/workspace', backgroundChoice: 'stop' })
    const params = sessionUpdateParams(session, { ...form, backgroundChoice: 'hide' })
    expect(params).toMatchObject({ sessionId: 'session-1', expectedRevision: 4, argv: ['-l'], backgroundChoice: 'hide' })
    expect(isSessionUpdateParams(params)).toBe(true)
  })
})
