// MODULE: update-restart-fixture.test.mjs - disposable BMN never inherits its lead's control identity
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { afterEach, test, vi } from 'vitest'
import { createUpdateRestartFixture } from '../test/update-restart-fixture.mjs'

afterEach(() => vi.unstubAllEnvs())

test('omits inherited BMN credentials and session identity while setting its own isolated roots', () => {
  for (const key of ['BMN_TOKEN', 'BMN_CONTROL_SOCKET', 'BMN_SESSION_ID', 'BMN_CLI_BIN_DIR', 'BMN_UNEXPECTED_CONTROL']) vi.stubEnv(key, 'synthetic-parent-only')
  const fixture = createUpdateRestartFixture()
  for (const key of ['BMN_TOKEN', 'BMN_CONTROL_SOCKET', 'BMN_SESSION_ID', 'BMN_CLI_BIN_DIR', 'BMN_UNEXPECTED_CONTROL']) assert.equal(fixture.env[key], undefined, key)
  assert.equal(fixture.env.BMN_RUNTIME_HOME, join(fixture.runtime, 'bmn'))
  assert.equal(fixture.env.BMN_DATA_HOME, join(fixture.roots.data, 'bmn'))
  assert.equal(fixture.env.BMN_TEST_RESTART_LAUNCHER, fixture.launcher)
})
