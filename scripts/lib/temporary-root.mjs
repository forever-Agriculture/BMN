import { mkdirSync, mkdtempSync, readlinkSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'

/**
 * The owner's `claude` command. Claude Code started in a run whose XDG_DATA_HOME is the temporary root, with his real
 * profile, installs itself there and points this link into the root, which the cleanup then deletes: his `claude` stops
 * working (Epic 111 F20, 2026-11-07). A run that moved it into its root fails loudly and says how to put it back.
 */
export const OWNER_CLAUDE_LINK = join(homedir(), '.local/bin/claude')
const readLink = (path) => { try { return readlinkSync(path) } catch { return null } }

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

export function createTemporaryRoot(contract, baseDirectory = tmpdir(), claudeLink = OWNER_CLAUDE_LINK) {
  const root = mkdtempSync(join(baseDirectory, contract.prefix))
  const linkBefore = readLink(claudeLink)
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
        const linkAfter = readLink(claudeLink)
        removeTemporaryRoot(root)
        if (linkAfter !== linkBefore && linkAfter !== null && (linkAfter === root || linkAfter.startsWith(`${root}${sep}`))) {
          throw new Error(`this run pointed ${claudeLink} into its temporary root (${linkAfter}), now removed, so the owner's \`claude\` ` +
            `no longer starts; put it back with: ln -sfn '${linkBefore ?? '<his installed version>'}' '${claudeLink}'`)
        }
      }
    }
  } catch (error) {
    removeTemporaryRoot(root)
    throw error
  }
}

export function startWithTemporaryRoot(contract, start, baseDirectory = tmpdir(), claudeLink = OWNER_CLAUDE_LINK) {
  const temporaryRoot = createTemporaryRoot(contract, baseDirectory, claudeLink)
  try {
    return { temporaryRoot, value: start(temporaryRoot) }
  } catch (error) {
    temporaryRoot.cleanup()
    throw error
  }
}

export async function withTemporaryRoot(contract, operation, baseDirectory = tmpdir(), claudeLink = OWNER_CLAUDE_LINK) {
  const temporaryRoot = createTemporaryRoot(contract, baseDirectory, claudeLink)
  try {
    return await operation(temporaryRoot)
  } finally {
    temporaryRoot.cleanup()
  }
}
