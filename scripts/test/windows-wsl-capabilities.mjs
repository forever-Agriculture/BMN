// Read-only discovery on the disposable Windows runner. No distro installation/start or owner config edits.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const receipt = { platform: process.platform, acceptance: 'UNVERIFIED', measuredGuestOwnership: false }
if (process.platform === 'win32') {
  const executable = join(process.env.SystemRoot, 'System32', 'wsl.exe')
  receipt.executablePresent = existsSync(executable)
  receipt.commands = []
  if (receipt.executablePresent) {
    for (const args of [['--version'], ['--status'], ['--list', '--verbose']]) {
      const decode = buffer => {
        if (!Buffer.isBuffer(buffer)) return ''
        const utf16 = buffer.includes(0)
        return buffer.toString(utf16 ? 'utf16le' : 'utf8').replace(/^\uFEFF/u, '').trim().slice(0, 4000)
      }
      try {
        const output = execFileSync(executable, args, { windowsHide: true, timeout: 8000,
          maxBuffer: 16 * 1024, stdio: ['ignore', 'pipe', 'pipe'] })
        receipt.commands.push({ args, exit: 0, stdout: decode(output) })
      } catch (error) {
        receipt.commands.push({ args, exit: typeof error.status === 'number' ? error.status : null,
          code: error.code ?? null, signal: error.signal ?? null,
          stdout: decode(error.stdout), stderr: decode(error.stderr) })
      }
    }
  }
} else {
  receipt.reason = 'Native Windows WSL capability discovery is unavailable on this OS'
}
mkdirSync('test-results', { recursive: true })
writeFileSync('test-results/windows-wsl-capabilities.json', JSON.stringify(receipt, null, 2))
console.log(JSON.stringify(receipt))
