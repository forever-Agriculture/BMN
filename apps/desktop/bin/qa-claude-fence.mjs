// MODULE: qa-claude-fence.mjs - per-run, no-model proof that the Claude Code QA form offers only the QA relay's tools
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { sameProgram } from './agents-team-forms.mjs'
import { writeWhole } from './agents-team-supervisor.mjs'

/** Raise when the fence's forced calls or its acceptance rule change, so older proofs stop qualifying runs. */
export const QA_FENCE_POLICY = 2
export const QA_RELAY_SERVER = 'playwright'
const here = fileURLToPath(import.meta.url)
const CANARY = 'QA-FENCE-CANARY-5d1e'
const sha256 = value => createHash('sha256').update(value).digest('hex')

/**
 * Calls a stand-in model forces on the real launch: built-in file, shell, web, sub-agent, skill and
 * resource tools, plus an inherited-server canary. Each must come back as a completed refusal.
 */
const forced = (root, port) => [
  ['Bash', { command: `cat ${join(root, 'home/canary.txt')}` }], ['Read', { file_path: join(root, 'home/canary.txt') }],
  ['Write', { file_path: join(root, 'cwd/written.txt'), content: 'x' }], ['Edit', { file_path: join(root, 'home/canary.txt'), old_string: 'CANARY', new_string: 'X' }],
  ['Glob', { pattern: '**/*' }], ['Grep', { pattern: 'CANARY', path: root }], ['WebFetch', { url: `http://127.0.0.1:${port}/fetched`, prompt: 'x' }],
  ['WebSearch', { query: 'x' }], ['Agent', { description: 'x', prompt: 'read the canary', subagent_type: 'general-purpose' }],
  ['Task', { description: 'x', prompt: 'read the canary', subagent_type: 'general-purpose' }], ['Skill', { skill: 'x' }],
  ['NotebookEdit', { notebook_path: join(root, 'home/canary.txt'), new_source: 'x' }], ['TodoWrite', { todos: [] }],
  ['ToolSearch', { query: 'select:Bash', max_results: 5 }], ['ListMcpResourcesTool', {}],
  ['ReadMcpResourceTool', { server: QA_RELAY_SERVER, uri: `file://${join(root, 'home/canary.txt')}` }],
  ['LSP', {}], ['Monitor', {}], ['EnterWorktree', {}], ['DeferredToolPlaceholder', {}], ['mcp__canary__canary_tool', {}]
]

/** What a fence proves and a run must match: executable, form, model, effort and the command with the relay elided. */
export function fenceBinding(launch) {
  const command = launch.built.command.map((arg, index, all) => all[index - 1] === '--mcp-config' ? '<qa-relay>' : arg)
  return { policy: QA_FENCE_POLICY, form: launch.form, model: launch.model, effort: launch.effort, version: launch.version ?? null,
    launcher: launch.identity.launcher.sha256, payload: launch.identity.payload.sha256, commandSha256: sha256(JSON.stringify(command)),
    tools: [...launch.tools].sort() }
}
const toolsSha256 = tools => sha256(JSON.stringify([...tools].sort()))

/**
 * Runs the prepared command once against a loopback stand-in for the model service, with a synthetic
 * key, a synthetic home holding canary settings, hooks and MCP servers, and a synthetic relay offering
 * the same tool names. No real model or account is reached. Writes `fence.json` beside `launch.json`.
 */
