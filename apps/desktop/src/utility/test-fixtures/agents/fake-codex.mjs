#!/usr/bin/env node
// MODULE: fake-codex.mjs - a stand-in for the Codex app in the fence tests (63.3): it reads the folders a real Codex reads, offers tools, and talks to the provider its settings name
// Copied to a folder on the test's program path as `codex`. `codex-mode.json` beside it changes how
// it behaves, so one test can stand for a Codex version that adds a tool, runs hooks or writes.
// It behaves as Codex 0.162.1 did in the reference test: the rules file of its own folder always
// goes to the provider, skills and pictures do unless they are switched off, and a renewed sign-in
// is written through to the file a link points at.
import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
let mode = {}
try {
  mode = JSON.parse(readFileSync(join(here, 'codex-mode.json'), 'utf8'))
} catch {
  // No mode file: the plain stand-in.
}
const args = process.argv.slice(2)
if (args[0] === '--version') {
  console.log(`codex-cli ${mode.version ?? '0.161.0'}`)
  process.exit(0)
}
const home = process.env.HOME ?? ''
const codexHome = process.env.CODEX_HOME || join(home, '.codex')
const text = (path) => {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// `codex debug models`: the provider's model list, kept as fetched only when a provider answered.
if (args[0] === 'debug' && args[1] === 'models') {
  if (Array.isArray(mode.providerModels)) {
    writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ fetched_at: '2026-10-10T12:00:00Z', etag: 'x', models: mode.providerModels }))
    console.log(JSON.stringify({ models: mode.providerModels }))
  } else {
    console.log(JSON.stringify({ models: [] }))
  }
  process.exit(mode.listFails === true ? 1 : 0)
}
if (args[0] !== 'exec') process.exit(2)

const settings = []
const disabled = []
let model = 'unknown'
let answerFile = null
let strict = false
for (let index = 1; index < args.length; index += 1) {
  const argument = args[index]
  if (argument === '-c') settings.push(args[index += 1])
  else if (argument === '--disable') disabled.push(args[index += 1])
  else if (argument === '-m') model = args[index += 1]
  else if (argument === '-o') answerFile = args[index += 1]
  else if (argument === '--sandbox') index += 1
  else if (argument === '--strict-config') strict = true
}
const set = (key) => settings.find((entry) => entry.startsWith(`${key}=`))?.slice(key.length + 1)
const known = ['mcp_servers', 'web_search', 'features.shell_tool', 'features.unified_exec', 'features.multi_agent', 'features.apps', 'features.plugins', 'skills.include_instructions',
  'skills.bundled.enabled', 'include_apps_instructions', 'include_collaboration_mode_instructions', 'include_environment_context', 'project_doc_max_bytes', 'model_reasoning_effort',
  'model_context_window', 'model_auto_compact_token_limit'].filter((key) => !(mode.unknownSettings ?? []).includes(key))
const unknown = settings.map((entry) => entry.slice(0, entry.indexOf('='))).filter((key) => !known.includes(key))
if (strict && unknown.length > 0) {
  console.error(`error: unknown configuration field ${unknown[0]}`)
  process.exit(1)
}
const on = (feature) => !disabled.includes(feature)

const config = text(join(codexHome, 'config.toml')) ?? ''
const base = /^openai_base_url\s*=\s*"([^"]+)"/m.exec(config)?.[1]
if (base === undefined) {
  // No stand-in named: a real Codex would call its provider here. The fake has none and ends.
  console.error('no provider this stand-in can reach')
  process.exit(mode.silent === true ? 0 : 1)
}
if (mode.silent === true) {
  if (answerFile !== null) writeFileSync(answerFile, '{"version":1,"models":[]}')
  process.exit(0)
}

