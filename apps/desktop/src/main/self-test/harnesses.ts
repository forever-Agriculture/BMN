// MODULE: harnesses.ts - stand-in agents, hook fixtures and argv recorders the main-process self-test writes and drives
import type {
  BrowserWindow
} from 'electron'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import {
  join
} from 'node:path'

/** Resume checks that a Codex rollout exists, so the self-test gives the host its own CODEX_HOME. */
export function selfTestCodexHome(): string {
  const home = join(process.env.BMN_STATE_HOME ?? '', 'codex-home')
  mkdirSync(home, { recursive: true, mode: 0o700 })
  return home
}

/**
 * A synthetic Codex harness: it records the arguments it was started with and reports the
 * conversation it is in through the real `bmn hook codex`, exactly as the installed CLI's
 * SessionStart hook does. It keeps running so its session stays live.
 */
export function writeCodexHarness(
  directory: string,
  reference: string
): { executable: string; log: string; listing: string } {
  mkdirSync(directory, { recursive: true })
  const log = join(directory, 'argv.log')
  const listing = join(directory, 'list.json')
  const executable = join(directory, 'codex')
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { spawnSync } = require('node:child_process')",
      "const { appendFileSync, writeFileSync } = require('node:fs')",
      "const event = JSON.stringify({",
      "  hook_event_name: 'SessionStart',",
      "  source: 'startup',",
      `  session_id: ${JSON.stringify(reference)},`,
      "})",
      "spawnSync('bmn', ['hook', 'codex'], { input: event, stdio: ['pipe', 'ignore', 'ignore'] })",
      // The session reads its own listing back with its own token, the way an agent would.
      "const listed = spawnSync('bmn', ['list', '--json'], { encoding: 'utf8' })",
      `writeFileSync(${JSON.stringify(listing)}, listed.stdout ?? '')`,
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      "process.stdout.write('codex harness ready\\n')",
      "setInterval(() => undefined, 1_000)",
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, log, listing }
}

