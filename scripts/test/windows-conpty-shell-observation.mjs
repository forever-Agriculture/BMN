// MODULE: windows-conpty-shell-observation.mjs - observation only: ordinary shells under the bundled ConPTY
// Before the Windows self-test asserts its shell-regression equivalent, this records what Windows
// PowerShell, cmd and a raw-mode program send and receive through the same ConPTY route BMN uses:
// device attributes requests and replies, titles, console-API and 256-color output, the shell's own
// coloring, bracketed paste at the prompt and a full-screen program's modes. It never fails its caller.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WINDOWS_FULL_SCREEN, WINDOWS_SHELL_CHECKS } from '../../apps/desktop/src/main/self-test/programs.ts'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export async function observeWindowsConptyShells() {
  const root = mkdtempSync(join(tmpdir(), 'bmn-conpty-shell-observation-'))
  try {
    const checks = join(root, 'checks.ps1'), fullScreen = join(root, 'full-screen.ps1'), result = join(root, 'result.json')
    writeFileSync(checks, WINDOWS_SHELL_CHECKS)
    writeFileSync(fullScreen, WINDOWS_FULL_SCREEN)
    const packageJson = join(repo, 'apps/desktop/package.json')
    const child = spawn(createRequire(packageJson)('electron'), [join(repo, 'scripts/test/windows-conpty-shell-worker.mjs'),
      packageJson, checks, fullScreen, result], { cwd: repo, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stderr = ''
    child.stderr.on('data', data => { stderr += data })
    const code = await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve('timeout') }, 240000)
      child.once('error', error => { clearTimeout(timer); resolve(`spawn:${error.code ?? 'unknown'}`) })
      child.once('exit', exitCode => { clearTimeout(timer); resolve(exitCode) })
    })
    const observation = code === 0 ? JSON.parse(readFileSync(result, 'utf8')) : { unavailable: true, code, stderr: stderr.slice(-2000) }
    const receipt = { nativeDiagnostic: 'conpty-shells', observationOnly: true, ...observation }
    mkdirSync(join(repo, 'test-results'), { recursive: true })
    writeFileSync(join(repo, 'test-results/windows-conpty-shell-observation.json'), JSON.stringify(receipt, null, 2))
    return receipt
  } catch (error) {
    return { nativeDiagnostic: 'conpty-shells', observationOnly: true, unavailable: true, error: String(error?.message ?? error).slice(0, 500) }
  } finally {
    try { rmSync(root, { recursive: true, force: true }) } catch { /* The runner image is discarded. */ }
  }
}