// A sign-in grown old is renewed, and the new one written where the old one was read.
const signIn = join(codexHome, 'auth.json')
const renewAt = process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE
const kept = text(signIn)
if (renewAt !== undefined && kept !== null && Date.now() - Date.parse(JSON.parse(kept).last_refresh) > 8 * 24 * 60 * 60 * 1000) {
  const renewed = await (await fetch(renewAt, { method: 'POST', body: '{}' })).json()
  const next = JSON.stringify({ ...JSON.parse(kept), tokens: { ...JSON.parse(kept).tokens, ...renewed }, last_refresh: new Date().toISOString() })
  if (mode.renewalReplacesLink === true) {
    writeFileSync(`${signIn}.tmp`, next)
    renameSync(`${signIn}.tmp`, signIn)
  } else {
    writeFileSync(signIn, next)
  }
}

// What goes to the provider besides the prompt.
const messages = []
const rules = text(join(codexHome, 'AGENTS.md'))
if (rules !== null) messages.push({ role: 'developer', text: rules })
if (set('skills.include_instructions') !== 'false') {
  for (const folder of [join(codexHome, 'skills'), join(home, '.agents/skills')]) {
    if (!existsSync(folder)) continue
    for (const name of readdirSync(folder)) messages.push({ role: 'developer', text: `<skill>${/^description: (.*)$/m.exec(text(join(folder, name, 'SKILL.md')) ?? '')?.[1] ?? name}</skill>` })
  }
}
// `always` stands for a version that runs the owner's hooks whatever the run switches off.
if (mode.runsHooks === 'always' || (on('hooks') && mode.runsHooks === true)) {
  const hooks = JSON.parse(text(join(mode.runsHooks === 'always' ? join(home, '.codex') : codexHome, 'hooks.json')) ?? '{"hooks":{}}').hooks
  for (const group of Object.values(hooks).flat()) {
    for (const hook of group.hooks) messages.push({ role: 'developer', text: execSync(hook.command, { encoding: 'utf8' }) })
  }
}
const prompt = readFileSync(0, 'utf8')
messages.push({ role: 'user', text: prompt })

// The provider's model list, where one answers: a model's entry there can name more tools.
let listed = []
try {
  const answer = await fetch(`${base}/models`)
  if (answer.ok) {
    const models = (await answer.json()).models
    writeFileSync(join(codexHome, 'models_cache.json'), JSON.stringify({ fetched_at: new Date().toISOString(), etag: 'x', models }))
    listed = models.find((entry) => entry.slug === model)?.experimental_supported_tools ?? []
  }
} catch {
  // No list: the one the app was built with.
}

const fn = (name) => ({ type: 'function', name, parameters: { type: 'object', properties: {} } })
const functions = [{ type: 'custom', name: 'exec' }, fn('wait'), fn('request_user_input'), fn('request_user_input_async'),
  ...(mode.extraTools ?? []).map(fn), ...listed.filter((name) => !['clock', 'send_user_message_async'].includes(name)).map(fn)]
const collaboration = ['followup_task', 'interrupt_agent', 'list_agents', 'send_message', 'spawn_agent', 'wait_agent'].map(fn)
const offered = [{ type: 'namespace', name: 'functions', tools: functions }, { type: 'namespace', name: 'collaboration', tools: collaboration },
  ...(on('sleep_tool') ? [{ type: 'namespace', name: 'clock', tools: [fn('sleep')] }] : [])]

