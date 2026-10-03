import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import { expect, it, vi } from 'vitest'

function adapter(native = {}) {
  const appRequire = createRequire(resolve('apps/desktop/package.json'))
  const source = readFileSync(join(dirname(appRequire.resolve('node-pty')), 'windowsPtyAgent.js'), 'utf8')
  const module = { exports: {} }
  const require = (name) => {
    if (name === './utils') return { loadNativeModule: () => ({ module: native }) }
    if (name === './windowsConoutConnection') return { ConoutConnection: class { constructor() { throw new Error('synthetic worker startup failure') } } }
    if (name === './eventEmitter2') return appRequire(join(dirname(appRequire.resolve('node-pty')), 'eventEmitter2.js'))
    return appRequire(name)
  }
  runInNewContext(source, { module, exports: module.exports, require, Buffer, process })
  return module.exports
}

it('releases the owned native session if output worker construction fails', () => {
  const native = { bmnOwnershipVersion: 1, startProcess: () => ({ pty: 17, conout: 'synthetic' }), kill: vi.fn() }
  const { WindowsPtyAgent } = adapter(native)
  expect(() => new WindowsPtyAgent('cmd.exe', [], [], '.', 80, 24, false, true, true)).toThrow('synthetic worker startup failure')
  expect(native.kill).toHaveBeenCalledExactlyOnceWith(17, true)
})

it('quotes an argument containing literal enclosing quotes and spaces as one value', () => {
  const { argsToCommandLine } = adapter()
  expect(argsToCommandLine('node.exe', ['"a b"'])).toBe('node.exe "\\"a b\\""')
})

it('quotes the executable path when the raw argument tail is empty', () => {
  const { argsToCommandLine } = adapter()
  expect(argsToCommandLine('C:\\Program Files\\PowerShell\\7\\pwsh.exe', ''))
    .toBe('"C:\\Program Files\\PowerShell\\7\\pwsh.exe"')
})
