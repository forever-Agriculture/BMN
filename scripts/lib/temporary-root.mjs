import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const removeTemporaryRoot = (root) => rmSync(root, {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 50
})

export const temporaryRootContracts = Object.freeze({
  electronSelfTest: Object.freeze({
    prefix: 'bmn-electron-self-test-',
    directories: Object.freeze(['config', 'data', 'state', 'runtime', 'cache'])
  }),
  electronDevelopment: Object.freeze({
    prefix: 'bmn-development-',
    directories: Object.freeze(['config', 'data', 'state', 'runtime', 'cache'])
  }),
  liveShell: Object.freeze({
    prefix: 'bmn-e2e-',
    directories: Object.freeze(['config', 'data', 'state', 'runtime', 'cache'])
  }),
  packagedSmoke: Object.freeze({
    prefix: 'bmn-packaged-smoke-',
    directories: Object.freeze(['config', 'data', 'state', 'runtime', 'cache'])
  })
})

export function createTemporaryRoot(contract, baseDirectory = tmpdir()) {
  const root = mkdtempSync(join(baseDirectory, contract.prefix))
  let cleaned = false
  try {
    const roots = Object.fromEntries(
      contract.directories.map((name) => {
        const path = join(root, name)
        mkdirSync(path, { mode: 0o700 })
        return [name, path]
      })
    )
    return {
      root,
      roots,
      cleanup() {
        if (cleaned) return
        cleaned = true
        removeTemporaryRoot(root)
      }
    }
  } catch (error) {
    removeTemporaryRoot(root)
    throw error
  }
}

export function startWithTemporaryRoot(contract, start, baseDirectory = tmpdir()) {
  const temporaryRoot = createTemporaryRoot(contract, baseDirectory)
  try {
    return { temporaryRoot, value: start(temporaryRoot) }
  } catch (error) {
    temporaryRoot.cleanup()
    throw error
  }
}

export async function withTemporaryRoot(contract, operation, baseDirectory = tmpdir()) {
  const temporaryRoot = createTemporaryRoot(contract, baseDirectory)
  try {
    return await operation(temporaryRoot)
  } finally {
    temporaryRoot.cleanup()
  }
}
