// MODULE: defaults-publish.mjs - Fail-closed bridge to the packaged Linux no-replace helper
import { spawnSync } from 'node:child_process'
import { existsSync, fstatSync, lstatSync } from 'node:fs'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertDefaultsAdmission } from './defaults-admission.mjs'

const failure = (message, published = false) => Object.assign(new Error(message), {
  code: 'DEFAULTS_PUBLICATION_UNAVAILABLE', published: published === true, publicationUnknown: published === 'unknown'
})
export function defaultsPublicationHelper() {
  for (const url of ['./defaults-publish', '../resources/defaults/defaults-publish']) {
    const path = fileURLToPath(new URL(url, import.meta.url))
    if (existsSync(path)) return path
  }
  throw failure('The setup publication helper is missing; rebuild BMN before installing defaults')
}

/** source/destination are single names in the inherited parent descriptor, never shell arguments. */
export function publishSetupEntry(parentFd, source, destination, expected, { helper = defaultsPublicationHelper() } = {}) {
  assertDefaultsAdmission()
  if (![source, destination].every(name => typeof name === 'string' && name === basename(name) && !['', '.', '..'].includes(name) && !name.includes('\0')) ||
    !['tree', 'link', 'file'].includes(expected.kind) || !/^\d+:\d+$/.test(expected.object)) throw failure('Invalid setup publication parameters')
  const parent = fstatSync(parentFd)
  if (!parent.isDirectory() || `${parent.dev}:${parent.ino}` !== expected.parent) throw failure('The setup publication parent changed')
  const args = [source, destination, expected.kind, ...expected.object.split(':'), ...expected.parent.split(':')]
  const executable = lstatSync(helper)
  if (!executable.isFile() || executable.isSymbolicLink()) throw failure('The setup publication helper is not a regular executable')
  const result = spawnSync(helper, args, { stdio: ['ignore', 'pipe', 'pipe', parentFd], env: { LANG: 'C' }, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 })
  assertDefaultsAdmission()
  let receipt
  try { receipt = JSON.parse(result.stdout) } catch { throw failure('The setup publication helper returned no valid receipt; inspect the target', 'unknown') }
  if (!receipt || Object.keys(receipt).sort().join(',') !== 'code,errno,published,version' || receipt.version !== 1 ||
    typeof receipt.published !== 'boolean' || !Number.isInteger(receipt.errno) || typeof receipt.code !== 'string') throw failure('The setup publication receipt is invalid; inspect the target', 'unknown')
  if (result.status !== 0 || result.error || receipt.code !== 'OK' || receipt.published !== true) {
    const error = failure(`Setup publication ${receipt.code}; ${receipt.published ? 'an entry was published and needs inspection' : 'no entry was published'}`, receipt.published)
    if (['EXISTS', 'SOURCE_CHANGED', 'TARGET_CHANGED', 'PARENT_CHANGED'].includes(receipt.code)) error.code = 'REVISION_CONFLICT'
    throw error
  }
  return receipt
}
