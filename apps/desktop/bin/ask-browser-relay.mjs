#!/usr/bin/env node
// MODULE: ask-browser-relay.mjs - Story 74.3: starts a browser ask's MCP server (Playwright's) in the run's own browser folder, its temporary files in the run's own temporary folder, and passes its messages both ways, keeping the app's workspace roots from it, so every file the server writes (a named screenshot, snapshot or log) lands in that folder and never in the asker's project
// node ask-browser-relay.mjs <folder> <temporary> <command> [args...]
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'

/**
 * Playwright's MCP server (0.0.75) writes a file the model names inside the client's first workspace
 * root, read once when the client starts it, or inside its own folder when the client offers no roots;
 * Codex and Claude Code may offer the project they work in. So the client's offer of roots is taken out
 * of its `initialize` request, and the server starts in the run's browser folder, its output folder too.
 * Every other message passes unchanged.
 */
function withoutRoots(line) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return line
  }
  if (message === null || typeof message !== 'object' || message.method !== 'initialize' || message.params?.capabilities?.roots === undefined) return line
  const capabilities = { ...message.params.capabilities }
  delete capabilities.roots
  return JSON.stringify({ ...message, params: { ...message.params, capabilities } })
}

const [folder, temporary, command, ...args] = process.argv.slice(2)
if (folder === undefined || temporary === undefined || command === undefined) {
  process.stderr.write('usage: ask-browser-relay.mjs <folder> <temporary> <command> [args...]\n')
  process.exit(2)
}
// The browser's profile and Playwright's working files (TMPDIR): the run's own folder, owner-only, which BMN removes with the record.
mkdirSync(temporary, { recursive: true, mode: 0o700 })
const server = spawn(command, args, { cwd: folder, env: { ...process.env, TMPDIR: temporary }, stdio: ['pipe', 'inherit', 'inherit'] })
server.on('error', (error) => {
  process.stderr.write(`ask-browser-relay: ${error.message}\n`)
  process.exit(1)
})
server.on('exit', (code, signal) => process.exit(code ?? (signal === null ? 0 : 1)))
server.stdin.on('error', () => {})
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => server.kill(signal))

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
    server.stdin.write(`${withoutRoots(buffer.slice(0, at))}\n`)
    buffer = buffer.slice(at + 1)
  }
})
process.stdin.on('end', () => {
  if (buffer !== '') server.stdin.write(withoutRoots(buffer))
  server.stdin.end()
})