/** Gated real-CLI fixture: every step finishes before its receipt is published. */
export function writeAcceptanceHarness(directory: string, name: string, steps: string[]): string {
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  const executable = join(directory, name)
  writeFileSync(executable, [
    `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
    "const { spawnSync } = require('node:child_process')",
    "const { existsSync, appendFileSync, writeFileSync } = require('node:fs')",
    `const directory = ${JSON.stringify(directory)}`,
    "const file = (name) => directory + '/' + name",
    "const wait = async (name) => { while (!existsSync(file(name))) await new Promise(r => setTimeout(r, 25)) }",
    "const cli = (args, input) => { const r = spawnSync('bmn', args, { input, encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr); return r.stdout }",
    "appendFileSync(file('argv.log'), JSON.stringify(process.argv.slice(2)) + '\\n')",
    "setInterval(() => undefined, 1000)",
    ";(async () => {", ...steps,
    "})().catch(error => writeFileSync(file('error'), String(error)))", ''
  ].join('\n'), { mode: 0o700 })
  return executable
}

/**
 * Epic 29 stand-in Claude, typed into a shell the way the owner runs agents, so its chip reads
 * "Shell" until its own hooks report: gate `fire-N` carries one scenario (base URL, model, event)
 * and the real `bmn hook claude` runs under exactly that environment. A resumed run skips gates
 * already `done-N`, so after a restart it waits for the next gate instead of replaying old ones.
 */
export function writeOriginHarness(directory: string): string {
  return writeAcceptanceHarness(directory, 'origin-agent', [
    "for (let n = 0; ; n++) {",
    "  if (existsSync(file('done-' + n))) continue",
    "  await wait('fire-' + n)",
    "  const scenario = JSON.parse(require('node:fs').readFileSync(file('fire-' + n), 'utf8'))",
    "  const env = { ...process.env }",
    "  if (scenario.baseUrl === null) delete env.ANTHROPIC_BASE_URL; else env.ANTHROPIC_BASE_URL = scenario.baseUrl",
    "  if (scenario.configDir) env.CLAUDE_CONFIG_DIR = scenario.configDir",
    "  const payload = scenario.event === 'SessionStart' ? { hook_event_name: 'SessionStart', source: 'startup' }",
    "    : { hook_event_name: scenario.event, tool_name: 'Bash', tool_input: { command: 'origin-' + n }, tool_response: { output: 'fixture' } }",
    "  if (scenario.model !== null) payload.model = scenario.model",
    "  const result = spawnSync('bmn', ['hook', 'claude'], { input: JSON.stringify(payload), env, encoding: 'utf8' })",
    "  writeFileSync(file('done-' + n), String(result.status))",
    "}"
  ])
}

/**
 * Epic 30.2 stand-in agent. Each gate `fire-<scenario>` makes it draw one recorded dialog in raw mode,
 * report it through the real `bmn hook`, and log every byte the terminal sends it, so the self-test
 * proves exactly which keys a phone answer wrote. After the keys it reports the answer the way the
 * harness does (`PostToolUse`), except Claude's deny, which reports nothing.
 */
export function writeRemoteAnswerHarness(directory: string, fixtures: string): string {
  return writeAcceptanceHarness(directory, 'remote-agent', [
    "const fs = require('node:fs')",
    `const fixtures = ${JSON.stringify(fixtures)}`,
    "const read = (name) => JSON.parse(fs.readFileSync(fixtures + '/' + name, 'utf8'))",
    "const screen = (name) => fs.readFileSync(fixtures + '/screens/' + name, 'utf8').replace(/\\s+$/, '').split('\\n')",
    "let current = ['']",
    "const draw = () => process.stdout.write('\\x1b[2J\\x1b[H' + current.slice(-(process.stdout.rows || 24)).join('\\r\\n'))",
    "process.stdout.on('resize', draw)",
    "const show = (name) => { current = name ? screen(name) : ['']; draw() }",
    "let foregroundAgent = null, foregroundId = null",
    "const hook = (agent, name, patch) => {",
    "  const native = agent === 'claude' || agent === 'codex'",
    "  if (native && foregroundAgent !== agent) {",
    "    foregroundAgent = agent; foregroundId = require('node:crypto').randomUUID()",
    "    spawnSync('bmn', ['hook', agent], { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', session_id: foregroundId }), encoding: 'utf8' })",
    "  }",
    "  return spawnSync('bmn', ['hook', agent], { input: JSON.stringify({ ...read(name), ...patch, ...(native ? { session_id: foregroundId } : {}) }), encoding: 'utf8' }).status",
    "}",
    "const queue = []",
    "let waiter = null",
    "process.stdin.setRawMode(true)",
    "process.stdin.on('data', (chunk) => {",
    "  const text = chunk.toString('utf8')",
    "  appendFileSync(file('keys.log'), JSON.stringify(text) + '\\n')",
    "  for (const key of text) { if (waiter) { const next = waiter; waiter = null; next(key) } else queue.push(key) }",
    "})",
    "const keys = []",
    "const take = async () => { const key = queue.length ? queue.shift() : await new Promise((resolve) => { waiter = resolve }); keys.push(key); return key }",
    // Epic 31.4: a key is one character, or an arrow's escape sequence.
    "const takeKey = async () => { const key = await take(); return key === '\\x1b' ? key + await take() + await take() : key }",
    "const DOWN = '\\x1b[B'",
    // Claude's dialog as the spike recorded it: ticks, a typed-entry row, Next/Submit, then the review.
    "const claudeAsk = async (questions) => {",
    "  const answers = {}",
    "  for (const [q, Q] of questions.entries()) {",
    "    const n = Q.options.length",
    "    let cursor = 0, other = null, otherTicked = false, order = []",
    "    const tabs = '←  ' + questions.map((x, i) => (i < q ? '☒ ' : '☐ ') + x.header).join('  ') + '  ✔ Submit  →'",
    "    const box = (on) => (Q.multiSelect ? '[' + (on ? '✔' : ' ') + '] ' : '')",
    "    const render = () => { current = [tabs, Q.question,",
    "      ...Q.options.flatMap((o, i) => [(cursor === i ? '❯' : ' ') + ' ' + (i + 1) + '. ' + box(order.includes(i)) + o.label, '     ' + o.description]),",
    "      (cursor === n ? '❯' : ' ') + ' ' + (n + 1) + '. ' + box(otherTicked) + (other ?? (Q.multiSelect ? 'Type something' : 'Type something.')),",
    "      ...(Q.multiSelect ? [(cursor === n + 1 ? '❯' : ' ') + '    ' + (q === questions.length - 1 ? 'Submit' : 'Next')] : []),",
    "      '────────────────────────────────────────', '  ' + (n + 2) + '. Chat about this', 'Enter to select · ↑/↓ to navigate · Esc to cancel']; draw() }",
    "    render()",
    "    for (;;) {",
    "      const key = await takeKey()",
    "      if (key === DOWN) { cursor = Math.min(cursor + 1, Q.multiSelect ? n + 1 : n); render(); continue }",
    "      if (key === '\\r') { if (Q.multiSelect ? cursor === n + 1 : cursor === n && other !== null) break; continue }",
    // With the cursor on the typed-entry row every key is text, digits included.
    "      if (cursor === n) { other = (other ?? '') + key; otherTicked = true; render(); continue }",
    "      if (!/^\\d$/.test(key)) continue",
    "      const digit = Number(key)",
    "      if (!Q.multiSelect && digit <= n) { answers[Q.question] = Q.options[digit - 1].label; break }",
    "      if (digit === n + 1) { if (Q.multiSelect) otherTicked = !otherTicked; else cursor = n; render(); continue }",
    "      if (digit <= n) { order = order.includes(digit - 1) ? order.filter((x) => x !== digit - 1) : [...order, digit - 1]; render() }",
    "    }",
    // Claude reports a multi-select answer in the order the boxes were ticked, typed text last.
    "    if (!(Q.question in answers)) answers[Q.question] = Q.multiSelect",
    "      ? [...order.map((i) => Q.options[i].label), ...(otherTicked && other ? [other] : [])].join(', ') : other",
    "  }",
    "  if (questions.length > 1 || questions.some((Q) => Q.multiSelect)) {",
    "    current = ['Review your answers', ...questions.flatMap((Q) => [' ● ' + Q.question, '   → ' + answers[Q.question]]),",
    "      'Ready to submit your answers?', '❯ 1. Submit answers', '  2. Cancel']; draw()",
    "    if (await takeKey() !== '1') return null",
    "  }",
    "  show(null)",
    "  return answers",
    "}",
    // Codex's picker: every question ends with None of the above, whose notes Tab opens.
    "const codexAsk = async (Q) => {",
    "  const n = Q.options.length",
    "  let cursor = 0, notes = null",
    "  const render = () => { current = ['  Question 1/1 (1 unanswered)', '  ' + Q.question,",
    "    ...Q.options.map((o, i) => '  ' + (cursor === i ? '›' : ' ') + ' ' + (i + 1) + '. ' + o.label.padEnd(18) + o.description),",
    "    '  ' + (cursor === n ? '›' : ' ') + ' ' + (n + 1) + '. None of the above  Optionally, add details in notes (tab)',",
    "    ...(notes === null ? [] : ['  › ' + (notes || 'Add notes')]), '', '  tab to add notes | enter to submit answer']; draw() }",
    "  render()",
    "  for (;;) {",
    "    const key = await takeKey()",
    "    if (notes !== null && key !== '\\r') { notes += key; render(); continue }",
    "    if (key === DOWN) { cursor = Math.min(cursor + 1, n); render(); continue }",
    "    if (key === '\\t' && cursor === n) { notes = ''; render(); continue }",
    "    if (key === '\\r') { show(null); return cursor === n ? ['None of the above', ...(notes ? ['user_note: ' + notes] : [])] : [Q.options[cursor].label] }",
    "    if (/^\\d$/.test(key)) { show(null); return [Q.options[Number(key) - 1].label] }",
    "  }",
    "}",
    "for (const scenario of ['single', 'three', 'codex', 'off', 'allow', 'deny', 'card', 'claude-more', 'codex-other', 'opencode-more', 'secret-ask']) {",
    "  await wait('fire-' + scenario)",
    "  keys.length = 0",
    "  if (scenario === 'single') {",
    "    const ask = read('claude/ask-single.pre-tool-use.json')",
    "    show('claude-single-200.txt'); hook('claude', 'claude/ask-single.pre-tool-use.json')",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    const question = ask.tool_input.questions[0]",
    "    const label = question.options[Number(await take()) - 1].label",
    "    show(null)",
    "    hook('claude', 'claude/ask-single.post-tool-use.json', { tool_use_id: ask.tool_use_id, tool_response: { answers: { [question.question]: label } } })",
    "  } else if (scenario === 'three' || scenario === 'card') {",
    "    const ask = read('claude/ask-three.pre-tool-use.json')",
    "    show('claude-three-step1.txt'); hook('claude', 'claude/ask-three.pre-tool-use.json')",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    const answers = {}",
    "    for (const [index, next] of ['claude-three-step2.txt', 'claude-three-step3.txt', 'claude-three-review.txt'].entries()) {",
    "      const question = ask.tool_input.questions[index]",
    "      answers[question.question] = question.options[Number(await take()) - 1].label",
    "      show(next)",
    "    }",
    "    if (await take() === '1') { show(null); hook('claude', 'claude/ask-three.post-tool-use.json', { tool_use_id: ask.tool_use_id, tool_response: { answers } }) }",
    "  } else if (scenario === 'codex') {",
    "    const ask = read('codex/ask-two.pre-tool-use.json')",
    "    show('codex-two-step1.txt'); hook('codex', 'codex/ask-two.pre-tool-use.json')",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    const byId = {}",
    "    for (const [index, next] of ['codex-two-step2.txt', null].entries()) {",
    "      const question = ask.tool_input.questions[index]",
    "      byId[question.id] = { answers: [question.options[Number(await take()) - 1].label] }",
    "      show(next)",
    "    }",
    "    hook('codex', 'codex/ask-two.post-tool-use.json', { tool_use_id: ask.tool_use_id, tool_response: JSON.stringify({ answers: byId }) })",
    "  } else if (scenario === 'claude-more') {",
    "    const questions = [",
    "      { question: 'Which auth method should the API use?', header: 'Auth', multiSelect: false,",
    "        options: [{ label: 'JWT', description: 'Stateless tokens' }, { label: 'Sessions', description: 'Server-side cookies' }] },",
    "      { question: 'Which features should the first release include?', header: 'Features', multiSelect: true,",
    "        options: [{ label: 'Rate limiting', description: 'Per-key caps' }, { label: 'Audit log', description: 'Admin actions' },",
    "          { label: 'Webhooks', description: 'Notify services' }] }",
    "    ]",
    "    show(null); hook('claude', 'claude/ask-single.pre-tool-use.json', { tool_use_id: 'toolu_selftest_more', tool_input: { questions } })",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    const answers = await claudeAsk(questions)",
    "    if (answers) hook('claude', 'claude/ask-single.post-tool-use.json', { tool_use_id: 'toolu_selftest_more', tool_input: { questions }, tool_response: { questions, answers } })",
    "  } else if (scenario === 'codex-other') {",
    "    const questions = [{ id: 'auth', header: 'Auth', question: 'Which auth method should the API use?',",
    "      options: [{ label: 'JWT', description: 'Stateless tokens' }, { label: 'Sessions', description: 'Server-side cookies' }] }]",
    "    show(null); hook('codex', 'codex/ask-single.pre-tool-use.json', { tool_use_id: 'call_selftest_other', tool_input: { questions } })",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    const answers = await codexAsk(questions[0])",
    "    hook('codex', 'codex/ask-single.post-tool-use.json', { tool_use_id: 'call_selftest_other', tool_input: { questions },",
    "      tool_response: JSON.stringify({ answers: { auth: { answers } } }) })",
    "  } else if (scenario === 'opencode-more') {",
    // OpenCode is answered through its plugin, which this stand-in plays: it asks, collects BMN's answer, replies.
    "    const asked = read('opencode/question.asked.multiple.json')",
    "    const requestRef = 'que_0e4a19711001SelfTestMore1'",
    "    const questions = [asked.questions[0], { ...asked.questions[1], custom: false }]",
    "    show(null); hook('opencode', 'opencode/question.asked.multiple.json', { id: requestRef, questions })",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    let taken = null",
    "    for (let attempt = 0; attempt < 6 && !taken; attempt++) {",
    "      taken = (JSON.parse(cli(['answer', 'take', '--wait', '10', '--json'])).answers ?? []).find((answer) => answer.requestRef === requestRef) ?? null",
    "    }",
    "    if (taken) {",
    "      keys.push(JSON.stringify(taken.answers))",
    "      hook('opencode', 'opencode/question.replied.multiple-typed.json', { requestID: requestRef, sessionID: asked.sessionID, answers: taken.answers })",
    "      cli(['answer', 'take', '--wait', '0', '--reported', requestRef + '=ok', '--json'])",
    "    }",
    // Story 34.2: a plain `bmn ask` whose body quotes a synthetic key, withdrawn once its card has been checked.
    "  } else if (scenario === 'secret-ask') {",
    "    cli(['ask', 'secret-ask', 'Commit the key I found?', '--body', 'Should I commit ' + 'sk-ant-api03-' + 'SelfTestSyntheticKey_0123456789 to the repo?'])",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    await wait('fire-secret-ask-close')",
    "    cli(['withdraw', 'secret-ask'])",
    "  } else {",
    "    show('claude-bash-permission.txt'); hook('claude', 'claude/bash.permission-request.json')",
    "    writeFileSync(file('opened-' + scenario), '')",
    "    if (scenario === 'allow' && await take() === '1') { show(null); hook('claude', 'claude/bash.post-tool-use.json') }",
    "    if (scenario === 'deny' && await take() === '3') show('claude-bash-denied.txt')",
    "  }",
    "  writeFileSync(file('done-' + scenario), JSON.stringify(keys))",
    "}"
  ])
}

export interface OriginProbe {
  rowChip: string | null
  rowFlag: string | null
  rowLabel: string | null
  paneChip: string | null
  paneFlag: string | null
  paneLabel: string | null
  inspectorChip: string | null
  inspectorFlag: string | null
  modelRow: string | null
  modelTitle: string | null
}

/**
 * Reads the origin flag where the owner sees it: the sidebar row, the pane heading, and Session
 * details' header and Model row. It selects the session and opens details itself, and waits until
 * `until` (the Model row text, or null for "no Model row") holds before reading anything.
 */
export async function modelOriginProbe(
  window: BrowserWindow, sessionId: string, name: string, until: string | null
): Promise<OriginProbe> {
  return window.webContents.executeJavaScript(`(async () => {
    const wait = async (read, label) => { const end = Date.now() + 10000; while (Date.now() < end) {
      const value = read(); if (value) return value; await new Promise(r => setTimeout(r, 25));
    } throw new Error('model origin probe timed out: ' + label); };
    const id = ${JSON.stringify(sessionId)};
    const until = ${JSON.stringify(until)};
    (await wait(() => document.querySelector('.session-row > button[data-session-id="' + id + '"]'), 'session row')).click();
    if (document.querySelector('.session-inspector h2')?.textContent !== ${JSON.stringify(name)}) {
      (await wait(() => document.querySelector('[aria-label="Actions for ${name}"]'), 'row menu')).click();
      (await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
        .find(row => row.textContent.trim() === 'Session details'), 'details action')).click();
      await wait(() => document.querySelector('.session-inspector h2')?.textContent === ${JSON.stringify(name)}, 'details');
    }
    const modelRow = () => {
      const term = [...document.querySelectorAll('.session-inspector .hook-observation dt')].find(dt => dt.textContent === 'Model');
      return term?.nextElementSibling ?? null;
    };
    await wait(() => until === null ? modelRow() === null : modelRow()?.textContent.includes(until), 'Model row ' + until)
      .catch(async (error) => { throw new Error(error.message + ' ' + JSON.stringify({ shown: modelRow()?.textContent ?? null,
        details: document.querySelector('.session-inspector')?.textContent.slice(0, 300) ?? null,
        origins: await window.aiTerminal.listHookOrigins() })); });
    const row = document.querySelector('.session-row > button[data-session-id="' + id + '"]');
    const pane = document.querySelector('.session-terminal[data-session-id="' + id + '"]:not(.session-terminal-hidden) .pane-heading');
    const inspector = document.querySelector('.session-inspector .inspector-state');
    const flag = (root) => root?.querySelector('.origin-flag') ?? null;
    return {
      rowChip: row?.querySelector('.chips .chip')?.textContent ?? null,
      rowFlag: flag(row)?.textContent ?? null, rowLabel: flag(row)?.getAttribute('aria-label') ?? null,
      paneChip: pane?.querySelector('.chip')?.textContent ?? null,
      paneFlag: flag(pane)?.textContent ?? null, paneLabel: flag(pane)?.getAttribute('aria-label') ?? null,
      inspectorChip: inspector?.querySelector('.chip')?.textContent ?? null,
      inspectorFlag: flag(inspector)?.textContent ?? null,
      modelRow: modelRow()?.textContent ?? null, modelTitle: modelRow()?.getAttribute('title') ?? null
    };
  })()`) as Promise<OriginProbe>
}

/** Fires one origin gate and waits until the stand-in's `bmn hook claude` call has returned. */
export async function fireOriginGate(
  directory: string, n: number, scenario: { baseUrl: string | null; model: string | null; event: string; configDir?: string }
): Promise<void> {
  writeFileSync(join(directory, `fire-${n}`), JSON.stringify(scenario))
  await untilFileExists(join(directory, `done-${n}`), `model origin hook ${n}`)
  const status = readFileSync(join(directory, `done-${n}`), 'utf8')
  if (status !== '0') throw new Error(`model origin hook ${n} exited ${status}`)
}

/** What a session's own `bmn list --json` says about its conversation, once the hook has reported. */
export function listedConversation(listing: string): { sessions: number; conversation: unknown } {
  if (!existsSync(listing)) return { sessions: 0, conversation: null }
  const rows = JSON.parse(readFileSync(listing, 'utf8')) as Array<{ conversation?: unknown }>
  return { sessions: rows.length, conversation: rows[0]?.conversation ?? null }
}

/** A command that records its argv and then stays up, so a started row can be proved by its argv. */
export function writeArgvRecorder(directory: string, name: string): { executable: string; log: string } {
  mkdirSync(directory, { recursive: true })
  const log = join(directory, `${name}.log`)
  const executable = join(directory, name)
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { appendFileSync } = require('node:fs')",
      `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n')`,
      `process.stdout.write(${JSON.stringify(name)} + ' started\\n')`,
      'setInterval(() => undefined, 1_000)',
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, log }
}

