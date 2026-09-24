import {
  isLaunchSetCreateParams,
  type BackgroundChoice,
  type LaunchSetCreateParams,
  type LaunchSetEntry,
  type LaunchTemplateRecord,
  type SessionRecord
} from '@bmn/protocol'

export interface LaunchSetEntryForm {
  entryId: string
  name: string
  executable: string
  argvJson: string
  backgroundChoice: BackgroundChoice | null
}

export function entryForm(entry: LaunchSetEntry): LaunchSetEntryForm {
  return { ...entry, argvJson: JSON.stringify(entry.argv) }
}

export function seededEntry(template: LaunchTemplateRecord, entryId: string): LaunchSetEntryForm {
  return {
    entryId, name: template.name, executable: template.executable,
    argvJson: JSON.stringify(template.argv), backgroundChoice: template.backgroundChoice
  }
}

export function launchSetParams(
  workspaceId: string,
  name: string,
  forms: readonly LaunchSetEntryForm[]
): LaunchSetCreateParams {
  const entries = forms.map((form, index): LaunchSetEntry => {
    let argv: unknown
    try { argv = JSON.parse(form.argvJson) } catch {
      throw new Error(`Entry ${index + 1} arguments must be a JSON array of strings`)
    }
    if (!Array.isArray(argv) || !argv.every((part) => typeof part === 'string')) {
      throw new Error(`Entry ${index + 1} arguments must be a JSON array of strings`)
    }
    return {
      entryId: form.entryId, name: form.name, executable: form.executable,
      argv, backgroundChoice: form.backgroundChoice
    }
  })
  const params = { workspaceId, name, entries }
  if (!isLaunchSetCreateParams(params)) {
    throw new Error('Set name and 1–8 complete command entries are required; check field lengths and duplicate IDs')
  }
  return params
}

/** JSON array is exact argv data, without suggesting shell quoting or expansion. */
export function exactCommand(executable: string, argv: readonly string[]): string {
  return JSON.stringify([executable, ...argv])
}

export function matchingLiveCommands(
  directory: string,
  entries: readonly LaunchSetEntry[],
  sessions: readonly SessionRecord[],
  liveSessionIds: ReadonlySet<string>,
  normalizeDirectory: (path: string) => string = (path) => path
): string[] {
  const normalizedDirectory = normalizeDirectory(directory)
  return entries.flatMap((entry) => sessions.some((session) =>
    liveSessionIds.has(session.sessionId) && normalizeDirectory(session.cwd) === normalizedDirectory &&
    session.executable === entry.executable &&
    JSON.stringify(session.argv) === JSON.stringify(entry.argv)
  ) ? [entry.name] : [])
}
