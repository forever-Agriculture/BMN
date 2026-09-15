// MODULE: launch-template.ts - the session launch form, template application and its create/update params
import type {
  BackgroundChoice,
  LaunchTemplateRecord,
  SessionCreateParams,
  SessionRecord,
  SessionUpdateParams
} from '@ai-terminal/protocol'

export interface SessionLaunchForm {
  name: string
  executable: string
  argv: string
  cwd: string
  backgroundChoice: BackgroundChoice | null
}

export const INITIAL_SESSION_FORM: SessionLaunchForm = Object.freeze({
  name: 'Shell',
  executable: '/bin/bash',
  argv: '',
  cwd: '/',
  backgroundChoice: null
})

export const BACKGROUND_CHOICE_OPTIONS: ReadonlyArray<{ value: '' | BackgroundChoice; label: string }> = [
  { value: '', label: 'Ask when windows close' },
  { value: 'hide', label: 'Keep running when windows close' },
  { value: 'stop', label: 'Stop when windows close' }
]

/** Choosing an available template fills its fields; unavailable or missing templates are inert. */
export function applyLaunchTemplate(
  form: SessionLaunchForm,
  template: LaunchTemplateRecord | undefined
): SessionLaunchForm {
  if (!template || template.launchDisabledReason) return form
  return {
    name: template.name,
    executable: template.executable,
    argv: template.argv.join(' '),
    cwd: template.cwd,
    backgroundChoice: template.backgroundChoice
  }
}

export function sessionLaunchForm(session: SessionRecord): SessionLaunchForm {
  return {
    name: session.name,
    executable: session.executable,
    argv: session.argv.join(' '),
    cwd: session.cwd,
    backgroundChoice: session.backgroundChoice
  }
}

function formArgv(form: SessionLaunchForm): string[] {
  const argv = form.argv.trim()
  return argv ? argv.split(/\s+/) : []
}

export function sessionCreateParams(
  workspaceId: string,
  form: SessionLaunchForm,
  size: { cols: number; rows: number }
): SessionCreateParams {
  return {
    workspaceId,
    name: form.name,
    cwd: form.cwd,
    executable: form.executable,
    argv: formArgv(form),
    cols: size.cols,
    rows: size.rows,
    backgroundChoice: form.backgroundChoice
  }
}

export function sessionUpdateParams(
  session: Pick<SessionRecord, 'sessionId' | 'revision'>,
  form: SessionLaunchForm
): SessionUpdateParams {
  return {
    sessionId: session.sessionId,
    expectedRevision: session.revision,
    name: form.name,
    cwd: form.cwd,
    executable: form.executable,
    argv: formArgv(form),
    backgroundChoice: form.backgroundChoice
  }
}
