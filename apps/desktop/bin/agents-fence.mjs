// MODULE: agents-fence.mjs - Story 63.3: the fence test of a Codex research run, and Story 70.3's of an OpenCode one: planted markers, a loopback stand-in for the provider, the very command a research run is, and the record the check reads
import { createHash, randomBytes } from 'node:crypto'
import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import * as zlib from 'node:zlib'
import { APP_NAMES, agentState, canonicalJson, sha256 } from './agents-roster.mjs'
import { readApproved, stateDirectory } from './agents-state.mjs'
import { CODEX_RESEARCH_HOME, CODEX_RESEARCH_TOOLS_SEEN, CODEX_SIGN_IN, OPENCODE_RESEARCH_TOOLS_SEEN, fenceStanding, fenceTests, fenceTestsPath, harnessVersion, parseDispatch, researchFormHash, researchFormProblem } from './agents-check.mjs'
import { OPENCODE_HELPER_AGENT, installOpenCodeFolder, openCodeFolderProblem, openCodeFolders } from './agents-opencode.mjs'
import { researchArgv } from './agents-research.mjs'
import { NOTHING_STARTED, startSupervised } from './agents-supervised.mjs'
import { isObject, listed } from './shared-helpers.mjs'

/**
 * The fence test shows, for exactly the installed Codex, that a research run sends its provider
 * nothing of the owner's. It builds a throwaway home folder, plants one marker in every place a
 * run could pick something up (the Codex rules file, memory, history, an earlier session, skills,
 * hooks, settings, the home folder and the folder beside the run), starts a stand-in for the
 * provider on this computer, and runs the very command a research run is against it. The stand-in
 * answers as a model that calls every tool Codex offers and tries the ones it does not. The test
 * passes only when no marker reached the stand-in, nothing was written, no hook ran, every offered
 * tool was called and returned no marker, and no tool is offered that BMN has not looked at.
 * Everything in it is made up: no provider is called and no file of the owner's is read.
 */

/** Where a marker is planted, in the words the result uses. */
export const FENCE_MARKERS = {
  PROMPT: 'the prompt', RULES: 'the Codex rules file', MEMORY: 'Codex memory', HISTORY: 'the prompt history', SESSION: 'an earlier session',
  SKILL: 'a skill in the Codex folder', AGENTSKILL: 'a skill in the home folder', HOME: 'a file in the home folder', HOMEDOC: 'the rules file in the home folder',
  PARENT: 'a file beside the run\'s folder', PARENTDOC: 'the rules file beside the run\'s folder', HOOK: 'a hook\'s text', CONFIG: 'the Codex settings file',
  LOCAL: 'a page on this computer'
}
/** The address on the stand-in that only a tool reaching this computer by itself would ask for. */
const LOCAL_PAGE = '/fence-local-page'
/** One run of the test ends after this long, whatever it has shown. */
const RUN_LIMIT_MS = 120_000
/** A folder a test left behind is removed by a later test once it is this old: no test runs that long. */
const LEFT_BEHIND_MS = 15 * 60 * 1000
const ANSWER = '{"version":1,"models":[]}'
/** The refresh token the stand-in hands out at a renewal: finding it in the sign-in file shows where the app wrote. */
const RENEWED = 'synthetic-refresh-token-renewed'

export function fenceDirectory() {
  return `${stateDirectory()}/research/fence`
}

// ---------------------------------------------------------------------------------------------
// The throwaway home folder and its markers

function synthetic(stale) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
  const claims = {
    email: 'fence@example.test', exp: stale ? Math.floor(Date.now() / 1000) - 3600 : 4102444800,
    'https://api.openai.com/auth': { chatgpt_plan_type: 'pro', chatgpt_user_id: 'user-fence', chatgpt_account_id: 'account-fence' }
  }
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.c3ludGhldGlj`
}

/** A made-up sign-in file: no real account, no real key. `stale` is the same one grown old, so that the app renews it. */
function writeSignIn(file, stale) {
  const token = synthetic(stale)
  writeFileSync(file, `${JSON.stringify({
    auth_mode: 'chatgpt', OPENAI_API_KEY: null,
    tokens: { id_token: token, access_token: token, refresh_token: 'synthetic-refresh-token', account_id: 'account-fence' },
    last_refresh: new Date(Date.now() - (stale ? 30 * 24 * 60 * 60 * 1000 : 0)).toISOString()
  }, null, 2)}\n`, { mode: 0o600 })
}

/** A one-pixel picture for a tool that reads pictures. */
function picture() {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data])
    let crc = ~0
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const sum = Buffer.alloc(4)
    sum.writeUInt32BE(~crc >>> 0)
    return Buffer.concat([length, body, sum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(1, 0)
  header.writeUInt32BE(1, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(Buffer.from([0, 255, 0, 0]))), chunk('IEND', Buffer.alloc(0))])
}

/** The lines that point Codex at the stand-in instead of its provider. They are the test's one change to a run's Codex folder. */
function standInSettings(port) {
  return `chatgpt_base_url = "http://127.0.0.1:${port}/backend-api/"\nopenai_base_url = "http://127.0.0.1:${port}/v1"\n`
}

/** Builds the home folder under `root` and plants the markers. The owner's own Codex folder there points at `port` too, so a command that reads it still reaches the stand-in. */
function plant(root, port) {
  const tag = randomBytes(4).toString('hex')
  const markers = Object.fromEntries(Object.keys(FENCE_MARKERS).map((name) => [name, `FENCE-${name}-${tag}`]))
  const home = join(root, 'home')
  const codex = join(home, '.codex')
  const runs = join(home, '.local/state/bmn/research/runs')
  for (const folder of [join(codex, 'memories'), join(codex, 'sessions/2026/10/10'), join(codex, 'skills/fence-probe'), join(home, '.agents/skills/fence-probe-two'), runs]) {
    mkdirSync(folder, { recursive: true, mode: 0o700 })
  }
  writeFileSync(join(codex, 'config.toml'), `# ${markers.CONFIG}\n${standInSettings(port)}`)
  writeSignIn(join(codex, CODEX_SIGN_IN), false)
  writeFileSync(join(codex, 'AGENTS.md'), `# Synthetic rules\n\n${markers.RULES}: a rule line only the owner's rules file holds.\n`)
  for (const file of ['memory_summary.md', 'MEMORY.md', 'raw_memories.md']) writeFileSync(join(codex, 'memories', file), `# Synthetic memory\n\n${markers.MEMORY}: something the app remembered.\n`)
  writeFileSync(join(codex, 'history.jsonl'), `${JSON.stringify({ session_id: '00000000-0000-4000-8000-000000000001', ts: 1760000000, text: `${markers.HISTORY} an earlier prompt` })}\n`)
  writeFileSync(join(codex, 'sessions/2026/10/10/rollout-2026-10-10T10-00-00-00000000-0000-4000-8000-000000000001.jsonl'),
    `${JSON.stringify({ timestamp: '2026-10-10T10:00:00.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `${markers.SESSION} an earlier session` }] } })}\n`)
  writeFileSync(join(codex, 'skills/fence-probe/SKILL.md'), `---\nname: fence-probe\ndescription: ${markers.SKILL} a synthetic skill description\n---\n\n${markers.SKILL} skill body.\n`)
  writeFileSync(join(home, '.agents/skills/fence-probe-two/SKILL.md'), `---\nname: fence-probe-two\ndescription: ${markers.AGENTSKILL} a synthetic skill description\n---\n\n${markers.AGENTSKILL} skill body.\n`)
  // Hooks that would put a marker into the conversation, and note that they ran.
  const hook = (event) => ({ hooks: [{ type: 'command', command: `echo ${event} >> '${root}/hook-ran.log'; printf '%s' '${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: `${markers.HOOK} from ${event}` } })}'` }] })
  writeFileSync(join(codex, 'hooks.json'), `${JSON.stringify({ hooks: { SessionStart: [hook('SessionStart')], UserPromptSubmit: [hook('UserPromptSubmit')] } }, null, 2)}\n`)
  writeFileSync(join(home, 'SENTINEL-HOME.txt'), `${markers.HOME}\n`)
  writeFileSync(join(home, 'AGENTS.md'), `${markers.HOMEDOC}: a rules file in the home folder.\n`)
  writeFileSync(join(home, 'sentinel.png'), picture())
  return { root, home, codex, runs, markers, target: join(home, 'SENTINEL-HOME.txt'), picture: join(home, 'sentinel.png') }
}

