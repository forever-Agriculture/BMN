// MODULE: hook-parity.mjs - records what `bmn hook` sends and what `bmn hooks check/install` print for Claude, Codex and OpenCode (Epic 31.3 AC4)
// Run before and after a change to the CLI and diff the two files: every request `bmn hook <agent>` makes over the control
// socket (the hook-log records included) and every `hooks check|install --json` report for synthetic hook files.
// Usage: node scripts/test/hook-parity.mjs OUTPUT.json
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const cli = join(repoRoot, 'apps/desktop/bin/bmn')
const fixtures = join(repoRoot, 'apps/desktop/src/utility/test-fixtures/remote-answers')
const output = process.argv[2]
if (!output) throw new Error('usage: node scripts/test/hook-parity.mjs OUTPUT.json')

const root = mkdtempSync(join(tmpdir(), 'bmn-hook-parity-'))
const home = join(root, 'home')
mkdirSync(home, { recursive: true })
const REFERENCE = '01a0b657-21a8-7f00-addd-b73646828f5b'
const OPENCODE_REFERENCE = 'ses_0123456789abSyntheticTest0'

/** A fake /proc: this process is the hook's shell, and its parent the agent holding the terminal. */
function procTree(comm) {
  const proc = join(root, `proc-${comm}`)
  const write = (pid, name, parent) => {
    mkdirSync(join(proc, String(pid)), { recursive: true })
    writeFileSync(join(proc, String(pid), 'stat'), `${pid} (${name}) S ${[parent, 7001, 7001, 34817, 7001, 4194304, 0].join(' ')}\n`)
  }
  write(process.pid, 'sh', 7001)
  write(7001, comm, 1)
  return proc
}

function run(args, env, input) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { PATH: process.env.PATH, HOME: home, ...env },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('close', (code) => resolveRun({ code, stdout, stderr }))
    child.stdin.end(input ?? '')
  })
}

const normalise = (text) => text.split(root).join('<ROOT>').replace(/bmn-backup-[0-9T:.\-Z]+/g, 'bmn-backup-<TIME>')

