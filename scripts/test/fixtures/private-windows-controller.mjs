// Trusted, locally generated fixture source only. No script text enters argv;
// the caller retains its original process/job, command guard and stdin channel.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import { ensurePrivateDirectories } from '../../../apps/desktop/src/utility/private-directory.ts'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const equalPath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

export function verifyPrivateWindowsController(controller, { protect = ensurePrivateDirectories } = {}) {
  const directory = lstatSync(controller.root), file = lstatSync(controller.file)
  assert.ok(directory.isDirectory() && !directory.isSymbolicLink(), 'Controller root is not an ordinary directory')
  assert.ok(file.isFile() && !file.isSymbolicLink() && file.nlink === 1, 'Controller is not a regular single-link file')
  protect([controller.root]) // Existing security/link violations are refused.
  assert.ok(equalPath(realpathSync.native(controller.root), controller.root), 'Controller root changed')
  assert.ok(equalPath(realpathSync.native(controller.file), controller.file), 'Controller path changed')
  assert.equal(relative(controller.root, controller.file), basename(controller.file), 'Controller escaped its canonical private directory')
  const actual = readFileSync(controller.file)
  assert.equal(actual.length, controller.bytes, 'Controller bytes changed')
  assert.equal(digest(actual), controller.sha256, 'Controller content changed')
  assert.ok(actual.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'Controller lost UTF-8 BOM')
  assert.equal(digest(actual.subarray(3)), controller.sourceSha256, 'Controller source changed')
  return ['-NoProfile', '-NonInteractive', '-File', controller.file]
}

export function writePrivateWindowsController(directory, source, { protect = ensurePrivateDirectories } = {}) {
  assert.equal(typeof source, 'string')
  const encoded = Buffer.from(source, 'utf8')
  assert.ok(encoded.length > 0 && encoded.length <= 128 * 1024, 'Controller source is outside the fixture bound')
  const existing = lstatSync(directory, { throwIfNoEntry: false })
  assert.ok(!existing || existing.isDirectory() && !existing.isSymbolicLink(), 'Controller root is not an ordinary directory')
  protect([directory])
  const root = realpathSync.native(directory), sourceSha256 = digest(encoded)
  const file = join(root, `controller-${sourceSha256}.ps1`)
  const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encoded])
  writeFileSync(file, bytes, { flag: 'wx', mode: 0o600 }) // Never adopt a collision.
  const controller = { root, file, sourceSha256, sha256: digest(bytes), bytes: bytes.length }
  const argv = verifyPrivateWindowsController(controller, { protect })
  return { ...controller, argv }
}
