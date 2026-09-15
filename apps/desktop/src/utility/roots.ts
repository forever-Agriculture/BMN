import { chmod, mkdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

export interface ApplicationRoots {
  config: string
  data: string
  state: string
  runtime: string
}

type RootEnvironment = Readonly<Record<string, string | undefined>>

interface RootFallbacks {
  homeDirectory: string
  runtimeFallback: string
}

export function resolveApplicationRoots(
  environment: RootEnvironment = process.env,
  fallbacks: RootFallbacks = {
    homeDirectory: homedir(),
    runtimeFallback: join(tmpdir(), `ai-terminal-${process.getuid?.() ?? 'user'}`)
  }
): ApplicationRoots {
  const configBase = environment.XDG_CONFIG_HOME ?? join(fallbacks.homeDirectory, '.config')
  const dataBase = environment.XDG_DATA_HOME ?? join(fallbacks.homeDirectory, '.local', 'share')
  const stateBase = environment.XDG_STATE_HOME ?? join(fallbacks.homeDirectory, '.local', 'state')
  const runtimeBase = environment.XDG_RUNTIME_DIR ?? fallbacks.runtimeFallback

  return {
    config: environment.AITERM_CONFIG_HOME ?? join(configBase, 'ai-terminal'),
    data: environment.AITERM_DATA_HOME ?? join(dataBase, 'ai-terminal'),
    state: environment.AITERM_STATE_HOME ?? join(stateBase, 'ai-terminal'),
    runtime: environment.AITERM_RUNTIME_HOME ?? join(runtimeBase, 'ai-terminal')
  }
}

export async function ensureApplicationRoots(roots: ApplicationRoots): Promise<void> {
  await Promise.all(
    Object.values(roots).map(async (root) => {
      await mkdir(root, { recursive: true, mode: 0o700 })
      await chmod(root, 0o700)
    })
  )
}