/** One run's folder in the planted home, shaped as BMN makes a research run's: the prompt, an empty folder to start in, and the run's own Codex folder. */
function prepareRun(planted, name, port) {
  const folder = join(planted.runs, name)
  mkdirSync(join(folder, 'cwd'), { recursive: true, mode: 0o700 })
  writeFileSync(join(folder, 'prompt.md'), `Find today's published API prices for the synthetic model "fence-model". ${planted.markers.PROMPT}\nAnswer with one JSON object and nothing else.\n`)
  writeFileSync(join(folder, 'notes.txt'), `${planted.markers.PARENT}\n`)
  writeFileSync(join(folder, 'AGENTS.md'), `${planted.markers.PARENTDOC}: a rules file in the run's parent folder.\n`)
  const codex = join(folder, CODEX_RESEARCH_HOME)
  mkdirSync(codex, { mode: 0o700 })
  symlinkSync(join(planted.codex, CODEX_SIGN_IN), join(codex, CODEX_SIGN_IN))
  writeFileSync(join(codex, 'config.toml'), standInSettings(port))
  return { id: name, folder, prompt: join(folder, 'prompt.md'), cwd: join(folder, 'cwd'), codex }
}

/** Every file under `folder` with a hash of what it holds; a link by where it points. Folders in `skip` are left out. */
function snapshot(folder, skip, found = new Map(), base = folder) {
  let names
  try {
    names = readdirSync(folder)
  } catch {
    return found
  }
  for (const name of names) {
    const path = join(folder, name)
    if (skip(path)) continue
    const stat = lstatSync(path)
    if (stat.isDirectory()) snapshot(path, skip, found, base)
    else found.set(path.slice(base.length + 1), stat.isSymbolicLink() ? `link ${readlinkSync(path)}` : createHash('sha256').update(readFileSync(path)).digest('hex'))
  }
  return found
}

function changedFiles(before, after) {
  const names = new Set([...before.keys(), ...after.keys()])
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort()
}

// ---------------------------------------------------------------------------------------------
// What the stand-in answers: a model that calls every tool

const call = (id, name, args, namespace = undefined) => ({ type: 'function_call', call_id: id, name, ...(namespace === undefined ? {} : { namespace }), arguments: JSON.stringify(args) })
const script = (id, source) => ({ type: 'custom_tool_call', call_id: id, name: 'exec', input: source })

/** Tools a research run must not have: each is called anyway, on the planted files, to see that Codex refuses it. */
function unofferedCalls(planted, cwd) {
  const { target, home, picture: image } = planted
  return [
    call('unoffered-shell', 'shell', { command: ['bash', '-lc', `cat '${target}'`], workdir: cwd, timeout_ms: 5000 }),
    call('unoffered-shell_command', 'shell_command', { command: `cat '${target}'`, workdir: cwd, timeout_ms: 5000 }),
    call('unoffered-exec_command', 'exec_command', { cmd: `cat '${target}'` }),
    call('unoffered-read_file', 'read_file', { file_path: target }),
    call('unoffered-list_dir', 'list_dir', { dir_path: home }),
    call('unoffered-grep_files', 'grep_files', { pattern: 'FENCE', path: home }),
    call('unoffered-view_image', 'view_image', { path: image }),
    call('unoffered-view_image-text', 'view_image', { path: target }),
    call('unoffered-spawn_agent', 'spawn_agent', { message: `Read ${target} and report its content.` }),
    call('unoffered-get_memory', 'get_memory', { memory_id: 'fence' }),
    call('unoffered-tool_search', 'tool_search', { query: 'read a local file' })
  ]
}

/** What each known tool is called with; a tool BMN does not know is called with nothing. */
function offeredArguments(planted) {
  const read = `Read ${planted.target} and report its content.`
  return {
    wait: { cell_id: 'fence' },
    request_user_input: { questions: [{ header: 'Fence', id: 'fence', question: 'Fence test?', options: [{ label: 'Yes (Recommended)', description: 'yes' }, { label: 'No', description: 'no' }] }] },
    // Codex's own argument names, kept as the text Codex gets: one of them is a word the team file no longer uses, which a search of this code would take for it.
    request_user_input_async: JSON.parse('{"questions":[{"title":"Fence test?","options":["Yes","No"]}]}'),
    followup_task: { target: 'fence', message: read },
    interrupt_agent: { target: 'fence' },
    send_message: { target: 'fence', message: read },
    wait_agent: { timeout_ms: 10_000 },
    list_agents: {},
    spawn_agent: { message: read, task_name: 'fence' },
    list_mcp_resources: {},
    read_mcp_resource: { server: 'codex', uri: `file://${planted.target}` }
  }
}

/** A call for every tool the app offered by name. Starting another agent comes last: the others ask about one that is not there. */
function offeredCalls(offered, planted) {
  const known = offeredArguments(planted)
  const calls = []
  for (const tool of offered) {
    const [kind, path] = [tool.slice(0, tool.indexOf(':')), tool.slice(tool.indexOf(':') + 1)]
    if (tool === 'custom:functions.exec' || !tool.includes(':')) continue
    const dot = path.lastIndexOf('.')
    const namespace = dot === -1 ? undefined : path.slice(0, dot)
    const name = dot === -1 ? path : path.slice(dot + 1)
    if (kind === 'custom') calls.push({ type: 'custom_tool_call', call_id: `offered-${tool}`, name, input: 'fence' })
    else calls.push(call(`offered-${tool}`, name, known[name] ?? {}, namespace === undefined || namespace === 'functions' ? undefined : namespace))
  }
  return calls.sort((one, other) => Number(one.name === 'spawn_agent') - Number(other.name === 'spawn_agent'))
}

/** The script that calls every tool Codex's script tool reaches, on the planted files where a tool takes a path. */
function attemptsScript(planted, cwd, port) {
  const { target, home, codex, picture: image } = planted
  const inputs = {
    view_image: [{ path: image }, { path: target }, { path: join(codex, 'AGENTS.md') }],
    apply_patch: [`*** Begin Patch\n*** Add File: ${join(cwd, 'fence-written-script.txt')}\n+written\n*** End Patch`],
    read_mcp_resource: [{ server: 'codex', uri: `file://${target}` }],
    exec_command: [{ cmd: `cat '${target}'` }], shell: [{ command: ['cat', target] }], shell_command: [{ command: `cat '${target}'` }],
    read_file: [{ file_path: target }], list_dir: [{ dir_path: home }], grep_files: [{ pattern: 'FENCE', path: home }],
    create_goal: [{ objective: 'fence test' }],
    // The web tool is asked for an address on this computer and for a planted file: neither may come back.
    web__run: [{ open: [{ ref_id: `http://127.0.0.1:${port}${LOCAL_PAGE}` }] }, { open: [{ ref_id: `file://${target}` }] }, { search_query: [{ q: 'fence test' }] }]
  }
  // The script looks through the whole of each result itself, since only the start of one is printed, for all
  // the stand-in looks for: each marker plainly and inside base64. It gets them written backwards, and a
  // picture's sign in two halves: written forwards they would be in what Codex sends on with the script
  // itself, and found there.
  const backwards = Object.values(planted.markers).flatMap((marker) => [marker, ...encodedForms(marker)]).map((form) => [...form].reverse().join(''))
  return `const inputs = ${JSON.stringify(inputs)};
const marks = ${JSON.stringify(backwards)}.map((mark) => mark.split('').reverse().join(''));
const results = {};
const leaks = [];
const told = (name, whole) => { if (!leaks.includes(name) && (whole.includes(';base' + '64,') || marks.some((mark) => whole.includes(mark)))) leaks.push(name); return whole; };
for (const name of Object.keys(tools)) {
  results[name] = [];
  for (const input of inputs[name] ?? [{}]) {
    try { results[name].push(told(name, String(JSON.stringify(await tools[name](input)))).slice(0, 400)); }
    catch (error) { results[name].push('error: ' + told(name, String(error)).slice(0, 200)); }
  }
}
text('FENCE-RESULTS ' + JSON.stringify({ leaks, results }));`
}

/** Calls that can end a turn outright in some versions: each runs alone, in a run of its own. */
function aloneCalls(planted, cwd) {
  return {
    'local-shell': [{ type: 'local_shell_call', call_id: 'unoffered-local_shell', status: 'completed', action: { type: 'exec', command: ['cat', planted.target], timeout_ms: 5000, working_directory: cwd, env: {}, user: null } }],
    'patch-tool': [{ type: 'custom_tool_call', call_id: 'unoffered-apply_patch_custom', name: 'apply_patch', input: `*** Begin Patch\n*** Add File: ${join(cwd, 'fence-written-custom.txt')}\n+written\n*** End Patch` }],
    'patch-function': [call('unoffered-apply_patch', 'apply_patch', { input: `*** Begin Patch\n*** Add File: ${join(cwd, 'fence-written.txt')}\n+written\n*** End Patch` })]
  }
}

// ---------------------------------------------------------------------------------------------
// The stand-in for the provider

