// Fixture-only runtime-file locations. No error messages, values or paths.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { openSync, closeSync, lstatSync, fstatSync, readSync } from 'node:fs'
import { win32, posix } from 'node:path'
const allowed = new Set(['scripts/lib/windows-installed-worker.mjs', 'scripts/lib/windows-release-transaction.mjs',
  'scripts/lib/windows-release-payload.mjs', 'scripts/lib/windows-release-data.mjs', 'scripts/test/windows-installed-launcher-driver.mjs'])
const names = new Set(['Error', 'AssertionError', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'AggregateError', 'AbortError', 'ConfigWriteError'])
const operators = new Set(['==', '===', '!==', '!=', 'deepStrictEqual', 'strictEqual', 'notStrictEqual', 'ok'])
const sourceLimit = 1024 * 1024
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function readBoundedSource(file) {
  const before = lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error('Unsupported source object')
  const fd = openSync(file, 'r')
  try {
    const actual = fstatSync(fd)
    if (!actual.isFile() || actual.nlink !== 1 || actual.dev !== before.dev || actual.ino !== before.ino || actual.size > sourceLimit) throw new Error('Source identity unavailable')
    const bytes = Buffer.alloc(actual.size + 1), size = readSync(fd, bytes, 0, bytes.length, 0)
    if (size !== actual.size || fstatSync(fd).size !== actual.size) throw new Error('Source size changed')
    return bytes.subarray(0, size)
  } finally { closeSync(fd) }
}
/** Capture before importing/executing the measured installer modules. */
export function captureInstalledSourceBindings(repo, { platform = process.platform, readSource = readBoundedSource } = {}) {
  const paths = platform === 'win32' ? win32 : posix, bindings = {}
  for (const module of allowed) {
    try {
      const bytes = readSource(paths.join(repo, module))
      if (!Buffer.isBuffer(bytes) || bytes.length > sourceLimit) throw new Error('Source exceeds bound')
      bindings[module] = Object.freeze({ sha256: sha256(bytes), bytes: bytes.length })
    } catch { bindings[module] = null }
  }
  return Object.freeze(bindings)
}
export function installedFailureDiagnostic(error, repo, { platform = process.platform, readSource = readBoundedSource, sourceBindings = {} } = {}) {
  const result = { name: 'UNKNOWN', category: 'operation', frames: [], locationStatus: 'unavailable' }
  try {
    if (error instanceof assert.AssertionError) result.category = 'assertion'
    if (names.has(error?.name)) result.name = error.name
    if (operators.has(error?.operator)) result.operator = error.operator
    const paths = platform === 'win32' ? win32 : posix
    for (const line of String(error?.stack ?? '').slice(0, 65536).split(/\r?\n/u).slice(1, 33)) {
      if (!/^\s+at /u.test(line)) continue
      const match = line.match(/(?:\(|\s)((?:file:\/\/\/|[a-z]:[\\/]|\/).+):(\d+):(\d+)\)?$/iu)
      if (!match) continue
      let absolute = match[1]
      if (absolute.startsWith('file:')) {
        const url = new URL(absolute)
        if (url.hostname) continue
        absolute = decodeURIComponent(url.pathname)
        if (platform === 'win32') absolute = absolute.replace(/^\/([a-z]:\/)/iu, '$1')
      }
      const module = paths.relative(repo, absolute).replaceAll('\\', '/')
      if (!allowed.has(module) || result.frames.length >= 6) continue
      const lineNumber = Number(match[2]), column = Number(match[3])
      if (!Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(column) || lineNumber < 1 || column < 1) continue
      const frame = { module, line: lineNumber, column, coordinateKind: 'runtime-file', sourceStatus: 'unavailable' }
      try {
        const binding = sourceBindings[module], bytes = readSource(paths.join(repo, module))
        if (!Buffer.isBuffer(bytes) || bytes.length > sourceLimit) throw new Error('Source exceeds bound')
        if (binding && /^[a-f0-9]{64}$/u.test(binding.sha256)) {
          frame.sourceStatus = binding.bytes === bytes.length && binding.sha256 === sha256(bytes) ? 'matched' : 'mismatch'
          if (frame.sourceStatus === 'matched') frame.sourceSha256 = binding.sha256
        }
      } catch { /* A secondary diagnostic error cannot replace the primary failure. */ }
      result.frames.push(frame)
    }
    if (result.frames.length) result.locationStatus = 'observed'
  } catch { result.diagnosticUnavailable = true }
  return result
}
