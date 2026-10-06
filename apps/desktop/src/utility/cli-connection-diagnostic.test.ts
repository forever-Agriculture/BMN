import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { instrumentCliConnection } from './cli-connection-diagnostic.test-support'

describe('exact CLI connection diagnostic copies', () => {
  it.each([false, true])('preserves guarded source extraction from a native CRLF checkout, listenersFirst=%s', listenersFirst => {
    const source = readFileSync(new URL('../../bin/bmn', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
    const helper = new URL('../../bin/safe-config-write.mjs', import.meta.url).href
    expect(instrumentCliConnection(source.replaceAll('\n', '\r\n'), helper, listenersFirst))
      .toBe(instrumentCliConnection(source, helper, listenersFirst))
  })
})
