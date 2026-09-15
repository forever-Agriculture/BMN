import { accessSync, constants } from 'node:fs'
import { basename, delimiter, isAbsolute, resolve } from 'node:path'
import { DEFAULT_WORKSPACE_ID, METHOD_REGISTRY, type ProtocolMethod } from '@ai-terminal/protocol'

export interface ApplicationLaunchSpec {
  cwd: string
  executable: string
  argv: string[]
}

export function hasExplicitApplicationLaunch(applicationArgv: readonly string[]): boolean {
  return applicationArgv.includes('--')
}

interface SessionCreateClient {
  request<Result>(method: ProtocolMethod, params: object): Promise<Result>
}

function executablePath(command: string, cwd: string, environment: NodeJS.ProcessEnv): string {
  if (command.includes('/')) return isAbsolute(command) ? command : resolve(cwd, command)
  for (const directory of (environment.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const candidate = resolve(directory, command)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Continue to the next PATH entry; the host produces the actionable final refusal.
    }
  }
  return command
}

export function parseApplicationLaunchSpec(
  applicationArgv: readonly string[],
  environment: NodeJS.ProcessEnv,
  defaultCwd: string
): ApplicationLaunchSpec {
  const cwd = environment.AITERM_LAUNCH_CWD ?? defaultCwd
  const separator = applicationArgv.indexOf('--')
  if (separator >= 0) {
    const explicit = applicationArgv.slice(separator + 1)
    if (!explicit[0]) {
      throw new Error('Explicit launch separator must be followed by an executable')
    }
    return {
      cwd,
      executable: executablePath(explicit[0], cwd, environment),
      argv: explicit.slice(1)
    }
  }
  const shell = environment.AITERM_SHELL ?? environment.SHELL ?? '/bin/bash'
  return { cwd, executable: executablePath(shell, cwd, environment), argv: [] }
}

export function createApplicationSession<Result>(
  client: SessionCreateClient,
  launch: ApplicationLaunchSpec,
  dimensions: { cols: number; rows: number }
): Promise<Result> {
  return client.request<Result>(METHOD_REGISTRY.sessionCreate, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    name: basename(launch.executable) || 'Shell',
    ...launch,
    ...dimensions
  })
}
