// Visual C++ build environment on Windows, found with vswhere; values stay in memory.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

export function msvcEnvironment() {
  assert.equal(process.platform, 'win32')
  const vswhere = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  const vs = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' })
  if (vs.status !== 0 || !vs.stdout.trim()) throw new Error('Visual Studio C++ build tools were not found (install "Desktop development with C++")')
  const installation = vs.stdout.trim()
  if (/["\r\n&|<>%^!]/.test(installation)) throw new Error('Unexpected Visual Studio installation path')
  const setup = spawnSync(join(process.env.SystemRoot, 'System32', 'cmd.exe'), ['/d', '/s', '/c',
    `"call "${join(installation, 'Common7', 'Tools', 'VsDevCmd.bat')}" -arch=x64 -host_arch=x64 >nul && set"`],
  { encoding: 'utf8', windowsVerbatimArguments: true, timeout: 60000 })
  if (setup.status !== 0) throw new Error('Visual C++ environment setup failed')
  return Object.fromEntries(setup.stdout.split(/\r?\n/).flatMap(line => {
    const equal = line.indexOf('=')
    return equal > 0 ? [[line.slice(0, equal), line.slice(equal + 1)]] : []
  }))
}