const socketPath = join(root, 'control.sock')
let received = []
const server = createServer((socket) => {
  socket.setEncoding('utf8')
  let buffer = ''
  socket.on('data', (chunk) => {
    buffer += chunk
    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      const message = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      if (message.method !== 'auth') received.push({ method: message.method, params: message.params })
      socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { recorded: true } })}\n`)
      newline = buffer.indexOf('\n')
    }
  })
})
await new Promise((resolveListen) => server.listen(socketPath, resolveListen))

const fixtureEvents = (agent) => readdirSync(join(fixtures, agent)).sort()
  .map((name) => ({ name, event: JSON.parse(readFileSync(join(fixtures, agent, name), 'utf8')) }))
const synthetic = {
  claude: [
    { hook_event_name: 'SessionStart', source: 'startup', session_id: REFERENCE, transcript_path: '/work/t.jsonl', model: 'claude-opus-5-5' },
    { hook_event_name: 'SessionStart', source: 'compact', session_id: REFERENCE },
    { hook_event_name: 'UserPromptSubmit', session_id: REFERENCE, prompt: 'hello' },
    { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' },
    { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'waiting' },
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'false' }, error: 'exit 1' },
    { hook_event_name: 'Stop', last_assistant_message: 'Done.' },
    { hook_event_name: 'Stop', background_tasks: [{ id: 'b1' }] },
    { hook_event_name: 'SessionEnd', reason: 'exit' },
    { hook_event_name: 'Invented' }
  ],
  codex: [
    { hook_event_name: 'SessionStart', source: 'startup', session_id: REFERENCE, model: 'gpt-6-sol' },
    { hook_event_name: 'UserPromptSubmit', session_id: REFERENCE },
    { hook_event_name: 'PermissionRequest', tool_name: 'shell', tool_input: { command: ['ls'] } },
    { hook_event_name: 'PostToolUse', tool_name: 'shell', tool_input: { command: ['ls'] }, tool_response: 'ok' },
    { hook_event_name: 'Stop' },
    { hook_event_name: 'Interrupt' },
    { hook_event_name: 'SessionEnd' }
  ],
  opencode: [
    { hook_event_name: 'session.created', sessionID: OPENCODE_REFERENCE, info: { id: OPENCODE_REFERENCE } },
    { hook_event_name: 'session.status', sessionID: OPENCODE_REFERENCE, status: { type: 'busy' } },
    { hook_event_name: 'session.idle', sessionID: OPENCODE_REFERENCE },
    { hook_event_name: 'session.error', sessionID: OPENCODE_REFERENCE, error: { message: 'boom' } },
    { hook_event_name: 'message.updated', sessionID: OPENCODE_REFERENCE, info: { id: 'msg', modelID: 'big-pickle' } },
    { hook_event_name: 'tui.session.select', sessionID: OPENCODE_REFERENCE },
    { hook_event_name: 'session.deleted', sessionID: OPENCODE_REFERENCE }
  ]
}
const comms = { claude: 'claude', codex: 'codex', opencode: 'opencode' }

const hooks = {}
for (const agent of ['claude', 'codex', 'opencode']) {
  const proc = procTree(comms[agent])
  const env = {
    BMN_CONTROL_SOCKET: socketPath, BMN_TOKEN: 'parity-token', BMN_PROC_ROOT: proc,
    CLAUDE_CONFIG_DIR: join(home, '.claude'), BMN_OPENCODE_SESSION_ID: OPENCODE_REFERENCE
  }
  const events = [...fixtureEvents(agent), ...synthetic[agent].map((event, index) => ({ name: `synthetic-${index}`, event }))]
  hooks[agent] = []
  for (const { name, event } of events) {
    received = []
    const result = await run(['hook', agent], env, JSON.stringify(event))
    hooks[agent].push({ name, code: result.code, stdout: result.stdout, stderr: result.stderr, requests: JSON.parse(normalise(JSON.stringify(received))) })
  }
}

const checks = {}
const configEnv = { XDG_CONFIG_HOME: join(home, '.config') }
const check = async (label, args) => {
  const result = await run(['hooks', ...args], configEnv)
  checks[label] = { code: result.code, stdout: normalise(result.stdout), stderr: normalise(result.stderr) }
}
for (const agent of ['claude', 'codex', 'opencode']) {
  await check(`${agent}: check, no file`, ['check', agent, '--json'])
  await check(`${agent}: check, no file, text`, ['check', agent])
  await check(`${agent}: install`, ['install', agent, '--json'])
  await check(`${agent}: check, installed`, ['check', agent, '--json'])
  await check(`${agent}: install again`, ['install', agent, '--json'])
}
// A partly wired Claude file with a hand-written entry, and a Codex file with an older wording and a matcher.
const partial = join(root, 'partial-claude.json')
writeFileSync(partial, JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bmn hook claude' }] }],
  PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', timeout: 5, command: '[ -n "$BMN_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook claude; exit 0' }] }],
  SessionStart: [{ hooks: [{ type: 'command', command: 'echo x | bmn hook claude' }] }] } }, null, 2))
await check('claude: check, partial', ['check', 'claude', '--file', partial, '--json'])
await check('claude: check, partial, text', ['check', 'claude', '--file', partial])
const olderCodex = join(root, 'older-codex.json')
writeFileSync(olderCodex, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', timeout: 5, command: '[ -n "$AITERM_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook codex; exit 0' }] }],
  PreToolUse: [{ matcher: null, hooks: [{ type: 'command', timeout: 2 ** 53, command: 'bmn hook codex' }] }] } }))
await check('codex: check, older', ['check', 'codex', '--file', olderCodex, '--json'])
await check('codex: check, older, text', ['check', 'codex', '--file', olderCodex])
// The no-agent check over the installed files; a later agent adds its own report beside these.
const all = await run(['hooks', 'check', '--json'], configEnv)
const parsed = JSON.parse(normalise(all.stdout))
checks['all: check, installed (three agents)'] = { code: all.code, agents: parsed.agents.filter((row) => ['claude', 'codex', 'opencode'].includes(row.agent)) }

server.close()
rmSync(root, { recursive: true, force: true })
writeFileSync(output, `${JSON.stringify({ hooks, checks }, null, 2)}\n`)
console.log(`hook parity: ${Object.values(hooks).flat().length} hook calls, ${Object.keys(checks).length} checks -> ${output}`)
