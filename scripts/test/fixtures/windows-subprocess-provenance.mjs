import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const powerShellSourceSha256 = source => sha256(Buffer.from(source, 'utf16le'))

// Canonical UTF-8 JSON of sorted [lowercase-name, string-value] pairs. Values
// remain inside the digest; ambiguous Windows case aliases are refused.
export function windowsEnvironmentFingerprint(environment = process.env) {
  const names = new Set(), entries = []
  for (const [name, value] of Object.entries(environment)) {
    const key = name.toLowerCase()
    assert.ok(!names.has(key), 'Ambiguous Windows environment aliases')
    assert.equal(typeof value, 'string', 'Environment values must be strings')
    names.add(key); entries.push([key, value])
  }
  entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return sha256(Buffer.from(JSON.stringify(entries), 'utf8'))
}
