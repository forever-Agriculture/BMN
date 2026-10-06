import assert from 'node:assert/strict'

// Electron/Playwright can prepend debugger flags before the fixture's entry path.
export function fixtureArguments(argv, entry) {
  const index = argv.indexOf(entry)
  assert.ok(index >= 1, 'The fixture entry path must be present in argv')
  return argv.slice(index + 1)
}
