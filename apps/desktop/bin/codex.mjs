// MODULE: codex.mjs - Windows `codex` typed in a BMN session's shell; bin/codex is the Linux equivalent
// Sessions find codex.exe (scripts/build/windows-cli.mjs) ahead of the user's Codex on PATH;
// it runs this script on BMN's runtime with the shell's arguments unchanged. In a BMN session
// the run stays off Codex's shared app-server daemon; otherwise the arguments pass through.
// The real Codex is found on PATH without BMN's own launcher folders, by the literal lookup
// BMN uses for the programs it starts, and runs with the session's environment
// (codex-launch.mjs). This process waits for it and returns its exit code; Ctrl+C reaches
// Codex through the shared console.
import { spawn } from 'node:child_process'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { realCodexLaunch } from './codex-launch.mjs'

let launch
try {
  launch = realCodexLaunch(process.argv.slice(2), process.env, process.cwd(), dirname(fileURLToPath(import.meta.url)))
} catch (error) {
  const message = String(error?.message ?? error)
  process.stderr.write(`codex: ${message.startsWith('The Windows program is not available') ? 'executable not found outside BMN' : message}\n`)
  process.exitCode = 127
}
if (launch) {
  // Ctrl+C and Ctrl+Break are Codex's to answer; this process outlives them to report its exit.
  const ignore = () => undefined
  process.on('SIGINT', ignore)
  process.on('SIGBREAK', ignore)
  const child = spawn(launch.executable, launch.argv, { env: launch.environment, stdio: 'inherit', windowsHide: false })
  child.once('error', (error) => {
    process.stderr.write(`codex: could not start Codex (${error.code ?? 'unknown error'})\n`)
    process.exitCode = 127
  })
  child.once('exit', (code) => { process.exitCode = code ?? 1 })
}