/**
 * A program that turns on the modes a TUI turns on — bracketed paste, focus reports and SGR mouse —
 * and then records every byte the terminal sends it. What the log holds is what the program would
 * actually have received, which is the only honest way to ask whether a rebuilt view still speaks
 * to it the same way.
 */
export function writeTerminalModeProgram(directory: string): { executable: string; input: string } {
  mkdirSync(directory, { recursive: true })
  const input = join(directory, 'stdin.log')
  const executable = join(directory, 'modes')
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { appendFileSync } = require('node:fs')",
      // Bracketed paste, focus reports, and mouse tracking with SGR encoding.
      // On: bracketed paste, focus reports, mouse with SGR. Off: autowrap, which a fresh view has on.
      "process.stdout.write('\\u001b[?2004h\\u001b[?1004h\\u001b[?1000h\\u001b[?1006h\\u001b[?7l')",
      "process.stdout.write('MODE-PROGRAM-READY\\r\\n')",
      // Raw mode, as every TUI does: the line discipline must not hold a paste back until Enter.
      "if (process.stdin.isTTY) process.stdin.setRawMode(true)",
      "process.stdin.setEncoding('latin1')",
      `process.stdin.on('data', (chunk) => appendFileSync(${JSON.stringify(input)}, JSON.stringify(chunk) + '\\n'))`,
      'setInterval(() => undefined, 1_000)',
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, input }
}