export async function qualifyClaudeQa(folder, { timeoutMs = 120_000 } = {}) {
  const launch = JSON.parse(readFileSync(join(folder, 'launch.json'), 'utf8'))
  if (launch.form !== 'claude-qa' || !sameProgram(launch.identity, launch.program)) throw new Error('QA_LAUNCH_CHANGED')
  const root = join(folder, 'fence', randomUUID())
  for (const path of ['home/.claude', 'cwd']) mkdirSync(join(root, path), { recursive: true, mode: 0o700 })
  writeFileSync(join(root, 'home/canary.txt'), CANARY + '\n')
  const hookMark = join(root, 'home/hook-ran.txt'), canaryServer = { type: 'stdio', command: process.execPath, args: [here, '--mcp', JSON.stringify(['canary_tool'])] }
  writeFileSync(join(root, 'home/.claude/settings.json'), JSON.stringify({ permissions: { allow: ['Bash', 'Read', 'WebFetch'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${hookMark}` }] }], PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `touch ${hookMark}` }] }] } }))
  writeFileSync(join(root, 'home/.claude.json'), JSON.stringify({ mcpServers: { canary: canaryServer } }))
  writeFileSync(join(root, 'home/.claude/.claude.json'), JSON.stringify({ mcpServers: { canary: canaryServer } }))
  writeFileSync(join(root, 'cwd/.mcp.json'), JSON.stringify({ mcpServers: { canary: canaryServer } }))
  const expected = launch.tools.map(name => `mcp__${QA_RELAY_SERVER}__${name}`)
  // With --json-schema Claude Code adds one tool that only returns the final answer; an empty report must come back refused by its schema check.
  const structured = launch.built.command.includes('--json-schema'), builtins = ['DeferredToolPlaceholder', ...(structured ? ['StructuredOutput'] : [])]
  const forcedCalls = (root, port) => [...forced(root, port), ...(structured ? [['StructuredOutput', {}]] : [])]
  const requests = [], results = new Map()
  let fetched = 0, calls = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      let json = null
      try { json = JSON.parse(body) } catch { /* Non-JSON service calls are answered empty and recorded. */ }
      // Only names and markers are kept: headers, keys and bodies never leave this handler.
      requests.push({ method: request.method, path: request.url.split('?')[0], tools: Array.isArray(json?.tools) ? json.tools.map(tool => tool.name ?? tool.type) : null,
        prompt: body.includes('QA-FENCE-PROMPT'), canary: body.includes(CANARY) })
      if (request.url.startsWith('/fetched')) { fetched++; response.writeHead(200).end('fetched'); return }
      if (request.url.startsWith('/v1/messages/count_tokens')) { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{"input_tokens":10}'); return }
      if (!request.url.startsWith('/v1/messages')) { response.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'); return }
      const returned = (json?.messages ?? []).flatMap(message => Array.isArray(message.content) ? message.content.filter(item => item.type === 'tool_result') : [])
      for (const item of returned) results.set(item.tool_use_id, { error: item.is_error === true, text: (typeof item.content === 'string' ? item.content : JSON.stringify(item.content)).slice(0, 400) })
      const blocks = body.includes('QA-FENCE-PROMPT') && returned.length === 0 ? calls : [{ type: 'text', text: 'FENCE-DONE' }]
      answer(response, blocks, blocks === calls ? 'tool_use' : 'end_turn', json?.stream === true)
    })
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  calls = [...forcedCalls(root, port), ...expected.map(name => [name, {}])].map(([name, input], index) => ({ type: 'tool_use', id: `toolu_${index}_${name}`, name, input }))
  const command = launch.built.command.map((arg, index, all) => all[index - 1] === '--mcp-config'
    ? JSON.stringify({ mcpServers: { [QA_RELAY_SERVER]: { type: 'stdio', command: process.execPath, args: [here, '--mcp', JSON.stringify(launch.tools)] } } }) : arg)
  const environment = { HOME: join(root, 'home'), CLAUDE_CONFIG_DIR: join(root, 'home/.claude'), PATH: launch.built.environment.PATH,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`, ANTHROPIC_API_KEY: 'sk-ant-qa-fence-synthetic', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }
  const child = spawn(command[0], command.slice(1), { cwd: join(root, 'cwd'), env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
  let init = null, stderr = ''
  createInterface({ input: child.stdout }).on('line', line => {
    try { const event = JSON.parse(line); if (!init && event.type === 'system' && event.subtype === 'init') init = event } catch { /* Not an event line. */ }
  })
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000) })
  child.stdin.end('QA-FENCE-PROMPT: call the tools the model asks for.')
  const exit = await new Promise(done => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); done('timeout') }, timeoutMs)
    child.once('error', () => { clearTimeout(timer); done('spawn-failed') })
    child.once('exit', code => { clearTimeout(timer); done(code) })
  })
  await new Promise(done => server.close(done))
  const offered = [...new Set(requests.filter(entry => entry.prompt && entry.tools).flatMap(entry => entry.tools))].sort()
  const byName = Object.fromEntries(calls.map(call => [call.name, results.get(call.id) ?? null]))
  const refusals = forcedCalls(root, port).map(([name]) => ({ name, completed: byName[name] !== null, refused: byName[name]?.error === true && !byName[name].text.includes(CANARY), text: byName[name]?.text.slice(0, 160) ?? null }))
  const usable = expected.map(name => ({ name, ok: byName[name]?.error === false && byName[name].text.includes('QA-FENCE-MCP-OK') }))
  const extra = offered.filter(name => !expected.includes(name))
  const intact = readFileSync(join(root, 'home/canary.txt'), 'utf8') === CANARY + '\n' && !existsSync(join(root, 'cwd/written.txt')) && !existsSync(hookMark) && fetched === 0 && !requests.some(entry => entry.canary)
  const initTools = Array.isArray(init?.tools) ? [...init.tools].sort() : null
  const pass = exit === 0 && expected.every(name => offered.includes(name)) && extra.every(name => builtins.includes(name) && byName[name]?.error === true) &&
    refusals.every(item => item.completed && item.refused) && (!structured || /required schema/.test(byName.StructuredOutput?.text ?? '')) && usable.every(item => item.ok) && intact && initTools !== null && initTools.every(name => expected.includes(name) || builtins.includes(name))
  const receipt = { version: 1, binding: fenceBinding(launch), pass, exit, offered, extra, refusals, usable, intact, fetched,
    initTools, initToolsSha256: initTools ? toolsSha256(initTools) : null, initMcpServers: init?.mcp_servers ?? null,
    requests: requests.map(({ method, path, prompt, canary, tools }) => ({ method, path, prompt, canary, tools: tools?.length ?? null })),
    realModelCalled: false, stderrTail: stderr.replaceAll(environment.ANTHROPIC_API_KEY, '[synthetic]').slice(-600) }
  writeWhole(join(folder, 'fence.json'), JSON.stringify(receipt, null, 2) + '\n')
  return receipt
}

