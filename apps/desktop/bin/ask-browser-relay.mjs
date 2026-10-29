#!/usr/bin/env node
// MODULE: ask-browser-relay.mjs - Story 74.3: starts a browser ask's MCP server (Playwright's) in the run's own browser folder, its temporary files in the run's own temporary folder, and passes its messages both ways, keeping the app's workspace roots from it, so every file the server writes (a named screenshot, snapshot or log) lands in that folder and never in the asker's project
// node ask-browser-relay.mjs <folder> <temporary> <command> [args...]
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserTools } from './agents-team-browser.mjs'

const QA_TOOLS = new Set(browserTools(true, true))
const QA_METHODS = new Set(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'ping', 'notifications/cancelled'])

/** Reject at the relay even if a client ignores its enabled_tools list. */
export function qaMessageProblem(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return 'QA MCP messages must be single objects'
  if (message.method === undefined && message.id !== undefined) return null
  if (!QA_METHODS.has(message.method)) return 'This MCP method is unavailable to quick QA'
  if (message.method === 'tools/call' && !QA_TOOLS.has(message.params?.name)) return 'This browser tool is unavailable to quick QA'
  return null
}

/**
 * Playwright's MCP server (0.0.75) writes a file the model names inside the client's first workspace
 * root, read once when the client starts it, or inside its own folder when the client offers no roots;
 * Codex and Claude Code may offer the project they work in. So the client's offer of roots is taken out
 * of its `initialize` request, and the server starts in the run's browser folder, its output folder too.
 * Every other message passes unchanged. This directs managed artifacts; it does not sandbox
 * the filesystem or network access of interactive server scripts.
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

function main([folder, temporary, command, ...args]) {
  const qa = command === '--qa'
  if (qa) command = args.shift()
  if (folder === undefined || temporary === undefined || command === undefined) {
    process.stderr.write('usage: ask-browser-relay.mjs <folder> <temporary> <command> [args...]\n')
    process.exit(2)
  }
  // The browser's profile and Playwright's working files (TMPDIR): the run's own folder, owner-only, which BMN removes with the record.
  mkdirSync(temporary, { recursive: true, mode: 0o700 })
  const server = spawn(command, args, { cwd: folder, env: { ...process.env, TMPDIR: temporary }, stdio: ['pipe', qa ? 'pipe' : 'inherit', 'inherit'] })
  const pending = new Map()
  function forward(line) {
    if (qa) {
      let message
      try { message = JSON.parse(line) } catch { process.stderr.write('Invalid QA MCP input\n'); return }
      const problem = qaMessageProblem(message)
      if (problem) {
        if (message?.id !== undefined) process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: problem } })}\n`)
        return
      }
      if (message.id !== undefined && message.method) pending.set(message.id, message.method)
    }
    server.stdin.write(`${withoutRoots(line)}\n`)
  }
  if (qa) {
    let output = ''
    server.stdout.setEncoding('utf8')
    server.stdout.on('data', chunk => {
      output += chunk
      for (let at = output.indexOf('\n'); at !== -1; at = output.indexOf('\n')) {
        const line = output.slice(0, at); output = output.slice(at + 1)
        let message
        try { message = JSON.parse(line) } catch { continue }
        if (pending.get(message.id) === 'tools/list' && Array.isArray(message.result?.tools)) message.result.tools = message.result.tools.filter(tool => QA_TOOLS.has(tool.name))
        pending.delete(message.id)
        process.stdout.write(`${JSON.stringify(message)}\n`)
      }
    })
  }
  server.on('error', (error) => {
    process.stderr.write(`ask-browser-relay: ${error.message}\n`)
    process.exit(1)
  })
  server.on(qa ? 'close' : 'exit', (code, signal) => {
    const status = code ?? (signal === null ? 0 : 1)
    if (qa) process.stdout.write('', () => process.exit(status))
    else process.exit(status)
  })
  server.stdin.on('error', () => {})
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => server.kill(signal))

  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
    for (let at = buffer.indexOf('\n'); at !== -1; at = buffer.indexOf('\n')) {
      forward(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
    }
  })
  process.stdin.on('end', () => {
    if (buffer !== '') forward(buffer)
    server.stdin.end()
  })
}

// Packaging imports every CLI module to check it loads; only a direct invocation starts the relay.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