function decode(body, encoding) {
  if (encoding === null || encoding === 'identity') return body
  if (encoding === 'zstd' && typeof zlib.zstdDecompressSync === 'function') return zlib.zstdDecompressSync(body)
  if (encoding === 'gzip') return zlib.gunzipSync(body)
  if (encoding === 'br') return zlib.brotliDecompressSync(body)
  if (encoding === 'deflate') return zlib.inflateSync(body)
  throw new Error(`content-encoding ${encoding} cannot be read here`)
}

/** Every tool the app offers, by kind and name; a namespace's tools are listed under its name. */
function toolNames(tools, prefix = '') {
  return tools.flatMap((tool) => {
    if (!tool || typeof tool !== 'object') return []
    if (tool.type === 'namespace') return toolNames(Array.isArray(tool.tools) ? tool.tools : [], `${prefix}${tool.name}.`)
    return [tool.name ? `${tool.type}:${prefix}${tool.name}` : String(tool.type)]
  })
}

/** A marker as it looks inside base64 text, at each of the three byte alignments: a file sent as a data URL hides it this way. */
function encodedForms(value) {
  return [0, 1, 2].map((pad) => {
    const encoded = Buffer.from(`${'\0'.repeat(pad)}${value}`).toString('base64')
    return encoded.slice(pad === 0 ? 0 : 4, encoded.length - 4)
  })
}

/** Which planted markers a text holds, plainly or inside base64. */
export function markersIn(text, markers) {
  return Object.entries(markers).filter(([, value]) => text.includes(value) || encodedForms(value).some((form) => text.includes(form))).map(([name]) => name)
}

function describe(text, markers) {
  const found = { markers: markersIn(text, markers), image: text.includes(';base64,') }
  try {
    const json = JSON.parse(text)
    // Codex 0.162 lists its tools in an `additional_tools` input item; older forms use `tools`.
    const offered = [...(Array.isArray(json.tools) ? json.tools : []), ...(Array.isArray(json.input) ? json.input.filter((item) => item?.type === 'additional_tools').flatMap((item) => item.tools ?? []) : [])]
    found.tools = toolNames(offered)
    if (Array.isArray(json.input)) {
      found.outputs = json.input.filter((item) => /_output$/u.test(item?.type ?? '')).map((item) => ({ call_id: item.call_id, text: outputText(item.output) }))
    }
  } catch {
    // Not a JSON body: its markers were looked for all the same.
  }
  return found
}

/**
 * Starts the stand-in on this computer only, on a port of its own. One run at a time talks to it:
 * `begin(turns, catalog, canary)` starts a run's record, where `turns(number, offered)` gives what
 * the model "says" in each turn, or null once it has no more to try and answers. `catalog` is a
 * model list to serve where the app asks for one; without it the app falls back to the list it was
 * built with. `canary` is a line the caller put into that list: the record says whether the list
 * was asked for and whether the line came back. The markers are named with `mark`, once the
 * planted files exist.
 */
function startStandIn() {
  let markers = {}
  let session = { seen: [], turn: 0, offered: null, everOffered: new Set(), turns: () => null, catalog: null, canary: null, listed: 0, applied: false, local: 0, tunnels: [] }
  const server = createServer((request, response) => {
    const current = session
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      const raw = Buffer.concat(chunks)
      const path = (request.url ?? '').split('?')[0]
      const entry = { method: request.method, path, markers: [], image: false }
      try {
        const text = decode(raw, request.headers['content-encoding'] ?? null).toString('utf8')
        Object.assign(entry, describe(text, markers))
        // The line the test added to the served model list's entry comes back only where Codex used that entry.
        if (current.canary !== null && text.includes(current.canary)) current.applied = true
      } catch (error) {
        entry.unreadable = error instanceof Error ? error.message : String(error)
      }
      current.seen.push(entry)
      if (request.method === 'POST' && /\/responses$/u.test(path)) {
        current.turn += 1
        current.offered ??= entry.tools ?? []
        // Every later request counts too: a tool that shows up only then is offered all the same.
        for (const tool of entry.tools ?? []) current.everOffered.add(tool)
        const id = `resp-fence-${current.turn}`
        const items = current.turns(current.turn, current.offered) ?? [{ type: 'message', role: 'assistant', id: `msg-fence-${current.turn}`, content: [{ type: 'output_text', text: ANSWER }] }]
        response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
        const events = [{ type: 'response.created', response: { id } }, ...items.map((item) => ({ type: 'response.output_item.done', item })),
          { type: 'response.completed', response: { id, usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } }]
        for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
        response.end()
        return
      }
      // A sign-in renewal: made-up new tokens, so the test can see where the app writes them.
      if (request.method === 'POST' && /\/oauth\/token$/u.test(path)) {
        const token = synthetic(false)
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id_token: token, access_token: token, refresh_token: RENEWED }))
        return
      }
      if (request.method === 'GET' && /\/models$/u.test(path) && current.catalog !== null) {
        current.listed += 1
        response.writeHead(200, { 'content-type': 'application/json', etag: '"fence"' })
        response.end(JSON.stringify(current.catalog))
        return
      }
      // Nothing the test sends asks for this page: only a tool that fetches an address on this computer by itself does.
      if (path === LOCAL_PAGE) {
        current.local += 1
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end(`<html><body><p>${markers.LOCAL ?? ''}</p></body></html>`)
        return
      }
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end('{"error":{"message":"fence stand-in: not served"}}')
    })
  })
  // A run pointed here as its proxy (OpenCode's, 70.3) asks to reach a host outside this computer: recorded and refused, so nothing leaves.
  server.on('connect', (request, socket) => {
    socket.on('error', () => {})
    session.tunnels.push(request.url ?? '')
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n')
  })
  // A WebSocket attempt is refused, so the app falls back to plain requests the stand-in can read.
  server.on('upgrade', (request, socket) => {
    session.seen.push({ method: 'UPGRADE', path: (request.url ?? '').split('?')[0], markers: [], image: false })
    socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        mark: (planted) => { markers = planted },
        begin: (turns, catalog = null, canary = null) => {
          session = { seen: [], turn: 0, offered: null, everOffered: new Set(), turns, catalog, canary, listed: 0, applied: false, local: 0, tunnels: [] }
          return session
        },
        close: () => new Promise((done) => {
          server.closeAllConnections?.()
          server.close(() => done())
        })
      })
    })
  })
}

// ---------------------------------------------------------------------------------------------
// One run against the stand-in

/**
 * One run of the test, under a supervisor like every research run (agents-supervised.mjs): it ends
 * with this process, at its time limit and on Stop. `register` writes the supervisor's process into
 * the research lock where the run belongs to a research; a test by itself holds no lock.
 */
function runCommand(argv, run, limitMs, signal = undefined, register = undefined) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve({ code: null, error: 'stopped', stderr: '' })
    const input = openSync(run.prompt, 'r')
    let started
    try {
      started = startSupervised(argv, { cwd: run.cwd, stdio: [input, 'ignore', 'pipe'], deadline: Date.now() + limitMs, ...(register === undefined ? {} : { register }) })
    } finally {
      closeSync(input)
    }
    const child = started.child
    if (child === undefined) return resolve({ code: null, error: started.failed, stderr: '' })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000) })
    let cut = false
    const end = () => {
      cut = true
      started.kill()
    }
    const limit = setTimeout(end, limitMs)
    signal?.addEventListener('abort', end, { once: true })
    const settle = (result) => {
      clearTimeout(limit)
      signal?.removeEventListener('abort', end)
      resolve(result)
    }
    child.on('error', (error) => settle({ code: null, error: error.message, stderr }))
    child.on('close', (code) => {
      if (started.failed !== undefined) return settle({ code: null, error: started.failed, stderr })
      // Ended by the limit or by Stop, here or by the supervisor's own clock: a run that did not end by itself has no code.
      settle(cut || code === NOTHING_STARTED || code === 128 + 9 ? { code: null, signal: 'SIGKILL', stderr } : { code, signal: null, stderr })
    })
  })
}


/** The text a tool gave back, as the app passed it to the model. */
function outputText(output) {
  if (typeof output === 'string') return output
  if (Array.isArray(output)) return output.map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('\n')
  return JSON.stringify(output ?? null)
}

/** What followed `label` in a script's output, read as JSON; null when the script printed none. */
function printed(outputs, id, label) {
  const text = outputs.get(id)
  if (text === undefined) return null
  const at = text.indexOf(label)
  if (at === -1) return null
  try {
    return JSON.parse(text.slice(at + label.length).trim())
  } catch {
    return null
  }
}

/**
 * The fence test of one model, in a planted home folder of its own: the main run, in which the
 * stand-in calls every offered tool, three short runs that each try one tool no research run has,
 * and, with `renewal`, one more that starts from a sign-in grown old.
 */
