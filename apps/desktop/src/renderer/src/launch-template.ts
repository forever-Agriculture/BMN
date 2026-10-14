// MODULE: launch-template.ts - the session launch form, template application and its create/update params
import type {
  BackgroundChoice,
  LaunchTemplateRecord,
  SessionCreateParams,
  SessionRecord,
  SessionUpdateParams,
  TerminalGraphicsChoice
} from '@bmn/protocol'

export interface SessionLaunchForm {
  name: string
  executable: string
  argv: string
  cwd: string
  backgroundChoice: BackgroundChoice | null
  terminalGraphics: TerminalGraphicsChoice
}

export const INITIAL_SESSION_FORM: SessionLaunchForm = Object.freeze({
  name: 'Shell',
  executable: '/bin/bash',
  argv: '',
  cwd: '/',
  backgroundChoice: null,
  terminalGraphics: null
})

export type LaunchAgentId = 'terminal' | 'claude' | 'codex' | 'opencode'

export interface LaunchAgent {
  id: LaunchAgentId
  label: string
  /** Session name the choice suggests. */
  name: string
  /** The CLI typed into the shell; null for a plain terminal. */
  command: string | null
}

/** The shell every choice runs in, so the session survives the agent exiting. */
export const LAUNCH_SHELL = '/bin/bash'

export const LAUNCH_AGENTS: ReadonlyArray<LaunchAgent> = [
  { id: 'terminal', label: 'Terminal', name: 'Shell', command: null },
  { id: 'claude', label: 'Claude Code', name: 'Claude', command: 'claude' },
  { id: 'codex', label: 'Codex', name: 'Codex', command: 'codex' },
  { id: 'opencode', label: 'OpenCode', name: 'OpenCode', command: 'opencode' }
]

function agentArgv(agent: LaunchAgent): string[] {
  return agent.command ? ['-ic', `${agent.command}; exec bash -i`] : []
}

/**
 * Picking an agent fills the launch; a name the owner typed survives, a suggested one (an agent's,
 * or `suggestedNames` such as the picked template's) follows the pick.
 */
export function applyLaunchAgent(
  form: SessionLaunchForm,
  agentId: LaunchAgentId,
  suggestedNames: readonly string[] = []
): SessionLaunchForm {
  const agent = LAUNCH_AGENTS.find((item) => item.id === agentId)
  if (!agent) return form
  const typedName = form.name.trim() !== '' && !suggestedNames.includes(form.name) &&
    !LAUNCH_AGENTS.some((item) => item.name === form.name)
  return {
    ...form,
    name: typedName ? form.name : agent.name,
    executable: LAUNCH_SHELL,
    argv: quoteArgv(agentArgv(agent))
  }
}

/** The agent whose launch the form still matches, or null once Advanced fields were changed. */
export function launchAgentOf(form: SessionLaunchForm): LaunchAgentId | null {
  if (form.executable !== LAUNCH_SHELL) return null
  const argv = formArgv(form)
  return LAUNCH_AGENTS.find((agent) => {
    const expected = agentArgv(agent)
    return expected.length === argv.length && expected.every((value, index) => argv[index] === value)
  })?.id ?? null
}

const PLAIN_ARGUMENT = /^[A-Za-z0-9_\-./:=@%+,]+$/

/** Joins argv so `splitArgv` reads it back unchanged; arguments with spaces or quotes are single-quoted. */
export function quoteArgv(argv: ReadonlyArray<string>): string {
  return argv.map((value) => PLAIN_ARGUMENT.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`).join(' ')
}

/** Shell-style split: whitespace separates, single quotes are literal, double quotes and backslashes escape. */
export function splitArgv(text: string): string[] {
  const argv: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | null = null
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!
    if (quote === "'") {
      if (char === "'") quote = null
      else current += char
    } else if (quote === '"') {
      if (char === '"') quote = null
      else if (char === '\\' && (text[index + 1] === '"' || text[index + 1] === '\\')) current += text[++index]
      else current += char
    } else if (char === "'" || char === '"') {
      quote = char
      started = true
    } else if (char === '\\' && index + 1 < text.length) {
      current += text[++index]
      started = true
    } else if (/\s/.test(char)) {
      if (started) argv.push(current)
      current = ''
      started = false
    } else {
      current += char
      started = true
    }
  }
  if (started) argv.push(current)
  return argv
}

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
    argv: quoteArgv(template.argv),
    cwd: template.cwd,
    backgroundChoice: template.backgroundChoice,
    terminalGraphics: form.terminalGraphics ?? template.terminalGraphics
  }
}

export function sessionLaunchForm(session: SessionRecord): SessionLaunchForm {
  return {
    name: session.name,
    executable: session.executable,
    argv: quoteArgv(session.argv),
    cwd: session.cwd,
    backgroundChoice: session.backgroundChoice,
    terminalGraphics: session.terminalGraphics
  }
}

function formArgv(form: SessionLaunchForm): string[] {
  return splitArgv(form.argv)
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
    backgroundChoice: form.backgroundChoice,
    terminalGraphics: form.terminalGraphics
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
    backgroundChoice: form.backgroundChoice,
    terminalGraphics: form.terminalGraphics
  }
}
