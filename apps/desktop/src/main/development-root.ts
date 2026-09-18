import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const rootKeys = [
  'BMN_CONFIG_HOME',
  'BMN_DATA_HOME',
  'BMN_STATE_HOME',
  'BMN_RUNTIME_HOME'
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

  const root = mkdtempSync(join(baseDirectory, 'bmn-development-'))
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