/** Everything the mode program has been sent, as one string. */
export function terminalModeProgramInput(input: string): string {
  if (!existsSync(input)) return ''
  return readFileSync(input, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as string)
    .join('')
}

export function harnessRuns(log: string): string[][] {
  if (!existsSync(log)) return []
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as string[])
}

export async function untilHarnessRuns(log: string, count: number): Promise<string[][]> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const runs = harnessRuns(log)
    if (runs.length >= count) return runs
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`the synthetic Codex harness did not reach ${count} run(s): ${log}`)
}

/**
 * A synthetic Claude harness: it fires real hook events through the installed `bmn hook claude`, the
 * way the CLI's own hooks do, and waits on gate files so the caller can read the app between events.
 */
export function writeClaudeHookHarness(directory: string): {
  executable: string
  opened: string
  toolGate: string
  resolved: string
  secondGate: string
  reopened: string
} {
  mkdirSync(directory, { recursive: true })
  const opened = join(directory, 'opened')
  const toolGate = join(directory, 'tool-gate')
  const resolved = join(directory, 'resolved')
  const secondGate = join(directory, 'second-gate')
  const reopened = join(directory, 'reopened')
  const executable = join(directory, 'claude')
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { spawnSync } = require('node:child_process')",
      "const { existsSync, writeFileSync } = require('node:fs')",
      "const fire = (event) => spawnSync('bmn', ['hook', 'claude'], {",
      "  input: JSON.stringify(event), stdio: ['pipe', 'ignore', 'ignore']",
      "})",
      "const prompt = { hook_event_name: 'Notification', notification_type: 'permission_prompt',",
      "  message: 'Allow the hook self-test action' }",
      "fire(prompt)",
      `writeFileSync(${JSON.stringify(opened)}, '')`,
      "const after = (gate, run, marker) => {",
      "  const timer = setInterval(() => {",
      "    if (!existsSync(gate)) return",
      "    clearInterval(timer)",
      "    run()",
      "    writeFileSync(marker, '')",
      "  }, 25)",
      "}",
      `after(${JSON.stringify(toolGate)}, () => fire({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: {} }), ${JSON.stringify(resolved)})`,
      `after(${JSON.stringify(secondGate)}, () => fire(prompt), ${JSON.stringify(reopened)})`,
      "process.stdout.write('claude hook harness ready\\n')",
      "setInterval(() => undefined, 1_000)",
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, opened, toolGate, resolved, secondGate, reopened }
}

