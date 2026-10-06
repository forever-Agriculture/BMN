// An offline payload identity covers every file, including native sidecars.
// Hashes detect corruption; they do not establish publisher authenticity.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { physicalPayloadFs } from './physical-payload-fs.mjs'
import { join } from 'node:path'
import { releaseDescriptor } from './windows-release-transaction.mjs'

const { copyFileSync, createReadStream, lstatSync, readdirSync, readFileSync, writeFileSync } = physicalPayloadFs

export const payloadManifestName = 'bmn-release.json'
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export function createWindowsWorkerImage(root) {
  const executable = join(root, 'BMN.exe'), worker = join(root, 'BMN-worker.exe')
  copyFileSync(executable, worker, 1) // COPYFILE_EXCL; never adopt an existing image.
  // The streaming inventory/seal below checks byte/hash equality without
  // holding two full Electron executables in memory.
}
function requireWindowsWorkerImage(files) {
  const executable = files.find(file => file.path === 'BMN.exe'), worker = files.find(file => file.path === 'BMN-worker.exe')
  assert.ok(executable && worker, 'Missing dedicated worker image')
  assert.equal(worker.bytes, executable.bytes, 'Dedicated worker image differs from packaged runtime')
  assert.equal(worker.sha256, executable.sha256, 'Dedicated worker image differs from packaged runtime')
}

export function readInstallerDescriptor(root) {
  const path = join(root, payloadManifestName), info = lstatSync(path)
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'Invalid release manifest file')
  const bytes = readFileSync(path), manifest = JSON.parse(bytes)
  assert.equal(manifest.format, 1, 'Unsupported payload manifest')
  return releaseDescriptor({ commit: manifest.commit, schemaVersion: manifest.schemaVersion, payloadSha256: hash(bytes) })
}
async function hashFile(path) {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('hex')
}
export function validateWindowsPayloadName(name) {
  assert.ok(!/[\\/:]/u.test(name) && ![...name].some(char => char.charCodeAt(0) < 32) && !/[. ]$/u.test(name), 'Unsupported payload name')
  assert.ok(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name), 'Reserved payload name')
}
function names(root, prefix = '') {
  const info = lstatSync(root)
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), 'Payload refuses linked directories')
  const result = []
  const entries = readdirSync(root).sort()
  assert.equal(new Set(entries.map(name => name.toLowerCase())).size, entries.length, 'Payload has colliding Windows names')
  for (const name of entries) {
    validateWindowsPayloadName(name)
    const path = join(root, name), relative = prefix + name, stat = lstatSync(path)
    assert.equal(stat.isSymbolicLink(), false, 'Payload refuses links')
    if (stat.isDirectory()) result.push(...names(path, relative + '/'))
    else {
      assert.ok(stat.isFile() && stat.nlink === 1, 'Payload refuses special or hardlinked files')
      if (relative !== payloadManifestName) result.push(relative)
    }
  }
  return result
}
async function inventory(root) {
  const paths = names(root)
  assert.equal(new Set(paths.map(path => path.toLowerCase())).size, paths.length, 'Payload has colliding Windows names')
  const files = []
  for (const path of paths) files.push({ path, bytes: lstatSync(join(root, path)).size, sha256: await hashFile(join(root, path)) })
  return files
}
export async function sealWindowsReleasePayload(root, { commit, schemaVersion, electronVersion }) {
  const manifest = { format: 1, commit, schemaVersion, ...(electronVersion ? { electronVersion } : {}), files: await inventory(root) }
  const text = JSON.stringify(manifest) + '\n', descriptor = releaseDescriptor({ commit, schemaVersion, payloadSha256: hash(text) })
  assert.ok(manifest.files.some(file => file.path === 'BMN.exe'), 'Missing packaged Windows executable')
  assert.ok(manifest.files.some(file => file.path === 'resources/app.asar'), 'Missing packaged application')
  requireWindowsWorkerImage(manifest.files)
  writeFileSync(join(root, payloadManifestName), text, { flag: 'wx', mode: 0o600 })
  await validateWindowsReleasePayload(root, descriptor)
  return descriptor
}
export async function validateWindowsReleasePayload(root, expected) {
  const info = lstatSync(join(root, payloadManifestName))
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1, 'Invalid release manifest file')
  const bytes = readFileSync(join(root, payloadManifestName)), manifest = JSON.parse(bytes)
  assert.equal(manifest.format, 1, 'Unsupported payload manifest')
  const actual = releaseDescriptor({ commit: manifest.commit, schemaVersion: manifest.schemaVersion, payloadSha256: hash(bytes) })
  assert.deepEqual(actual, releaseDescriptor(expected), 'Payload identity differs from selected release')
  assert.deepEqual(await inventory(root), manifest.files, 'Payload content differs from release manifest')
  requireWindowsWorkerImage(manifest.files)
  return actual
}