/** A picture as the picture tool sends it; as in the real app, a file that is not a picture is refused. */
const pictureOf = (path) => {
  const bytes = readFileSync(path)
  if (bytes[0] !== 137 || bytes.subarray(1, 4).toString() !== 'PNG') throw new Error('unable to process image: not a supported picture')
  return `data:image/png;base64,${bytes.toString('base64')}`
}
const refused = 'patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings'
const patch = (input) => {
  if (mode.writes !== true) throw new Error(refused)
  writeFileSync(/^\*\*\* Add File: (.*)$/m.exec(input)[1], 'written\n')
  return 'Done'
}
/** The tools a script inside `exec` reaches. */
const inner = {
  apply_patch: async (input) => patch(input),
  clock__curr_time: async () => ({ current_time: '2026-10-10 12:00:00 UTC' }),
  list_mcp_resource_templates: async () => '{"resourceTemplates":[]}',
  list_mcp_resources: async () => '{"resources":[]}',
  read_mcp_resource: async ({ uri }) => {
    if (mode.resourceReadsFiles === true) return readFileSync(new URL(uri), 'utf8')
    throw new Error('resources/read failed: unknown MCP server \'codex\'')
  },
  web__run: async (input) => {
    const answer = await fetch(`${base}/alpha/search`, { method: 'POST', body: JSON.stringify(input) })
    if (!answer.ok) throw new Error(`Fatal error: http ${answer.status}`)
    return answer.json()
  },
  ...(on('view_image') ? { view_image: async ({ path }) => ({ image_url: pictureOf(path) }) } : {}),
  ...(on('goals') ? { create_goal: async () => ({ ok: true }), get_goal: async () => null, update_goal: async () => ({ ok: true }) } : {}),
  ...(on('image_generation') ? { image_gen__imagegen: async () => { throw new Error('no image service') } } : {})
}
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor

async function called(item) {
  if (item.type === 'custom_tool_call' && item.name === 'exec') {
    let printed = ''
    try {
      await new AsyncFunction('tools', 'text', item.input)(inner, (line) => { printed += line })
      return { type: 'custom_tool_call_output', call_id: item.call_id, output: [{ type: 'input_text', text: 'Script completed\nOutput:\n' }, { type: 'input_text', text: printed }] }
    } catch (error) {
      return { type: 'custom_tool_call_output', call_id: item.call_id, output: [{ type: 'input_text', text: `Script failed\n${String(error)}` }] }
    }
  }
  if (item.type === 'custom_tool_call') return { type: 'custom_tool_call_output', call_id: item.call_id, output: `unsupported call: ${item.name}` }
  if (item.type === 'local_shell_call') return { type: 'local_shell_call_output', call_id: item.call_id, output: 'unsupported call: local_shell' }
  const offeredHere = (item.namespace === undefined ? functions : item.namespace === 'collaboration' ? collaboration : item.namespace === 'clock' && on('sleep_tool') ? [fn('sleep')] : []).some((tool) => tool.name === item.name)
  let output = `unsupported call: ${item.name}`
  if (offeredHere && item.name === 'request_user_input') output = 'request_user_input is unavailable in Default mode'
  else if (offeredHere && item.name === 'list_agents') output = '{"agents":[{"agent_name":"/root","agent_status":"running"}]}'
  else if (offeredHere && (mode.extraTools ?? []).includes(item.name) && mode.extraToolReads !== undefined) output = readFileSync(join(home, mode.extraToolReads), 'utf8')
  else if (offeredHere) output = `${item.name}: nothing to do`
  // The real app's picture tool as a plain tool, where it is on and the model calls it by name.
  if (item.name === 'view_image' && on('view_image')) {
    try {
      output = [{ type: 'input_image', image_url: pictureOf(JSON.parse(item.arguments).path) }]
    } catch {
      output = 'unable to read the picture'
    }
  }
  return { type: 'function_call_output', call_id: item.call_id, output }
}

const input = [...messages.map((message) => ({ type: 'message', role: message.role, content: [{ type: 'input_text', text: message.text }] })), { type: 'additional_tools', tools: offered }]
for (let turn = 0; turn < 20; turn += 1) {
  const answer = await fetch(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, input }) })
  const events = (await answer.text()).split('\n').filter((line) => line.startsWith('data: ')).map((line) => JSON.parse(line.slice(6)))
  const items = events.filter((event) => event.type === 'response.output_item.done').map((event) => event.item)
  const said = items.find((item) => item.type === 'message')
  if (said !== undefined) {
    if (answerFile !== null) writeFileSync(answerFile, said.content[0].text)
    process.exit(0)
  }
  if (items.length === 0) process.exit(1)
  for (const item of items) input.push(await called(item))
}
process.exit(1)