/**
 * A second session that fires one hook event of its own. Its name is not in either agent's table, so it opens
 * nothing and only reaches the log - which is what the log is for, and what keeps the two sessions' logs apart.
 */
export function writeIsolationHookHarness(directory: string): { executable: string; fired: string; event: string } {
  mkdirSync(directory, { recursive: true })
  const fired = join(directory, 'fired')
  const executable = join(directory, 'claude')
  const event = 'Isolation-Probe'
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { spawnSync } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      `spawnSync('bmn', ['hook', 'claude'], {`,
      `  input: JSON.stringify({ hook_event_name: ${JSON.stringify(event)} }), stdio: ['pipe', 'ignore', 'ignore']`,
      '})',
      `writeFileSync(${JSON.stringify(fired)}, '')`,
      "process.stdout.write('isolation hook harness ready\\n')",
      'setInterval(() => undefined, 1_000)',
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, fired, event }
}

/**
 * Epic 15.1: a program that knows nothing of `bmn` and only writes a terminal notification. With
 * `hookFirst` it reports one real hook event before printing, which is the session BMN must leave
 * to its own harness.
 */
export function writeTerminalNoticeHarness(
  directory: string,
  options: { hookFirst: boolean }
): { executable: string; printed: string; trigger: string; second: string } {
  mkdirSync(directory, { recursive: true })
  const printed = join(directory, 'printed')
  const trigger = join(directory, 'trigger')
  const second = join(directory, 'second')
  const executable = join(directory, 'notice-harness')
  writeFileSync(join(directory, 'package.json'), '{"type":"commonjs"}\n')
  writeFileSync(
    executable,
    [
      `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}`,
      "const { spawnSync } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      ...(options.hookFirst
        ? [
          "spawnSync('bmn', ['hook', 'claude'], {",
          "  input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'the harness finished' }),",
          "  stdio: ['pipe', 'ignore', 'ignore']",
          '})'
        ]
        : []),
      // OSC 9, the plainest of the three: ESC ] 9 ; text BEL.
      "process.stdout.write('\\u001b]9;BMN self-test notice\\u0007')",
      `writeFileSync(${JSON.stringify(printed)}, '')`,
      // A second notice on demand, so the probe can snapshot the terminal on both sides of one.
      "const { existsSync } = require('node:fs')",
      'const waiting = setInterval(() => {',
      `  if (!existsSync(${JSON.stringify(trigger)})) return`,
      '  clearInterval(waiting)',
      "  process.stdout.write('\\u001b]9;BMN self-test second notice\\u0007')",
      `  writeFileSync(${JSON.stringify(second)}, '')`,
      '}, 25)',
      'setInterval(() => undefined, 1_000)',
      ''
    ].join('\n'),
    { mode: 0o700 }
  )
  return { executable, printed, trigger, second }
}

/** Waits for one of the harness's marker files; the harness writes each one after its event landed. */
export async function untilFileExists(path: string, what: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`the Claude hook harness never ${what}: ${path}`)
}

