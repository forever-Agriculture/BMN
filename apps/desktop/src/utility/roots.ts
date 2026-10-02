// MODULE: roots.ts - XDG config, data, state and runtime roots; an existing legacy installation keeps its ai-terminal roots in place
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { ensurePrivateDirectories } from './private-directory'

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
const DATABASE_FILE = 'state.sqlite3'

function defaultRootFallbacks(): RootFallbacks {
  return {
    homeDirectory: homedir(),
    runtimeFallback: join(tmpdir(), `bmn-${process.getuid?.() ?? 'user'}`)
  }
}

/**
 * Existing installations keep using their legacy roots in place. Moving a database and its stored
 * files during application startup is needlessly risky, and the database records absolute artifact
 * paths. The data root's database decides for every persistent root: desktop install and update
 * tooling creates BMN-named directories that hold no application data. A BMN database always wins.
 */
function persistentRootDirectory(dataBase: string): string {
  const legacyInstallation =
    !existsSync(join(dataBase, CURRENT_ROOT_DIRECTORY, DATABASE_FILE)) &&
    existsSync(join(dataBase, LEGACY_ROOT_DIRECTORY, DATABASE_FILE))
  return legacyInstallation ? LEGACY_ROOT_DIRECTORY : CURRENT_ROOT_DIRECTORY
}

export function resolveApplicationRoots(
  environment: RootEnvironment = process.env,
  fallbacks: RootFallbacks = defaultRootFallbacks(),
  platform: NodeJS.Platform = process.platform
): ApplicationRoots {
  if (platform === 'win32') {
    const local = environment.LOCALAPPDATA || win32.join(fallbacks.homeDirectory, 'AppData', 'Local')
    const base = win32.join(local, 'BMN')
    return {
      config: environment.BMN_CONFIG_HOME ?? environment.AITERM_CONFIG_HOME ?? win32.join(base, 'config'),
      data: environment.BMN_DATA_HOME ?? environment.AITERM_DATA_HOME ?? win32.join(base, 'data'),
      state: environment.BMN_STATE_HOME ?? environment.AITERM_STATE_HOME ?? win32.join(base, 'state'),
      runtime: environment.BMN_RUNTIME_HOME ?? environment.AITERM_RUNTIME_HOME ?? win32.join(base, 'runtime')
    }
  }
  const configBase = environment.XDG_CONFIG_HOME ?? join(fallbacks.homeDirectory, '.config')
  const dataBase = environment.XDG_DATA_HOME ?? join(fallbacks.homeDirectory, '.local', 'share')
  const stateBase = environment.XDG_STATE_HOME ?? join(fallbacks.homeDirectory, '.local', 'state')
  const runtimeBase = environment.XDG_RUNTIME_DIR ?? fallbacks.runtimeFallback
  const persistent = persistentRootDirectory(dataBase)

  return {
    config: environment.BMN_CONFIG_HOME ?? environment.AITERM_CONFIG_HOME ?? join(configBase, persistent),
    data: environment.BMN_DATA_HOME ?? environment.AITERM_DATA_HOME ?? join(dataBase, persistent),
    state: environment.BMN_STATE_HOME ?? environment.AITERM_STATE_HOME ?? join(stateBase, persistent),
    runtime: environment.BMN_RUNTIME_HOME ?? environment.AITERM_RUNTIME_HOME ?? join(runtimeBase, CURRENT_ROOT_DIRECTORY)
  }
}

export async function ensureApplicationRoots(roots: ApplicationRoots): Promise<void> {
  ensurePrivateDirectories(Object.values(roots))
}
