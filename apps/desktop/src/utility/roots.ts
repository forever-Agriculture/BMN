import { existsSync } from 'node:fs'
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

const CURRENT_ROOT_DIRECTORY = 'bmn'
const LEGACY_ROOT_DIRECTORY = 'ai-terminal'

function defaultRootFallbacks(): RootFallbacks {
  return {
    homeDirectory: homedir(),
    runtimeFallback: join(tmpdir(), `bmn-${process.getuid?.() ?? 'user'}`)
  }
}

/**
 * Existing installations keep using their legacy root in place. Moving a database and its stored
 * files during application startup is needlessly risky; fresh installs use the BMN root, while an
 * already-created BMN root always wins if both names exist.
 */
function persistentRoot(base: string): string {
  const current = join(base, CURRENT_ROOT_DIRECTORY)
  const legacy = join(base, LEGACY_ROOT_DIRECTORY)
  return !existsSync(current) && existsSync(legacy) ? legacy : current
}

export function resolveApplicationRoots(
  environment: RootEnvironment = process.env,
  fallbacks: RootFallbacks = defaultRootFallbacks()
): ApplicationRoots {
  const configBase = environment.XDG_CONFIG_HOME ?? join(fallbacks.homeDirectory, '.config')
  const dataBase = environment.XDG_DATA_HOME ?? join(fallbacks.homeDirectory, '.local', 'share')
  const stateBase = environment.XDG_STATE_HOME ?? join(fallbacks.homeDirectory, '.local', 'state')
  const runtimeBase = environment.XDG_RUNTIME_DIR ?? fallbacks.runtimeFallback

  return {
    config: environment.BMN_CONFIG_HOME ?? environment.AITERM_CONFIG_HOME ?? persistentRoot(configBase),
    data: environment.BMN_DATA_HOME ?? environment.AITERM_DATA_HOME ?? persistentRoot(dataBase),
    state: environment.BMN_STATE_HOME ?? environment.AITERM_STATE_HOME ?? persistentRoot(stateBase),
    runtime: environment.BMN_RUNTIME_HOME ?? environment.AITERM_RUNTIME_HOME ?? join(runtimeBase, CURRENT_ROOT_DIRECTORY)
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