/** The production init event names the tools this very run offers; they must equal the fence's. */
export function checkQaInit(folder, event, agent) {
  const fence = JSON.parse(readFileSync(join(folder, 'fence.json'), 'utf8'))
  const tools = Array.isArray(event?.tools) ? [...event.tools].sort() : null
  const servers = Array.isArray(event?.mcp_servers) ? event.mcp_servers.map(server => `${server.name}:${server.status}`).sort() : null
  const ok = fence.pass === true && tools !== null && toolsSha256(tools) === fence.initToolsSha256 && JSON.stringify(servers) === JSON.stringify([`${QA_RELAY_SERVER}:connected`])
  const record = { version: 1, ok, toolsSha256: tools ? toolsSha256(tools) : null, servers, agent: { pid: agent.pid, ticks: agent.ticks } }
  writeWhole(join(folder, 'init.json'), JSON.stringify(record) + '\n')
  return record
}

/** Host check: the run's own fence passed for this launch, its init matched, and the program on disk is unchanged. */
export function qualifiedQaRun(folder, agent) {
  try {
    const launch = JSON.parse(readFileSync(join(folder, 'launch.json'), 'utf8'))
    const fence = JSON.parse(readFileSync(join(folder, 'fence.json'), 'utf8')), init = JSON.parse(readFileSync(join(folder, 'init.json'), 'utf8'))
    return launch.form === 'claude-qa' && fence.pass === true && JSON.stringify(fence.binding) === JSON.stringify(fenceBinding(launch)) &&
      init.ok === true && init.toolsSha256 === fence.initToolsSha256 && init.agent?.pid === agent?.pid && init.agent?.ticks === agent?.ticks &&
      sameProgram(launch.identity, launch.program)
  } catch { return false }
}

/** The synthetic relay stand-in: the same tool names, answering locally and touching nothing. */
function serveSyntheticTools(names) {
  createInterface({ input: process.stdin }).on('line', line => {
    let message
    try { message = JSON.parse(line) } catch { return }
    if (message.id === undefined) return
    let result
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'bmn-qa-fence', version: '1' } }
    else if (message.method === 'tools/list') result = { tools: names.map(name => ({ name, description: `fence ${name}`, inputSchema: { type: 'object', properties: {}, additionalProperties: true } })) }
    else if (message.method === 'tools/call') result = { content: [{ type: 'text', text: `QA-FENCE-MCP-OK ${message.params.name}` }] }
    else if (message.method === 'ping') result = {}
    else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); return }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }) + '\n')
  })
}

function answer(response, blocks, stop, stream) {
  const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'qa-fence-stand-in', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
  if (!stream) { response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ...message, content: blocks, stop_reason: stop })); return }
  response.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const send = (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`)
  send('message_start', { message: { ...message, content: [], stop_reason: null } })
  blocks.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } })
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } })
    } else {
      send('content_block_start', { index, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } })
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } })
    }
    send('content_block_stop', { index })
  })
  send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 1 } })
  send('message_stop', {})
  response.end()
}

if (process.argv[1] && resolve(process.argv[1]) === here && process.argv[2] === '--mcp') serveSyntheticTools(JSON.parse(process.argv[3]))
