// MODULE: bench-candidate.mjs - digest the code actually loaded by an isolated bench
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** Hash the candidate's loaded code, including packaged code rather than just Electron. */
export function benchCandidate(binary, repo, packaged) {
  const runtime = realpathSync(binary), root = packaged ? dirname(runtime) : join(repo, 'apps/desktop/out')
  const files = []
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path)
      if (stat.isSymbolicLink()) throw new Error('QA candidate must not load unpinned symlink targets')
      if (stat.isDirectory()) visit(path)
      else if (stat.isFile()) files.push([relative(root, path), sha256(readFileSync(path))])
      else throw new Error('QA candidate contains a non-regular entry')
    }
  }
  visit(root)
  if (!packaged) files.unshift(['runtime', sha256(readFileSync(runtime))])
  return sha256(JSON.stringify(files))
}

