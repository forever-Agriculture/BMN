import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rootKeys = [
  'AITERM_CONFIG_HOME',
  'AITERM_DATA_HOME',
  'AITERM_STATE_HOME',
  'AITERM_RUNTIME_HOME'
] as const

interface DevelopmentRoot {
  root: string
  cleanup(): void
}

export function createDevelopmentRoot(
  environment: NodeJS.ProcessEnv,
  baseDirectory = tmpdir()
): DevelopmentRoot | undefined {
  if (rootKeys.every((key) => !!environment[key])) return undefined

  const root = mkdtempSync(join(baseDirectory, 'aiterm-development-'))
  let cleaned = false
  for (const key of rootKeys) {
    if (!environment[key]) environment[key] = join(root, key.toLowerCase())
  }
  return {
    root,
    cleanup() {
      if (cleaned) return
      cleaned = true
      rmSync(root, { recursive: true, force: true })
    }
  }
}
