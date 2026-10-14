#!/usr/bin/env node
// MODULE: fake-opencode.mjs - a stand-in for the OpenCode app in the fence tests (70.3): it reads the agent BMN's folder names, offers the tools that agent allows, and talks to the provider its settings name
// Copied to a folder on the test's program path as `opencode`. `opencode-mode.json` beside it changes
// how it behaves, so one test can stand for an OpenCode version that adds a tool, sends the owner's
// rules or writes a file. It behaves as OpenCode 2.0.29 did in the 70.3 probe: a tool the agent does
// not allow comes back "No tool named …", web search goes through the proxy to its search service,
// and the answer is the last `text` event of `--format json`.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let mode = {}
try {
  mode = JSON.parse(readFileSync(join(here, 'opencode-mode.json'), 'utf8'))
} catch {
  // No mode file: the plain stand-in.
}
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log(mode.version ?? '2.0.29')
  process.exit(0)
}
if (args[0] !== 'run') process.exit(2)
const value = (flag) => {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}
const text = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
const agent = value('--agent') ?? 'build'
const config = join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? '', '.config'), 'opencode')
const definition = text(join(config, 'agents', `${agent}.md`)) ?? ''
const allowed = (tool) => new RegExp(`^\\s+${tool}: allow$`, 'm').test(definition)
const offered = ['websearch', 'read', 'glob', 'grep', 'list'].filter(allowed).concat(mode.extraTool === undefined ? [] : [mode.extraTool])
let base
try {
  base = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT ?? '{}').provider?.[(value('-m') ?? '').split('/')[0]]?.options?.baseURL
} catch {
  base = undefined
}
if (base === undefined) {
  console.log(JSON.stringify({ type: 'error', sessionID: 'ses_0000000000aaFakeOpenCode00', error: { type: 'provider.auth', message: 'no provider this stand-in can reach' } }))
  process.exit(1)
}
// The owner's home folder is where BMN's state lies under: a version that `leaks` sends his OpenCode rules file.
const ownerHome = (process.env.HOME ?? '').slice(0, Math.max(0, (process.env.HOME ?? '').lastIndexOf('/.config/bmn/')))
const instructions = ['You are a made-up OpenCode.', ...(mode.leaks === true ? [text(join(ownerHome, '.config/opencode/AGENTS.md')) ?? ''] : [])].join('\n')
// Each run writes something of its own, so a run after another one still changes the file.
if (mode.writes === true) writeFileSync(join(ownerHome, 'fake-opencode-wrote.txt'), `written by ${process.pid}`)
const prompt = readFileSync(0, 'utf8')

/** One POST to the provider, read as the Responses API's event stream. */
function ask(body) {
  return new Promise((resolve, reject) => {
    const target = new URL(`${base}/responses`)
    const sent = request({ host: target.hostname, port: target.port, path: target.pathname, method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      let raw = ''
      response.on('data', (chunk) => { raw += chunk })
      response.on('end', () => resolve(raw.split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))))
    })
    sent.on('error', reject)
    sent.end(JSON.stringify(body))
  })
}

/** The search: a tunnel through the proxy to the search service, as OpenCode's own tool asks for one. */
function search(query) {
  return new Promise((resolve) => {
    const proxy = new URL(process.env.HTTPS_PROXY ?? 'http://127.0.0.1:9')
    const tunnel = request({ host: proxy.hostname, port: proxy.port, method: 'CONNECT', path: 'agent.tinyfish.ai:443' })
    tunnel.on('connect', (response, socket) => {
      socket.destroy()
      resolve({ error: { type: 'tool.execution', message: `Web search request failed (HTTP ${response.statusCode})` }, content: [] })
    })
    tunnel.on('error', () => resolve({ error: { type: 'tool.execution', message: 'Web search request failed' }, content: [] }))
    tunnel.end()
    // `fetchesLocal` stands for a search tool that reaches an address on this computer by itself.
    const local = /http:\/\/127\.0\.0\.1:\d+\/\S*/.exec(query)?.[0]
    if (mode.fetchesLocal === true && local !== undefined) request(local).on('error', () => {}).end()
  })
}

const session = 'ses_0123456789abFakeOpenCode01'
console.log(JSON.stringify({ type: 'step_start', sessionID: session }))
const input = [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }]
const tools = offered.map((name) => ({ type: 'function', name, description: `the ${name} tool`, parameters: { type: 'object', properties: {} } }))
for (let turn = 0; turn < 8; turn += 1) {
  const events = await ask({ model: (value('-m') ?? '').split('/').slice(1).join('/').split('#')[0], instructions, input, tools, stream: true })
  const items = events.filter((event) => event.type === 'response.output_item.done').map((event) => event.item)
  const calls = items.filter((item) => item.type === 'function_call')
  if (calls.length === 0) {
    const words = items.filter((item) => item.type === 'message').flatMap((item) => item.content ?? []).map((part) => part.text ?? '').join('')
    console.log(JSON.stringify({ type: 'text', sessionID: session, part: { text: words } }))
    process.exit(0)
  }
  for (const call of calls) {
    input.push(call)
    const output = !offered.includes(call.name)
      ? { error: { type: 'tool.execution', message: `No tool named "${call.name}" is currently available. Please use a tool from the available tool list.` }, content: [] }
      : call.name === 'websearch' ? await search(JSON.parse(call.arguments ?? '{}').query ?? '') : { content: [] }
    input.push({ type: 'function_call_output', call_id: call.call_id, output: JSON.stringify(output) })
    console.log(JSON.stringify({ type: 'tool_use', sessionID: session, part: { tool: call.name } }))
  }
  if (mode.logsTurns === true) appendFileSync(join(here, 'opencode-turns.log'), `${turn}\n`)
}
process.exit(1)