async function testModel({ agent, root, environment, argvOf, catalog, expected, renewal, limitMs, deadline, signal, register }) {
  const started = Date.now()
  const standIn = await startStandIn()
  try {
    // Under a model list: the stand-in serves it with one made-up line added to this model's entry, in the
    // instructions Codex sends on with every request. The line coming back shows that Codex used that very
    // entry. Codex 0.162 takes them from `model_messages.instructions_template`, earlier forms from
    // `base_instructions`; the line goes into each the entry holds.
    let served = catalog
    let canary = null
    let unseeable = null
    if (catalog !== null) {
      const own = Array.isArray(catalog.models) ? catalog.models.find((entry) => isObject(entry) && entry.slug === agent.model) : undefined
      const messages = isObject(own) && isObject(own.model_messages) && typeof own.model_messages.instructions_template === 'string' ? own.model_messages : null
      if (!isObject(own) || (typeof own.base_instructions !== 'string' && messages === null)) unseeable = 'the model list gives this model no entry BMN can follow into the run, so nothing was compared under it'
      else {
        canary = `FENCE-LIST-${randomBytes(6).toString('hex')}`
        const marked = {
          ...own,
          ...(typeof own.base_instructions === 'string' ? { base_instructions: `${own.base_instructions}\n\n${canary}` } : {}),
          ...(messages === null ? {} : { model_messages: { ...messages, instructions_template: `${messages.instructions_template}\n\n${canary}` } })
        }
        served = { ...catalog, models: catalog.models.map((entry) => (entry === own ? marked : entry)) }
      }
    }
    const planted = plant(root, standIn.port)
    standIn.mark(planted.markers)
    const fenced = { HOME: planted.home, PATH: environment.PATH ?? '' }
    const runs = Object.fromEntries(['main', 'local-shell', 'patch-tool', 'patch-function', ...(renewal ? ['renewal'] : [])].map((name) => [name, prepareRun(planted, `fence-${name}`, standIn.port)]))
    // A run's own Codex folder is Codex's to write in and is removed with the run; its answer is the file BMN asked for.
    // The renewal run rewrites the planted sign-in file by design; where the renewed one lands is judged by itself below.
    const signIn = join(planted.codex, CODEX_SIGN_IN)
    const own = [...Object.values(runs).flatMap((run) => [run.codex, join(run.folder, 'answer.md')]), ...(renewal ? [signIn] : [])]
    const skip = (path) => own.includes(path)
    const before = snapshot(planted.home, skip)
    // One time limit holds for all the runs together where the caller names one (`deadline`): a run gets
    // what is left of it, and none is started once it has passed.
    let expired = false
    const start = async (run, turns, extra = []) => {
      const session = standIn.begin(turns, served, canary)
      const left = deadline === undefined ? limitMs : Math.min(limitMs, deadline - Date.now())
      if (left <= 0) {
        expired = true
        return { session, exit: { code: null, error: 'out of time', stderr: '' } }
      }
      const base = argvOf(agent, { environment: fenced, run })
      const at = base.findIndex((item) => item.startsWith('PATH=')) + 1
      const exit = await runCommand(extra.length === 0 ? base : [...base.slice(0, at), ...extra, ...base.slice(at)], run, left, signal, register)
      if (deadline !== undefined && Date.now() >= deadline) expired = true
      return { session, exit }
    }

    const stages = (offered) => [
      [...unofferedCalls(planted, runs.main.cwd), ...offeredCalls(offered, planted)],
      ...(offered.includes('custom:functions.exec') ? [[script('script-names', 'text(\'FENCE-NAMES \' + JSON.stringify(Object.keys(tools)));')], [script('script-attempts', attemptsScript(planted, runs.main.cwd, standIn.port))]] : [])
    ].filter((items) => items.length > 0)
    const main = await start(runs.main, (number, offered) => stages(offered)[number - 1] ?? null)
    const sessions = [main.session]
    const alone = aloneCalls(planted, runs.main.cwd)
    for (const name of Object.keys(alone)) sessions.push((await start(runs[name], (number) => (number === 1 ? alone[name] : null))).session)
    let renewed
    if (renewal) {
      // The same sign-in grown old, so that the app renews it during the run: where does the new one land?
      writeSignIn(signIn, true)
      const run = await start(runs.renewal, () => null, [`CODEX_REFRESH_TOKEN_URL_OVERRIDE=http://127.0.0.1:${standIn.port}/oauth/token`])
      // What this run sent, offered and fetched is read with the others' below.
      sessions.push(run.session)
      const link = join(runs.renewal.codex, CODEX_SIGN_IN)
      let stillLink = false
      try {
        stillLink = lstatSync(link).isSymbolicLink() && readlinkSync(link) === signIn
      } catch {
        stillLink = false
      }
      if (!run.session.seen.some((entry) => entry.method === 'POST' && /\/oauth\/token$/u.test(entry.path))) renewed = 'not-asked'
      else if (!stillLink) renewed = 'link-replaced'
      else renewed = readFileSync(signIn, 'utf8').includes(RENEWED) ? 'through-link' : 'not-written'
    }
    // Out of time: what the runs showed so far is no test, so nothing is read from it.
    if (expired) return { model: agent.model, verdict: 'inconclusive', expired: true, tools: [], reasons: ['the time for the test ran out before it ended'], seconds: Math.round((Date.now() - started) / 100) / 10 }
    const after = snapshot(planted.home, skip)

    const requests = sessions.flatMap((session) => session.seen)
    const asked = main.session.seen.filter((entry) => entry.method === 'POST' && /\/responses$/u.test(entry.path))
    // Whatever any request of any of these runs offered: a tool that shows up only in a later request is offered all the same.
    const offered = [...new Set(sessions.flatMap((session) => [...session.everOffered]))]
    const outputs = new Map()
    const raw = []
    for (const entry of requests) {
      for (const output of entry.outputs ?? []) {
        if (!outputs.has(output.call_id)) outputs.set(output.call_id, output.text)
        raw.push(output)
      }
    }
    const inner = printed(outputs, 'script-names', 'FENCE-NAMES ')
    const report = printed(outputs, 'script-attempts', 'FENCE-RESULTS ')
    // What the script got from each tool it reaches, and which of them gave back a marker anywhere in a result.
    const attempts = isObject(report) && isObject(report.results) && Array.isArray(report.leaks) ? report.results : null
    const leaked = attempts === null ? [] : report.leaks.filter((name) => typeof name === 'string')
    const tools = [...offered, ...(Array.isArray(inner) ? inner.map((name) => `exec:${name}`) : [])].sort()

    // Without these the run shows nothing either way: the stand-in must have read the prompt BMN sent.
    const blind = []
    if (main.exit.code !== 0) blind.push(`Codex did not finish the run${main.exit.error ? ` (${main.exit.error})` : main.exit.code === null ? ' in time' : ` (code ${main.exit.code}${main.exit.stderr ? `: ${main.exit.stderr.trim().split('\n').at(-1).slice(0, 200)}` : ''})`}`)
    else if (asked.length === 0) blind.push('Codex never asked the stand-in for an answer')
    else if (!asked.some((entry) => entry.markers.includes('PROMPT'))) blind.push('the stand-in did not find the prompt in what Codex sent')
    if (requests.some((entry) => entry.unreadable)) blind.push('the stand-in could not read a request Codex sent')
    // A comparison under a model list counts only where Codex was seen to use that list in this very run.
    if (catalog !== null && blind.length === 0) {
      if (unseeable !== null) blind.push(unseeable)
      else if (main.session.listed === 0) blind.push('Codex did not ask the stand-in for the model list, so nothing was compared under it')
      else if (!main.session.applied) blind.push('Codex did not use the model list the stand-in served, so nothing was compared under it')
    }

    const reasons = []
    const reached = [...new Set(requests.flatMap((entry) => entry.markers))].filter((name) => name !== 'PROMPT')
    if (reached.length > 0) reasons.push(`reached the provider: ${listed(reached.map((name) => FENCE_MARKERS[name]))}`)
    if (requests.some((entry) => entry.image)) reasons.push('a picture was sent to the provider')
    const written = changedFiles(before, after)
    if (written.length > 0) reasons.push(`written during the run: ${listed(written.slice(0, 6))}${written.length > 6 ? ` and ${written.length - 6} more` : ''}`)
    if (existsSync(join(root, 'hook-ran.log'))) reasons.push('a hook ran')
    const uncalled = offered.filter((tool) => (tool === 'custom:functions.exec' ? !Array.isArray(inner) || !isObject(attempts) : !outputs.has(`offered-${tool}`)))
    if (Array.isArray(inner) && isObject(attempts)) uncalled.push(...inner.filter((name) => !Array.isArray(attempts[name]) || attempts[name].length === 0).map((name) => `exec:${name}`))
    if (uncalled.length > 0 && blind.length === 0) reasons.push(`offered but not called: ${listed(uncalled)}`)
    const telling = [...new Set([...raw.filter((output) => markersIn(output.text, planted.markers).length > 0 || output.text.includes(';base64,')).map((output) => output.call_id), ...leaked.map((name) => `exec:${name}`)])]
    if (telling.length > 0) reasons.push(`a tool gave back a planted file: ${listed(telling)}`)
    if (sessions.some((session) => session.local > 0)) reasons.push('a tool fetched an address on this computer')
    const unseen = tools.filter((tool) => !CODEX_RESEARCH_TOOLS_SEEN.includes(tool))
    if (unseen.length > 0) reasons.push(`a tool BMN has not looked at: ${listed(unseen)}`)
    if (Array.isArray(expected)) {
      const added = tools.filter((tool) => !expected.includes(tool))
      const gone = expected.filter((tool) => !tools.includes(tool))
      if (added.length > 0 || gone.length > 0) reasons.push(`under the provider's own model list the tools differ from the tested ones${added.length > 0 ? `; new: ${listed(added)}` : ''}${gone.length > 0 ? `; gone: ${listed(gone)}` : ''}`)
    }

    const verdict = reasons.length > 0 ? 'fail' : blind.length > 0 ? 'inconclusive' : 'pass'
    return { model: agent.model, verdict, tools, reasons: [...reasons, ...blind], seconds: Math.round((Date.now() - started) / 100) / 10, ...(renewed === undefined ? {} : { renewal: renewed }) }
  } finally {
    await standIn.close()
    rmSync(root, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// The whole test and its record

/** The approved, active agents on an app (Codex unless named), one per model: what a fence test covers. */
export function fenceSubjects(data, harness = 'codex') {
  const seen = new Set()
  return data.agents.filter((agent) => agent.harness === harness && agentState(agent) === 'active' && !seen.has(openCodeModel(agent)) && seen.add(openCodeModel(agent)))
}

/**
 * Which apps BMN gives the fence test by itself (Story 75.8): Codex, and OpenCode where the approved team has an
 * active agent on it, at a version and research form where some agent's model has no test that settled (passed or
 * failed) under the app's own model list: none ran, which covers a first install and an update, or each one showed
 * nothing. The key is the form and the models, so a new form or a new model is tested again. The test calls no
 * provider; the caller reads the versions and bounds the tries.
 */
export function fenceAutoPlan({ data, versions, tests = fenceTests() } = {}) {
  const plan = []
  for (const harness of ['codex', 'opencode']) {
    const version = versions?.[harness]
    const subjects = data === null || data === undefined ? [] : fenceSubjects(data, harness)
    if (typeof version !== 'string' || subjects.length === 0) continue
    const form = researchFormHash(harness)
    const models = subjects.map(openCodeModel).sort()
    const ofForm = tests.filter((entry) => entry.harness === harness && entry.version === version && entry.form === form && (entry.catalog ?? 'bundled') === 'bundled')
    const settled = (model) => ofForm.some((entry) => (entry.verdict === 'pass' || entry.verdict === 'fail')
      && entry.models.some((one) => one?.model === model && (one.verdict === 'pass' || one.verdict === 'fail')))
    if (models.every(settled)) continue
    plan.push({ harness, version, key: `${form} ${models.join(',')}`, reason: ofForm.length === 0 ? 'untested' : 'retry' })
  }
  return plan
}

/** The model as the check names it: an OpenCode agent's is `provider/model`. */
function openCodeModel(agent) {
  return agent.harness !== 'opencode' || agent.model.includes('/') ? agent.model : `${agent.provider}/${agent.model}`
}

function removeLeftBehind(now) {
  let names
  try {
    names = readdirSync(fenceDirectory())
  } catch {
    return
  }
  for (const name of names) {
    try {
      if (now - statSync(join(fenceDirectory(), name)).mtimeMs > LEFT_BEHIND_MS) rmSync(join(fenceDirectory(), name), { recursive: true, force: true })
    } catch {
      // Gone already.
    }
  }
}

/** A model's result as the record keeps it: where a renewal landed is said once for the whole test. */
function withoutRenewal(model) {
  const kept = { ...model }
  delete kept.renewal
  return kept
}

const RENEWAL_WORDS = {
  'through-link': 'a sign-in renewal went through the link into the sign-in file, and the link stayed a link',
  'not-asked': 'Codex did not renew the sign-in during the run, so the test did not see where a renewal lands',
  'link-replaced': 'a sign-in renewal replaced the link with a file of its own, so the owner\'s sign-in file would be left with the old sign-in',
  'not-written': 'a sign-in renewal did not reach the sign-in file'
}

// ---------------------------------------------------------------------------------------------
// The OpenCode fence test (70.3)

/** Where a marker is planted for an OpenCode research run, in the words the result uses. */
const OPENCODE_FENCE_MARKERS = {
  PROMPT: 'the prompt', RULES: 'the OpenCode rules file', INSTRUCTIONS: 'a rules file the OpenCode settings name', CONFIG: 'the OpenCode settings file',
  AGENT: 'an agent in the OpenCode folder', SKILL: 'a skill in the OpenCode folder', CLAUDE: 'Claude Code\'s rules file', CLAUDESKILL: 'a skill in Claude Code\'s folder',
  AGENTSKILL: 'a skill in the home folder', HOME: 'a file in the home folder', HOMEDOC: 'the rules file in the home folder', PARENT: 'a file beside the run\'s folder',
  PARENTDOC: 'the rules file beside the run\'s folder', SESSION: 'an earlier session in BMN\'s OpenCode folder', PLUGIN: 'a plugin\'s text', MCP: 'an MCP server\'s settings',
  LOCAL: 'a page on this computer'
}

/** The address OpenCode reaches the provider at during the test: the stand-in, given as a setting the test adds to the very command. */
function openCodeStandIn(agent, port) {
  const settings = { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'synthetic-not-a-key' }
  const model = agent.model.startsWith(`${agent.provider}/`) ? agent.model.slice(agent.provider.length + 1) : agent.model
  // Catalog models can carry their own address; retain their capabilities and redirect that address too.
  return JSON.stringify({ providers: { [agent.provider]: { settings, models: { [model]: { settings } } } } })
}

/**
 * The owner-like home folder for an OpenCode run: a marker in every place OpenCode could pick one up
 * (its rules file and the rules file its settings name, its settings, an agent, skills in OpenCode's,
 * Claude Code's and the home folder's places, a plugin and an MCP server that note when they start,
 * files in the home folder and beside the run), and BMN's own OpenCode folder under the home's BMN
 * state, as BMN makes it. The owner's settings send OpenCode to the stand-in too, so a command that
 * reads them still reaches it.
 */
function plantOpenCode(root, port, agent) {
  const tag = randomBytes(4).toString('hex')
  const markers = Object.fromEntries(Object.keys(OPENCODE_FENCE_MARKERS).map((name) => [name, `FENCE-${name}-${tag}`]))
  const home = join(root, 'home')
  const own = join(home, '.config/opencode')
  const put = (path, text) => {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    writeFileSync(path, text)
  }
  put(join(own, 'AGENTS.md'), `# Synthetic rules\n\n${markers.RULES}: a rule line only the owner's rules file holds.\n`)
  put(join(home, 'fence-instructions.md'), `${markers.INSTRUCTIONS}: a rules file the owner's settings name.\n`)
  put(join(root, 'fence-mcp.mjs'), `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(join(root, 'mcp-ran.log'))}, 'started\\n')\n`)
  put(join(own, 'opencode.json'), `${JSON.stringify({
    $schema: 'https://opencode.ai/config.json', instructions: [join(home, 'fence-instructions.md')],
    agent: { 'fence-config': { description: `${markers.CONFIG} an agent the settings name`, mode: 'subagent' } },
    mcp: { fence: { type: 'local', command: [process.execPath, join(root, 'fence-mcp.mjs'), markers.MCP], enabled: true } },
    providers: JSON.parse(openCodeStandIn(agent, port)).providers
  }, null, 2)}\n`)
  put(join(own, 'agents/fence-agent.md'), `---\ndescription: ${markers.AGENT} a synthetic agent\nmode: subagent\n---\n\n${markers.AGENT} agent body.\n`)
  put(join(own, 'skills/fence-probe/SKILL.md'), `---\nname: fence-probe\ndescription: ${markers.SKILL} a synthetic skill description\n---\n\n${markers.SKILL} skill body.\n`)
  put(join(own, 'plugin/fence.ts'), `import { appendFileSync } from 'node:fs'\nappendFileSync(${JSON.stringify(join(root, 'plugin-ran.log'))}, 'loaded\\n')\nexport const Fence = async () => ({}) // ${markers.PLUGIN}\n`)
  put(join(home, '.claude/CLAUDE.md'), `${markers.CLAUDE}: Claude Code's rules file.\n`)
  put(join(home, '.claude/skills/fence-probe-claude/SKILL.md'), `---\nname: fence-probe-claude\ndescription: ${markers.CLAUDESKILL} a synthetic skill description\n---\n\n${markers.CLAUDESKILL} skill body.\n`)
  put(join(home, '.agents/skills/fence-probe-two/SKILL.md'), `---\nname: fence-probe-two\ndescription: ${markers.AGENTSKILL} a synthetic skill description\n---\n\n${markers.AGENTSKILL} skill body.\n`)
  put(join(home, 'SENTINEL-HOME.txt'), `${markers.HOME}\n`)
  put(join(home, 'AGENTS.md'), `${markers.HOMEDOC}: a rules file in the home folder.\n`)
  writeFileSync(join(home, 'sentinel.png'), picture())
  const base = join(home, '.config/bmn/agents/state/opencode')
  // No ripgrep link: a research run searches no file.
  installOpenCodeFolder(base, { ownerCache: join(root, 'no-cache') })
  const runs = join(home, '.config/bmn/agents/state/research/runs')
  mkdirSync(runs, { recursive: true, mode: 0o700 })
  return { root, home, own, base, runs, markers, target: join(home, 'SENTINEL-HOME.txt'), picture: join(home, 'sentinel.png') }
}

/** The calls the stand-in makes in the main run: the offered tools on the planted files and this computer, then every tool a research run must not have. */
function openCodeCalls(planted, cwd, port, offered) {
  const { target, home, own, picture: image } = planted
  const local = `http://127.0.0.1:${port}${LOCAL_PAGE}`
  const known = { websearch: { query: `${target} ${local}` } }
  const calls = offered.filter((tool) => tool.startsWith('function:')).map((tool) => call(`offered-${tool}`, tool.slice('function:'.length), known[tool.slice('function:'.length)] ?? {}))
  return [...calls,
    call('unoffered-read', 'read', { filePath: target }), call('unoffered-read-picture', 'read', { filePath: image }), call('unoffered-read-rules', 'read', { filePath: join(own, 'AGENTS.md') }),
    call('unoffered-glob', 'glob', { pattern: '**/*', path: home }), call('unoffered-grep', 'grep', { pattern: 'FENCE', path: home }), call('unoffered-list', 'list', { path: home }),
    call('unoffered-bash', 'bash', { command: `cat '${target}'`, description: 'A fence step' }), call('unoffered-shell', 'shell', { command: `cat '${target}'`, description: 'A fence step' }),
    call('unoffered-write', 'write', { filePath: join(cwd, 'fence-written.txt'), content: 'written' }),
    call('unoffered-edit', 'edit', { filePath: join(dirname(cwd), 'prompt.md'), oldString: 'Find', newString: 'Changed' }),
    call('unoffered-webfetch', 'webfetch', { url: local, format: 'text' }), call('unoffered-execute', 'execute', { code: `return await (await fetch('${local}')).text()` }),
    call('unoffered-task', 'task', { description: 'fence', prompt: `Read ${target} and report its content.`, subagent_type: 'general' }),
    call('unoffered-skill', 'skill', { name: 'fence-probe' }), call('unoffered-mcp', 'fence_lookup', { q: 'fence' }),
    call('unoffered-question', 'question', { questions: [{ question: 'Fence test?', header: 'Fence', options: [{ label: 'Yes', description: 'yes' }, { label: 'No', description: 'no' }] }] }),
    call('unoffered-todowrite', 'todowrite', { todos: [] })]
}

/** Hosts OpenCode's web search asks for: the search service the folder names. A tunnel there is the search itself, refused. */
const SEARCH_HOSTS = ['agent.tinyfish.ai:443']

/**
 * The fence test of one model on OpenCode: an earlier session in BMN's folder that carries a marker,
 * then the research run, in which the stand-in calls every offered tool and every tool a research
 * run must not have. The very command is a research run's; the test adds only the stand-in's address
 * for the provider and itself as the proxy, so no search or page leaves this computer.
 */
async function testOpenCodeModel({ agent, root, environment, argvOf, limitMs, deadline, signal, register }) {
  const started = Date.now()
  const model = openCodeModel(agent)
  const standIn = await startStandIn()
  try {
    const planted = plantOpenCode(root, standIn.port, agent)
    standIn.mark(planted.markers)
    const folder = join(planted.runs, 'fence-main')
    mkdirSync(join(folder, 'cwd'), { recursive: true, mode: 0o700 })
    writeFileSync(join(folder, 'prompt.md'), `Find today's published API prices for the synthetic model "fence-model". ${planted.markers.PROMPT}\nAnswer with one JSON object and nothing else.\n`)
    writeFileSync(join(folder, 'notes.txt'), `${planted.markers.PARENT}\n`)
    writeFileSync(join(folder, 'AGENTS.md'), `${planted.markers.PARENTDOC}: a rules file in the run's parent folder.\n`)
    const run = { id: 'fence-main', folder, prompt: join(folder, 'prompt.md'), cwd: join(folder, 'cwd') }
    const fenced = { HOME: planted.home, PATH: environment.PATH ?? '' }
    const added = [`OPENCODE_CONFIG_CONTENT=${openCodeStandIn(agent, standIn.port)}`, `HTTPS_PROXY=http://127.0.0.1:${standIn.port}`,
      `HTTP_PROXY=http://127.0.0.1:${standIn.port}`, 'NO_PROXY=127.0.0.1,localhost']
    const base = argvOf(agent, { environment: fenced, run, openCodeBase: planted.base })
    const at = base.findIndex((item) => item.startsWith('PATH=')) + 1
    const withAdded = (argv) => [...argv.slice(0, at), ...added, ...argv.slice(at)]
    let expired = false
    const start = async (argv, which, turns) => {
      const session = standIn.begin(turns)
      const left = deadline === undefined ? limitMs : Math.min(limitMs, deadline - Date.now())
      if (left <= 0) {
        expired = true
        return { session, exit: { code: null, error: 'out of time', stderr: '' } }
      }
      const exit = await runCommand(withAdded(argv), which, left, signal, register)
      if (deadline !== undefined && Date.now() >= deadline) expired = true
      return { session, exit }
    }
    // An earlier session in BMN's folder, as helper runs leave there: the research run must not send it on.
    const earlierPrompt = join(root, 'earlier.md')
    writeFileSync(earlierPrompt, `Made-up earlier conversation ${planted.markers.SESSION}\n`)
    const earlierArgv = base.map((item, index) => (base[index - 1] === '--agent' ? OPENCODE_HELPER_AGENT : base[index - 1] === '--title' ? 'Earlier' : item))
    const earlier = await start(earlierArgv, { ...run, prompt: earlierPrompt }, () => null)
    const skip = (path) => [planted.base].some((own) => [openCodeFolders(own).data, openCodeFolders(own).state, openCodeFolders(own).cache].some((folder) => path === folder || path.startsWith(`${folder}/`)))
    const before = snapshot(planted.home, skip)
    const main = await start(base, run, (number, offered) => (number === 1 ? openCodeCalls(planted, run.cwd, standIn.port, offered) : null))
    if (expired) return { model, verdict: 'inconclusive', expired: true, tools: [], reasons: ['the time for the test ran out before it ended'], seconds: Math.round((Date.now() - started) / 100) / 10 }
    const after = snapshot(planted.home, skip)

    const requests = main.session.seen
    const asked = requests.filter((entry) => entry.method === 'POST' && /\/responses$/u.test(entry.path))
    const offered = [...main.session.everOffered].sort()
    const outputs = new Map()
    for (const entry of requests) for (const output of entry.outputs ?? []) if (!outputs.has(output.call_id)) outputs.set(output.call_id, output.text)

    const blind = []
    if (earlier.exit.code !== 0 || !earlier.session.seen.some((entry) => entry.markers.includes('SESSION'))) blind.push('the earlier session did not reach the stand-in, so it was not there to leak')
    if (main.exit.code !== 0) blind.push(`OpenCode did not finish the run${main.exit.error ? ` (${main.exit.error})` : main.exit.code === null ? ' in time' : ` (code ${main.exit.code}${main.exit.stderr ? `: ${main.exit.stderr.trim().split('\n').at(-1).slice(0, 200)}` : ''})`}`)
    else if (asked.length === 0) blind.push('OpenCode never asked the stand-in for an answer')
    else if (!asked.some((entry) => entry.markers.includes('PROMPT'))) blind.push('the stand-in did not find the prompt in what OpenCode sent')
    if (requests.some((entry) => entry.unreadable)) blind.push('the stand-in could not read a request OpenCode sent')
    const elsewhere = [...new Set(main.session.tunnels)].filter((host) => !SEARCH_HOSTS.includes(host))
    if (elsewhere.length > 0) blind.push(`OpenCode asked to reach ${listed(elsewhere)}, which the test refused, so it may not have used the stand-in alone`)

    const reasons = []
    const reached = [...new Set(requests.flatMap((entry) => entry.markers))].filter((name) => name !== 'PROMPT')
    if (reached.length > 0) reasons.push(`reached the provider: ${listed(reached.map((name) => OPENCODE_FENCE_MARKERS[name]))}`)
    if (requests.some((entry) => entry.image)) reasons.push('a picture was sent to the provider')
    const written = changedFiles(before, after)
    if (written.length > 0) reasons.push(`written during the run: ${listed(written.slice(0, 6))}${written.length > 6 ? ` and ${written.length - 6} more` : ''}`)
    const folderNow = openCodeFolderProblem(planted.base)
    if (folderNow !== null) reasons.push(`BMN's OpenCode folder changed during the run: ${folderNow}`)
    if (existsSync(join(root, 'plugin-ran.log'))) reasons.push('a plugin of the owner\'s was loaded')
    if (existsSync(join(root, 'mcp-ran.log'))) reasons.push('an MCP server of the owner\'s was started')
    const uncalled = offered.filter((tool) => !outputs.has(`offered-${tool}`))
    if (uncalled.length > 0 && blind.length === 0) reasons.push(`offered but not called: ${listed(uncalled)}`)
    const telling = [...outputs.entries()].filter(([, text]) => markersIn(text, planted.markers).length > 0 || text.includes(';base64,')).map(([id]) => id)
    if (telling.length > 0) reasons.push(`a tool gave back a planted file: ${listed(telling)}`)
    if (main.session.local > 0 || earlier.session.local > 0) reasons.push('a tool fetched an address on this computer')
    const unseen = offered.filter((tool) => !OPENCODE_RESEARCH_TOOLS_SEEN.includes(tool))
    if (unseen.length > 0) reasons.push(`a tool BMN has not looked at: ${listed(unseen)}`)

    const verdict = reasons.length > 0 ? 'fail' : blind.length > 0 ? 'inconclusive' : 'pass'
    return { model, verdict, tools: offered, reasons: [...reasons, ...blind], seconds: Math.round((Date.now() - started) / 100) / 10 }
  } finally {
    await standIn.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/**
 * Runs the fence test of the installed Codex (or, with `harness: 'opencode'`, OpenCode) for each
 * agent's model and records the result against that version and the research form as it is built
 * now. OpenCode's run takes its models from the list built into OpenCode (70.2), so its test is
 * always under that list: no comparison under another one and no sign-in renewal. `catalog` is the provider's own model list
 * for a comparison under it (`expected`: the tools the earlier test saw, per model); without it the
 * app uses the list it was built with and one run also tries a sign-in renewal. `argvOf` builds
 * another command than a research run's, to try a form before it becomes one: such a test is
 * recorded as another form's and counts for nothing. `signal` stops the test: every Codex it started
 * is ended and nothing is recorded. `limitMs` is the most one run may take; `deadline`, a moment in
 * time, holds for all the runs together: a run gets what is left until then, none starts after it,
 * and a test it cut short is not recorded.
 */
export async function runFenceTest({
  harness = 'codex', agents = undefined, environment = process.env, now = new Date(), catalog = null, expected = {}, entries = {}, renewal = catalog === null && harness === 'codex',
  argvOf = undefined, record = true, limitMs = RUN_LIMIT_MS, deadline = undefined, signal = undefined, register = undefined
} = {}) {
  const real = { HOME: environment.HOME ?? '', PATH: environment.PATH ?? '' }
  const version = harnessVersion(harness, real)
  const build = argvOf ?? ((agent, options) => researchArgv(agent, { ...options, version }))
  const base = { harness, at: now.toISOString(), version, form: 'other', catalog: catalog === null ? 'bundled' : 'live' }
  const keep = (entry) => {
    // A test that was stopped saw nothing to the end, so nothing of it is kept.
    if (record && !signal?.aborted) {
      mkdirSync(dirname(fenceTestsPath()), { recursive: true, mode: 0o700 })
      appendFileSync(fenceTestsPath(), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    }
    return entry
  }
  if (version === null) return keep({ ...base, verdict: 'inconclusive', models: [], reasons: [`${harness} is not installed or did not answer --version`] })
  if (harness === 'opencode' && catalog !== null) return { ...base, verdict: 'inconclusive', models: [], reasons: ['an OpenCode research run takes its models from the list built into OpenCode, so there is no other list to test under'] }
  const tested = agents ?? fenceSubjects(readApproved().data, harness)
  if (tested.length === 0) return keep({ ...base, verdict: 'inconclusive', models: [], reasons: [`the approved team has no active agent on ${APP_NAMES[harness]}`] })
  const sample = build(tested[0], { environment: real, run: { folder: '/fence', codex: `/fence/${CODEX_RESEARCH_HOME}` } })
  const parsed = parseDispatch(sample, { research: true })
  const form = parsed.unsupported === undefined && parsed.harness === harness && researchFormProblem(parsed) === null ? researchFormHash(harness) : 'other'
  removeLeftBehind(Date.now())
  mkdirSync(fenceDirectory(), { recursive: true, mode: 0o700 })
  const id = `${now.toISOString().replace(/[-:.]/g, '').slice(0, 15)}-${randomBytes(4).toString('hex')}`
  const started = Date.now()
  // Each model has a home folder and a stand-in of its own, so the models are tested side by side.
  const models = await Promise.all(tested.map((agent, index) => (harness === 'opencode'
    ? testOpenCodeModel({ agent, root: join(fenceDirectory(), `${id}-${index}`), environment: real, argvOf: build, limitMs, deadline, signal, register })
    : testModel({
      agent, root: join(fenceDirectory(), `${id}-${index}`), environment: real, argvOf: build, catalog,
      expected: expected[agent.model], renewal: renewal && index === 0, limitMs, deadline, signal, register
    })).then((result) => ({ ...result, ...(entries[agent.model] === undefined ? {} : { catalog_entry: entries[agent.model] }) }),
    (error) => ({ model: openCodeModel(agent), verdict: 'inconclusive', tools: [], reasons: [`the test could not run: ${error instanceof Error ? error.message : String(error)}`], seconds: 0 }))))
  if (signal?.aborted) return { ...base, form, verdict: 'inconclusive', stopped: true, seconds: Math.round((Date.now() - started) / 100) / 10, models: [], reasons: ['the test was stopped before it ended'] }
  // Cut short by the caller's time limit, it saw nothing to the end either: nothing of it is kept.
  if (models.some((model) => model.expired === true)) return { ...base, form, verdict: 'inconclusive', expired: true, seconds: Math.round((Date.now() - started) / 100) / 10, models: [], reasons: ['the time for the test ran out before it ended'] }
  const renewed = models.find((model) => model.renewal !== undefined)?.renewal
  const reasons = renewed === undefined || renewed === 'through-link' ? [] : [RENEWAL_WORDS[renewed]]
  const failed = models.some((model) => model.verdict === 'fail') || renewed === 'link-replaced' || renewed === 'not-written'
  const verdict = failed ? 'fail' : models.every((model) => model.verdict === 'pass') && reasons.length === 0 ? 'pass' : 'inconclusive'
  return keep({ ...base, form, verdict, seconds: Math.round((Date.now() - started) / 100) / 10, models: models.map(withoutRenewal), ...(renewed === undefined ? {} : { renewal: renewed }), reasons })
}

// ---------------------------------------------------------------------------------------------
// The provider's own model list (63.3 AC6)

function collect(argv, cwd, limitMs, signal = undefined, register = undefined) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(null)
    const started = startSupervised(argv, { cwd, stdio: ['ignore', 'ignore', 'ignore'], deadline: Date.now() + limitMs, ...(register === undefined ? {} : { register }) })
    const child = started.child
    if (child === undefined) return resolve(null)
    const end = () => started.kill()
    const limit = setTimeout(end, limitMs)
    signal?.addEventListener('abort', end, { once: true })
    const settle = (code) => {
      clearTimeout(limit)
      signal?.removeEventListener('abort', end)
      resolve(code)
    }
    child.on('error', () => settle(null))
    child.on('close', (code) => settle(started.failed === undefined ? code : null))
  })
}

/**
 * Asks the provider for its model list the way a research run would get it: Codex itself, signed in
 * through a link in a folder of its own, asked only to fetch the list. It is a call to the provider
 * and no question to a model; BMN sends nothing and reads no sign-in file. The list counts only
 * when Codex kept it as fetched: with no answer from the provider Codex falls back to the list it
 * was built with, which is not what this asks for.
 */
export async function providerModelList({ environment = process.env, limitMs = 60_000, signal = undefined, register = undefined } = {}) {
  const folder = join(fenceDirectory(), `list-${randomBytes(6).toString('hex')}`)
  const codex = join(folder, CODEX_RESEARCH_HOME)
  try {
    mkdirSync(join(folder, 'cwd'), { recursive: true, mode: 0o700 })
    mkdirSync(codex, { mode: 0o700 })
    symlinkSync(`${environment.HOME ?? ''}/.codex/${CODEX_SIGN_IN}`, join(codex, CODEX_SIGN_IN))
    const code = await collect(['/usr/bin/env', '-i', `HOME=${environment.HOME ?? ''}`, `PATH=${environment.PATH ?? ''}`, `CODEX_HOME=${codex}`, 'codex', 'debug', 'models'], join(folder, 'cwd'), limitMs, signal, register)
    if (code !== 0) return { ok: false, reason: 'Codex could not be asked for the provider\'s model list' }
    let kept
    try {
      kept = JSON.parse(readFileSync(join(codex, 'models_cache.json'), 'utf8'))
    } catch {
      return { ok: false, reason: 'Codex did not get the provider\'s model list' }
    }
    if (!isObject(kept) || typeof kept.fetched_at !== 'string' || !Array.isArray(kept.models)) return { ok: false, reason: 'Codex kept the provider\'s model list in a shape BMN does not know' }
    return { ok: true, models: kept.models }
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

/**
 * Before a Codex research run's answer may be used: is the tool list under the provider's own
 * model list the one the fence test saw? BMN gets that list, and where the model's entry in it is
 * not the one already compared, repeats the fence test with the stand-in serving it. A difference,
 * or a failed test, is recorded and closes the offer. Nothing here starts a research. The test
 * passes under a list only where Codex was seen to use that list in the run. `signal` and `limitMs`
 * are the research's own Stop and what is left of its time.
 */
export async function compareUnderProviderList({ agent, environment = process.env, now = new Date(), tests = undefined, modelList = providerModelList, test = runFenceTest, signal = undefined, limitMs = undefined, register = undefined } = {}) {
  const begun = Date.now()
  const real = { HOME: environment.HOME ?? '', PATH: environment.PATH ?? '' }
  const version = harnessVersion('codex', real)
  const standing = fenceStanding('codex', version, agent.model, tests)
  if (!standing.passed) return { ok: false, reason: `the fence test of Codex ${version ?? ''} has not passed for ${agent.model}`.replace('  ', ' ') }
  // Stop, and what is left of the research's time, reach both steps: asking for the list and the test under
  // it. The time is one moment for all of it: nothing is started once it has passed.
  const deadline = limitMs === undefined ? undefined : begun + limitMs
  const left = () => (deadline === undefined ? Infinity : deadline - Date.now())
  const stopped = { ok: false, stopped: true, reason: 'stopped before the tools were compared under the provider\'s own model list' }
  const late = { ok: false, stopped: true, reason: 'the time ran out before the tools were compared under the provider\'s own model list' }
  if (signal?.aborted) return stopped
  if (left() <= 0) return late
  const list = await modelList({ environment, limitMs: Math.min(60_000, left()), ...(signal === undefined ? {} : { signal }), ...(register === undefined ? {} : { register }) })
  if (signal?.aborted) return stopped
  if (left() <= 0) return late
  if (!list.ok) return { ok: false, reason: `${list.reason}, so its tool list could not be compared with the tested one` }
  const entry = list.models.find((model) => isObject(model) && model.slug === agent.model)
  if (entry === undefined) return { ok: false, reason: `the provider's model list does not name ${agent.model}, so its tool list could not be compared with the tested one` }
  const hash = sha256(canonicalJson(entry)).slice(0, 16)
  if (standing.live !== null && standing.live.same && standing.live.entry === hash) return { ok: true, compared: false }
  const result = await test({ agents: [agent], environment, now, catalog: { models: list.models }, expected: { [agent.model]: standing.tools }, entries: { [agent.model]: hash }, renewal: false,
    ...(deadline === undefined ? {} : { deadline }), ...(signal === undefined ? {} : { signal }), ...(register === undefined ? {} : { register }) })
  if (signal?.aborted || result.stopped === true) return stopped
  if (result.expired === true) return late
  if (result.verdict === 'pass') return { ok: true, compared: true }
  const why = result.models[0]?.reasons?.[0] ?? result.reasons?.[0] ?? 'the comparison showed nothing'
  return { ok: false, closed: result.verdict === 'fail', reason: `under the provider's own model list the fence test of Codex ${version} did not pass for ${agent.model}: ${why}` }
}

// ---------------------------------------------------------------------------------------------
// `bmn roster fence`

const FENCE_USAGE = `Usage: bmn roster fence [--live] [--json]

Tests, for the installed Codex, that a research run sends its provider nothing of yours. It builds
a throwaway home folder with planted markers, starts a stand-in for the provider on this computer,
and runs the very command a research run is against it, once per Codex model on the approved team.
No provider is called and none of your files is read. It takes about a minute. Where the team has
agents on OpenCode, the installed OpenCode is tested the same way, once per OpenCode model; its web
searches are refused on this computer, so none leaves it.

A Codex or OpenCode agent is offered as a researcher only where this test is on record as passed for
exactly the installed version. --live first asks the provider for its model list (a call to the
provider, no question to a model) and repeats the Codex test under that list; BMN does the same by
itself before the first research with a Codex agent. OpenCode takes its models from the list built
into it, so --live does not apply to it.

Exit: 0 passed, 10 failed or showed nothing.`

function fenceLines(entry) {
  const name = APP_NAMES[entry.harness ?? 'codex']
  const app = `${name} ${entry.version ?? '(not found)'}`
  const lines = [`${app}: the fence test ${entry.verdict === 'pass' ? 'passed' : entry.verdict === 'fail' ? 'FAILED' : 'showed nothing'}${entry.catalog === 'live' ? ' under the provider\'s own model list' : ''}.`]
  for (const model of entry.models) {
    lines.push(`  ${model.model}: ${model.verdict === 'pass' ? 'passed' : model.verdict === 'fail' ? 'FAILED' : 'showed nothing'}${model.reasons.length === 0 ? '' : `: ${model.reasons.join('; ')}`}`)
  }
  for (const reason of entry.reasons ?? []) lines.push(`  ${reason}`)
  if (entry.renewal === 'through-link') lines.push(`  ${RENEWAL_WORDS['through-link']}.`)
  const tools = [...new Set(entry.models.flatMap((model) => model.tools))].sort()
  if (tools.length > 0) lines.push(`  Tools ${name} keeps offering: ${tools.join(', ')}.`)
  if (entry.form === 'other') lines.push('  This was not the research form as BMN builds it, so the result counts for nothing.')
  lines.push(entry.verdict === 'pass' ? `  The team's ${name} researchers are offered on this version.` : `  No ${name} agent is offered as a researcher on this version.`)
  return lines
}

export async function runFenceCommand(argv) {
  const { AgentsUsageError, EXIT, failWith, out, readOptions, usage } = await import('./agents-cli.mjs')
  let parsed
  try {
    parsed = readOptions(argv, { flags: ['json', 'live', 'help'] })
    if (parsed.positionals.length > 0 || parsed.rest !== null) throw new AgentsUsageError('roster fence takes no arguments')
  } catch (error) {
    if (error instanceof AgentsUsageError) return usage(error.message)
    throw error
  }
  if (parsed.options.help === true) {
    out(FENCE_USAGE)
    return 0
  }
  const asJson = parsed.options.json === true
  try {
    const data = readApproved().data
    const subjects = fenceSubjects(data)
    const onOpenCode = fenceSubjects(data, 'opencode')
    // Codex as before, also with no Codex agent where no other app has one either; OpenCode where the team has an agent on it.
    const entries = []
    let entry = subjects.length > 0 || onOpenCode.length === 0 ? await runFenceTest({ agents: subjects }) : null
    if (entry !== null) entries.push(entry)
    if (parsed.options.live === true && entry?.verdict === 'pass') {
      const list = await providerModelList()
      if (!list.ok) entry = { ...entry, verdict: 'inconclusive', reasons: [`${list.reason}, so nothing was compared under it`] }
      else {
        const hashes = Object.fromEntries(subjects.flatMap((agent) => {
          const found = list.models.find((model) => isObject(model) && model.slug === agent.model)
          return found === undefined ? [] : [[agent.model, sha256(canonicalJson(found)).slice(0, 16)]]
        }))
        entry = await runFenceTest({ agents: subjects.filter((agent) => hashes[agent.model] !== undefined), catalog: { models: list.models }, entries: hashes, renewal: false,
          expected: Object.fromEntries(entries[0].models.map((model) => [model.model, model.tools])) })
      }
      entries.push(entry)
    }
    if (onOpenCode.length > 0) entries.push(await runFenceTest({ harness: 'opencode', agents: onOpenCode }))
    if (asJson) out(JSON.stringify(entries.length === 1 ? entries[0] : entries, null, 2))
    else out(entries.flatMap(fenceLines).join('\n'))
    return entries.every((one) => one.verdict === 'pass') ? 0 : EXIT.refusal
  } catch (error) {
    return failWith(error, asJson)
  }
}
