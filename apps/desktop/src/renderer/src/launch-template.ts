// MODULE: launch-template.ts - the session launch form, template application and its create/update params
import { quoteWindowsArgv, splitWindowsArgv } from '@bmn/protocol'
import type {
  BackgroundChoice,
  LaunchTemplateRecord,
  SessionCreateParams,
  SessionRecord,
  SessionUpdateParams,
  TerminalGraphicsChoice
} from '@bmn/protocol'

export type LaunchPlatform = 'linux' | 'win32'
export const LAUNCH_PLATFORM: LaunchPlatform = typeof window !== 'undefined' && window.aiTerminal?.platform === 'win32' ? 'win32' : 'linux'

export interface SessionLaunchForm {
  name: string
  executable: string
  argv: string
  cwd: string
  backgroundChoice: BackgroundChoice | null
  terminalGraphics: TerminalGraphicsChoice
  batchCommand?: string | undefined
}

export const INITIAL_SESSION_FORM: SessionLaunchForm = Object.freeze({
  name: 'Shell',
  executable: LAUNCH_PLATFORM === 'win32' ? 'powershell.exe' : '/bin/bash',
  argv: '',
  cwd: LAUNCH_PLATFORM === 'win32' ? '~' : '/',
  backgroundChoice: null,
  terminalGraphics: null
})

export type LaunchAgentId = 'terminal' | 'claude' | 'codex' | 'opencode' | 'cursor'

export interface LaunchAgent {
  id: LaunchAgentId
  label: string
  /** Session name the choice suggests. */
  name: string
  /** The CLI typed into the shell; null for a plain terminal. */
  command: string | null
}

/** The shell every choice runs in, so the session survives the agent exiting. */
export const LAUNCH_SHELL = LAUNCH_PLATFORM === 'win32' ? 'powershell.exe' : '/bin/bash'

export const LAUNCH_AGENTS: ReadonlyArray<LaunchAgent> = [
  { id: 'terminal', label: 'Terminal', name: 'Shell', command: null },
  { id: 'claude', label: 'Claude Code', name: 'Claude', command: 'claude' },
  { id: 'codex', label: 'Codex', name: 'Codex', command: 'codex' },
  { id: 'opencode', label: 'OpenCode', name: 'OpenCode', command: 'opencode' },
  { id: 'cursor', label: 'Cursor', name: 'Cursor', command: 'cursor-agent' }
]

function agentArgv(agent: LaunchAgent, platform: LaunchPlatform): string[] {
  if (!agent.command) return []
  return platform === 'win32'
    ? ['/d', '/v:off', '/s', '/k', agent.command]
    : ['-ic', `${agent.command}; exec bash -i`]
}

function agentShell(agent: LaunchAgent, platform: LaunchPlatform): string {
  return platform === 'win32' ? agent.command ? 'cmd.exe' : 'powershell.exe' : '/bin/bash'
}

function windowsBasename(executable: string): string {
  return executable.replaceAll('\\', '/').split('/').pop()!.toLowerCase()
}

function launchFields(executable: string, argv: readonly string[], platform: LaunchPlatform) {
  const batch = platform === 'win32' && windowsBasename(executable) === 'cmd.exe' &&
    argv.length === 5 && argv.slice(0, 4).join(' ').toLowerCase() === '/d /v:off /s /c'
  return { executable, argv: quoteArgv(argv, platform), ...(batch ? { batchCommand: argv[4]! } : {}) }
}

function commandFields(form: SessionLaunchForm) {
  if (form.batchCommand !== undefined) {
    if (!form.batchCommand.trim()) throw new Error('Enter a batch command')
    return { executable: 'cmd.exe', argv: ['/d', '/v:off', '/s', '/c', form.batchCommand] }
  }
  return { executable: form.executable, argv: formArgv(form) }
}

/**
 * Picking an agent fills the launch; a name the owner typed survives, a suggested one (an agent's,
 * or `suggestedNames` such as the picked template's) follows the pick.
 */
export function applyLaunchAgent(
  form: SessionLaunchForm,
  agentId: LaunchAgentId,
  suggestedNames: readonly string[] = [],
  platform: LaunchPlatform = LAUNCH_PLATFORM
): SessionLaunchForm {
  const agent = LAUNCH_AGENTS.find((item) => item.id === agentId)
  if (!agent) return form
  const typedName = form.name.trim() !== '' && !suggestedNames.includes(form.name) &&
    !LAUNCH_AGENTS.some((item) => item.name === form.name)
  return {
    ...form,
    name: typedName ? form.name : agent.name,
    executable: agentShell(agent, platform),
    argv: quoteArgv(agentArgv(agent, platform), platform),
    ...(form.batchCommand === undefined ? {} : { batchCommand: undefined })
  }
}

/** The agent whose launch the form still matches, or null once Advanced fields were changed. */
export function launchAgentOf(form: SessionLaunchForm, platform: LaunchPlatform = LAUNCH_PLATFORM): LaunchAgentId | null {
  if (form.batchCommand !== undefined) return null
  let argv: string[]
  try { argv = splitArgv(form.argv, platform) } catch { return null }
  return LAUNCH_AGENTS.find((agent) => {
    const shell = agentShell(agent, platform)
    if (platform === 'win32' ? windowsBasename(form.executable) !== shell : form.executable !== shell) return false
    const expected = agentArgv(agent, platform)
    return expected.length === argv.length && expected.every((value, index) => argv[index] === value)
  })?.id ?? null
}

const PLAIN_ARGUMENT = /^[A-Za-z0-9_\-./:=@%+,]+$/

/** Joins argv so `splitArgv` reads it back unchanged; arguments with spaces or quotes are single-quoted. */
export function quoteArgv(argv: ReadonlyArray<string>, platform: LaunchPlatform = LAUNCH_PLATFORM): string {
  if (platform === 'win32') return quoteWindowsArgv(argv)
  return argv.map((value) => PLAIN_ARGUMENT.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`).join(' ')
}

/** Shell-style split: whitespace separates, single quotes are literal, double quotes and backslashes escape. */
export function splitArgv(text: string, platform: LaunchPlatform = LAUNCH_PLATFORM): string[] {
  if (platform === 'win32') return splitWindowsArgv(text)
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
  template: LaunchTemplateRecord | undefined,
  platform: LaunchPlatform = LAUNCH_PLATFORM
): SessionLaunchForm {
  if (!template || template.launchDisabledReason) return form
  return {
    name: template.name,
    ...launchFields(template.executable, template.argv, platform),
    cwd: template.cwd,
    backgroundChoice: template.backgroundChoice,
    terminalGraphics: form.terminalGraphics ?? template.terminalGraphics
  }
}

export function sessionLaunchForm(session: SessionRecord, platform: LaunchPlatform = LAUNCH_PLATFORM): SessionLaunchForm {
  return {
    name: session.name,
    ...launchFields(session.executable, session.argv, platform),
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
    ...commandFields(form),
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
    ...commandFields(form),
    backgroundChoice: form.backgroundChoice,
    terminalGraphics: form.terminalGraphics
  }
}
