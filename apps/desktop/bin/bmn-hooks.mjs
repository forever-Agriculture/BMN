// MODULE: bmn-hooks.mjs - the bmn command line behind bin/bmn: hook events as attention calls, the agents' hook files and `bmn hooks` check, install and install --absent
import { assertDefaultsAdmission, withDefaultsAdmission } from './defaults-admission.mjs'
import { createHash } from 'node:crypto'
import { closeSync, constants, copyFileSync, existsSync, fstatSync, openSync, readFileSync, readlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { absoluteUncollapsed, currentText, jsonIndent, linkTarget, rewrittenNumbers, writeAtomically } from './safe-config-write.mjs'
import { unifiedDiff } from './text-diff.mjs'
import { isObject } from './shared-helpers.mjs'
import { CONVERSATION_REFERENCE, CONVERSATION_SOURCES, HOOKS_USAGE, OPENCODE_REFERENCE } from './bmn-words.mjs'
import { CliError, UsageError, parseArguments } from './bmn-commands.mjs'
import { EARLIER_OPENCODE_PLUGINS, HOOK_AGENTS, OPENCODE_PLUGIN } from './bmn-opencode-plugin.mjs'
import { usageFailure } from './bmn-results.mjs'

export { HOOK_WRAPPERS, PERMISSION_WAIT_MS, asyncUserInputTool, claudeConfigDir, holdAtTestGate, hookEventName, hookRequests, openCodeSubagent, phoneAnswerable, retiredOr, runHooks, userInputTool }

/** Processes that can stand between an agent and a hook it runs. */
const HOOK_WRAPPERS = new Set(['sh', 'dash', 'bash', 'zsh', 'fish', 'ksh', 'env', 'timeout', 'nice', 'nohup', 'stdbuf'])
const HOOK_BODY_MAX = 2000
const IN_TERMINAL = 'answered in the terminal'

function clip(text, max) {
  if (text.length <= max) return text
  let end = max - 1
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${text.slice(0, end)}…`
}

/** One line without control characters, as the control server requires of a title. */
function titleText(value, fallback) {
  // eslint-disable-next-line no-control-regex
  const text = typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f\s]+/g, ' ').trim() : ''
  return clip(text || fallback, 200)
}

function bodyText(value) {
  if (typeof value !== 'string') return undefined
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim()
  return text === '' ? undefined : clip(text, HOOK_BODY_MAX)
}

function toolSummary(input) {
  if (typeof input === 'string') return input
  if (!isObject(input)) return undefined
  for (const key of ['command', 'cmd', 'file_path', 'path', 'url', 'description']) {
    const value = input[key]
    if (typeof value === 'string' && value !== '') return value
    if (Array.isArray(value) && value.length > 0) return value.join(' ')
  }
  return JSON.stringify(input)
}

function userInputTool(value) {
  return typeof value === 'string' && /(?:^|[.:/])request_user_input(?:_async)?$/.test(value)
}

function asyncUserInputTool(value) {
  return typeof value === 'string' && /(?:^|[.:/])request_user_input_async$/.test(value)
}

function userInputSummary(name, input) {
  const candidates = isObject(input) && Array.isArray(input.questions) ? input.questions : []
  const questions = candidates.flatMap((candidate) => {
    if (!isObject(candidate)) return []
    const prompt = [candidate.question, candidate.title, candidate.header]
      .find((value) => typeof value === 'string' && value.trim() !== '')
    if (typeof prompt !== 'string') return []
    const options = Array.isArray(candidate.options)
      ? candidate.options.flatMap((option) => {
        if (typeof option === 'string' && option.trim() !== '') return [option.trim()]
        if (isObject(option) && typeof option.label === 'string' && option.label.trim() !== '') {
          return [option.label.trim()]
        }
        return []
      })
      : []
    return [{ prompt: prompt.trim(), options }]
  })
  if (questions.length === 0) {
    return {
      title: `${name} has a question`,
      body: bodyText(toolSummary(input))
    }
  }
  const first = questions[0].prompt
  const heading = questions.length === 1
    ? `${name} asks: ${first}`
    : `${name} has ${questions.length} questions: ${first}`
  const rows = questions.map((question, index) => {
    const options = question.options.length === 0 ? '' : `\n   ${question.options.join(' | ')}`
    return `${index + 1}. ${question.prompt}${options}`
  })
  return { title: titleText(heading, `${name} has a question`), body: bodyText(rows.join('\n')) }
}

/**
 * Protective bounds the app stores a prompt within (shared/protocol attention-prompt.ts). A dialog larger
 * than these is sent as a plain request rather than cut: a shortened dialog is a different dialog.
 */
const PROMPT_LIMITS = Object.freeze({
  questions: 10, options: 20, text: 2000, header: 100, label: 200, description: 500, identifier: 128, tool: 100,
  command: 100000, cwd: 4096, answer: 4000
})

/** One line of prompt text, controls folded to spaces and clipped like a title; null when nothing is left. */
function promptLine(value, max) {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/g, ' ').trim()
  return text === '' ? null : clip(text, max)
}

/** Prompt text that may span lines: tabs and line feeds kept, every other control removed. */
function promptText(value, max) {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').trim()
  return text === '' ? null : clip(text, max)
}

/** An id is kept only whole: a clipped id would name a different request. */
function promptId(value) {
  // eslint-disable-next-line no-control-regex
  return typeof value === 'string' && value !== '' && value.length <= PROMPT_LIMITS.identifier && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    ? value
    : null
}

/**
 * The agent's own questions as the app stores them (docs/remote-answers.md), or undefined when the
 * payload is not well formed. Async questions may omit options; that never creates an answer route.
 * Claude and Codex name the text `question`, Codex async `title`; OpenCode marks multi-select `multiple`.
 */
function questionsPrompt(harness, input, ids, shape) {
  const candidates = isObject(input) && Array.isArray(input.questions) ? input.questions : []
  if (candidates.length === 0 || candidates.length > PROMPT_LIMITS.questions) return undefined
  const questions = []
  for (const candidate of candidates) {
    if (!isObject(candidate)) return undefined
    const text = promptText(candidate.question ?? candidate.title, PROMPT_LIMITS.text)
    const raw = Array.isArray(candidate.options) ? candidate.options : []
    if (text === null || (raw.length === 0 && shape !== 'async-choice') || raw.length > PROMPT_LIMITS.options) return undefined
    const options = []
    for (const option of raw) {
      const label = promptLine(isObject(option) ? option.label : option, PROMPT_LIMITS.label)
      if (label === null) return undefined
      options.push({ label, description: isObject(option) ? promptText(option.description, PROMPT_LIMITS.description) : null })
    }
    questions.push({
      id: promptId(candidate.id),
      header: promptLine(candidate.header, PROMPT_LIMITS.header),
      text,
      multiSelect: candidate.multiSelect === true || candidate.multiple === true,
      options,
      // OpenCode may turn typed answers off for one question; the others always allow them.
      ...(harness === 'opencode' && typeof candidate.custom === 'boolean' ? { custom: candidate.custom } : {})
    })
  }
  return {
    type: 'questions',
    harness,
    shape: shape ?? (questions.some((question) => question.multiSelect) ? 'multi-select' : 'choice'),
    requestRef: promptId(ids.requestRef),
    toolUseId: promptId(ids.toolUseId),
    questions
  }
}

/**
 * A permission prompt; `command` stays null unless the harness said exactly what would run. `description`,
 * when given, is what the dialog draws under the command, kept only whole.
 */
function permissionPrompt(harness, shape, tool, command, ids, cwd, description) {
  const name = promptLine(tool, PROMPT_LIMITS.tool)
  if (name === null) return undefined
  const exact = typeof command === 'string' && command.length <= PROMPT_LIMITS.command ? promptText(command, PROMPT_LIMITS.command) : null
  return {
    type: 'permission',
    harness,
    shape,
    requestRef: promptId(ids.requestRef),
    toolUseId: promptId(ids.toolUseId),
    tool: name,
    command: exact,
    // eslint-disable-next-line no-control-regex
    cwd: typeof cwd === 'string' && cwd.startsWith('/') && cwd.length <= PROMPT_LIMITS.cwd && !/[\u0000-\u001f]/.test(cwd) ? cwd : null,
    ...(description === undefined ? {} : {
      description: typeof description === 'string' && description.length <= PROMPT_LIMITS.description
        ? promptText(description, PROMPT_LIMITS.description)
        : null
    })
  }
}

/**
 * Story 78.3: what a Claude file tool would do, every approval-relevant field in one text the card shows and the
 * phone approves: the path, and the whole content, or the text replaced, its replacement and how often. Each text
 * is preceded by its length in characters, so no content can pass for another field. Null for an input with any
 * other field, or one not of this shape.
 */
function claudeFileChange(tool, input) {
  if (!isObject(input) || typeof input.file_path !== 'string' || input.file_path === '') return null
  const length = (text) => [...text].length.toLocaleString('en-US')
  if (tool === 'Write') {
    if (Object.keys(input).some((key) => !['file_path', 'content'].includes(key)) || typeof input.content !== 'string') return null
    // The end mark keeps a file's last line break or spaces exact: nothing at the end is trimmed off the card.
    return `Write ${input.file_path}, the whole file (${length(input.content)} characters):\n${input.content}\n(end of file)`
  }
  if (tool === 'Edit') {
    if (Object.keys(input).some((key) => !['file_path', 'old_string', 'new_string', 'replace_all'].includes(key))) return null
    if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return null
    if (input.replace_all !== undefined && typeof input.replace_all !== 'boolean') return null
    const how = input.replace_all === true ? 'every occurrence' : 'one occurrence'
    return `Edit ${input.file_path}, replacing ${how} of (${length(input.old_string)} characters):\n${input.old_string}\n` +
      `with (${length(input.new_string)} characters):\n${input.new_string}\n(end of change)`
  }
  return null
}

/** What a Claude tool's permission shows: a file tool's whole change (Story 78.3), else the one field it acts on. */
function claudeApproval(tool, input) {
  return tool === 'Write' || tool === 'Edit' ? claudeFileChange(tool, input) : claudeCommand(input)
}

/** The exact thing a Claude tool would act on, when it names one; otherwise null, never a JSON dump. */
function claudeCommand(input) {
  if (!isObject(input)) return null
  for (const key of ['command', 'file_path', 'path', 'url', 'notebook_path', 'pattern']) {
    if (typeof input[key] === 'string' && input[key] !== '') return input[key]
  }
  return null
}

/**
 * What a hook reports about how a prompt ended (docs/remote-answers.md, "Proof of an answer"), in the shape
 * the app validates. A value that would not pass is left null rather than sent: malformed evidence would
 * refuse the resolve it rides on.
 */
function evidenceOf(fields) {
  return { toolUseId: null, requestRef: null, answers: null, permission: null, tool: null, command: null, ...fields }
}

/**
 * What each question was answered with, in the order the dialog asked them: one string, or a harness's list of
 * them (Codex puts a typed note after "None of the above"). Null unless every question has an answer.
 */
function orderedAnswers(questions, answerOf) {
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > PROMPT_LIMITS.questions) return null
  const answers = []
  for (const question of questions) {
    const raw = isObject(question) ? answerOf(question) : undefined
    const list = Array.isArray(raw) ? raw : [raw]
    if (list.length === 0 || list.length > PROMPT_LIMITS.options) return null
    const labels = list.map((value) => promptLine(value, PROMPT_LIMITS.answer))
    if (labels.some((label) => label === null)) return null
    answers.push(labels)
  }
  return answers
}

/** Claude's PostToolUse: the chosen answers of its question tool, or the tool and exact input that ran. */
function claudeEvidence(event) {
  const toolUseId = promptId(event.tool_use_id)
  if (event.tool_name === 'AskUserQuestion') {
    const chosen = isObject(event.tool_response) && isObject(event.tool_response.answers) ? event.tool_response.answers : null
    const answers = chosen ? orderedAnswers(event.tool_input?.questions,
      (question) => typeof question.question === 'string' && Object.hasOwn(chosen, question.question) ? chosen[question.question] : undefined) : null
    return evidenceOf({ toolUseId, answers })
  }
  const command = claudeApproval(event.tool_name, event.tool_input)
  return evidenceOf({
    toolUseId,
    permission: 'allowed',
    tool: promptLine(event.tool_name, PROMPT_LIMITS.tool),
    command: typeof command === 'string' && command.length <= PROMPT_LIMITS.command ? promptText(command, PROMPT_LIMITS.command) : null
  })
}

/** Codex's PostToolUse for its question tool: `tool_response` is a JSON string of answers keyed by question id. */
function codexEvidence(event) {
  let response = event.tool_response
  if (typeof response === 'string') {
    try {
      response = JSON.parse(response)
    } catch {
      response = undefined
    }
  }
  const byId = isObject(response) && isObject(response.answers) ? response.answers : null
  const answers = byId ? orderedAnswers(event.tool_input?.questions, (question) => {
    const entry = typeof question.id === 'string' && Object.hasOwn(byId, question.id) ? byId[question.id] : undefined
    return isObject(entry) && Array.isArray(entry.answers) ? entry.answers : undefined
  }) : null
  return evidenceOf({ toolUseId: promptId(event.tool_use_id), answers })
}

/** OpenCode's replied events name the request they answer and exactly what was answered. */
function openCodeEvidence(event) {
  const requestRef = promptId(event.requestID)
  if (event.hook_event_name === 'permission.replied') {
    // "always" is never sent from the phone, so it proves nothing about an answer BMN sent.
    return evidenceOf({ requestRef, permission: event.reply === 'once' ? 'allowed' : event.reply === 'reject' ? 'denied' : null })
  }
  const raw = event.answers
  const answers = Array.isArray(raw) && raw.length > 0 && raw.length <= PROMPT_LIMITS.questions &&
    raw.every((labels) => Array.isArray(labels) && labels.length > 0 && labels.length <= PROMPT_LIMITS.options)
    ? raw.map((labels) => labels.map((label) => promptLine(label, PROMPT_LIMITS.answer)))
    : null
  return evidenceOf({ requestRef, answers: answers && answers.every((labels) => labels.every((label) => label !== null)) ? answers : null })
}

/** Claude Code lists in-flight background work and scheduled wake-ups on Stop; either resumes the agent without the owner. */
function resumesByItself(event) {
  return [event.background_tasks, event.session_crons].some((list) => Array.isArray(list) && list.length > 0)
}

/**
 * The harness names the conversation its process is in when a session starts, resumes, is cleared
 * or is forked. Subagent payloads carry `agent_id` and speak for a nested conversation, not the
 * owner's, so they are ignored the way the nested-agent gate ignores a `claude -p` helper.
 */
function conversationObservation(agent, event) {
  if (!CONVERSATION_SOURCES.includes(event.source)) return undefined
  if (event.agent_id !== undefined && event.agent_id !== null) return undefined
  if (typeof event.session_id !== 'string' || !(agent === 'opencode' ? OPENCODE_REFERENCE : CONVERSATION_REFERENCE).test(event.session_id)) return undefined
  const transcript = event.transcript_path
  return {
    method: 'conversation.observe',
    params: {
      agentCli: agent,
      conversationReference: event.session_id,
      source: event.source,
      ...(typeof transcript === 'string' && transcript.startsWith('/') ? { transcriptPath: transcript } : {})
    }
  }
}

/**
 * The provenance word for one hook event. The vocabulary is closed on the app side, so an event name the
 * harness invents that does not fit the shape is dropped rather than refused with the calls it belongs to.
 */
function hookOrigin(agent, eventName) {
  if (hookEventName(eventName) === undefined) return undefined
  const origin = `hook:${agent}:${eventName}`
  // The whole origin is one `RULES.source` value; a name too long to fit is logged but not stamped.
  return origin.length > 64 ? undefined : origin
}

/** The `RULES.source` shape the app accepts: 1-64 characters, no control characters. */
function hookEventName(eventName) {
  // eslint-disable-next-line no-control-regex
  return typeof eventName === 'string' && /^[^\x00-\x1f\x7f]{1,64}$/.test(eventName) ? eventName : undefined
}

/**
 * Epic 78: how long Claude's `PermissionRequest` hook waits for an answer from the phone, and the timeout its
 * entry carries so Claude lets it (Claude's own default for a command hook is 600 s). Measured on 2.1.302
 * (docs/remote-answers.md): the dialog shows and stays answerable at the desk while the hook waits, the first
 * answer wins, and a hook that stops without a decision leaves the dialog as it was.
 */
const PERMISSION_WAIT_MS = 590_000
const PERMISSION_HOOK_TIMEOUT = 600
/** The fields of a Bash call that may go to the phone: what runs, its description and how long it may run. */
const PHONE_BASH_FIELDS = new Set(['command', 'description', 'timeout', 'run_in_background'])

/**
 * Whether this Claude permission request may be answered by its own hook from the phone: the typed agent's main
 * conversation, a tool family measured for it, and an input whose every approval-relevant field the card shows
 * exactly as Claude will run it (Epic 78, R78-NFR1). Anything else keeps today's route.
 */
function phoneAnswerable(agent, event, launch = { pid: 0, procRoot: '/proc' }) {
  if (agent !== 'claude' || event.hook_event_name !== 'PermissionRequest') return false
  if (event.agent_id !== undefined && event.agent_id !== null) return false
  if (otherPermissionHook(event, launch)) return false
  const input = event.tool_input
  // Story 78.3: Write and Edit (measured on 2.1.302) when their whole change is one exact text.
  if (event.tool_name === 'Write' || event.tool_name === 'Edit') {
    const change = claudeFileChange(event.tool_name, input)
    return change !== null && change.length <= PROMPT_LIMITS.command && promptText(change, PROMPT_LIMITS.command) === change
  }
  if (event.tool_name !== 'Bash' || !isObject(input)) return false
  if (Object.keys(input).some((key) => !PHONE_BASH_FIELDS.has(key))) return false
  const command = input.command
  return typeof command === 'string' && command.length <= PROMPT_LIMITS.command &&
    promptText(command, PROMPT_LIMITS.command) === command &&
    (input.description === undefined || typeof input.description === 'string')
}

/**
 * Whether a `PermissionRequest` hook other than BMN's own could decide this request. The first decision written wins
 * (Story 78.1, 10/10), so BMN waits for the phone only when its hook is the only deciding one it can see: in the
 * settings Claude reads (managed, user, project, local, and any `--settings` it was started with) and in the hooks of
 * plugins a settings file enables. A file that cannot be read is passed over, except a `--settings` one; a group or
 * entry that cannot be read, or a matcher that cannot be read, counts, and so does a launch line BMN cannot read:
 * without it no hook can be ruled out (review F4).
 */
function otherPermissionHook(event, launch = { pid: 0, procRoot: '/proc' }) {
  const readJson = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }
  // `--settings <file or JSON>` adds hooks no fixed file shows (the review's case); one that cannot be read counts.
  const launched = []
  if (!launch.pid) return true
  let argv
  try { argv = readFileSync(join(launch.procRoot, String(launch.pid), 'cmdline'), 'utf8').split('\0').filter((arg) => arg !== '') } catch { return true }
  if (argv.length === 0) return true
  for (const [index, arg] of argv.entries()) {
    const value = arg === '--settings' ? argv[index + 1] : arg.startsWith('--settings=') ? arg.slice('--settings='.length) : undefined
    if (value === undefined) continue
    if (value.trimStart().startsWith('{')) { try { launched.push(JSON.parse(value)) } catch { return true } continue }
    let file = value
    if (!file.startsWith('/')) {
      try { file = join(readlinkSync(join(launch.procRoot, String(launch.pid), 'cwd')), file) } catch { return true }
    }
    const data = readJson(file)
    if (data === undefined) return true
    launched.push(data)
  }
  const project = process.env.CLAUDE_PROJECT_DIR || event.cwd
  const files = ['/etc/claude-code/managed-settings.json', join(claudeConfigDir(), 'settings.json')]
  if (typeof project === 'string' && project.startsWith('/')) {
    files.push(join(project, '.claude', 'settings.json'), join(project, '.claude', 'settings.local.json'))
  }
  const groups = []
  const enabled = new Set()
  const collect = (data) => {
    if (!isObject(data) || !isObject(data.hooks) || data.hooks.PermissionRequest === undefined) return
    if (Array.isArray(data.hooks.PermissionRequest)) groups.push(...data.hooks.PermissionRequest)
    else groups.push(null)
  }
  for (const data of [...files.map(readJson), ...launched]) {
    collect(data)
    if (isObject(data) && isObject(data.enabledPlugins)) {
      for (const [name, on] of Object.entries(data.enabledPlugins)) if (on === true) enabled.add(name)
    }
  }
  const installed = readJson(join(claudeConfigDir(), 'plugins', 'installed_plugins.json'))
  for (const name of enabled) {
    const installs = isObject(installed) && isObject(installed.plugins) && Array.isArray(installed.plugins[name]) ? installed.plugins[name] : []
    for (const install of installs) {
      if (isObject(install) && typeof install.installPath === 'string') collect(readJson(join(install.installPath, 'hooks', 'hooks.json')))
    }
  }
  const matches = (matcher) => {
    if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return true
    if (typeof matcher !== 'string') return true
    try { return new RegExp(matcher).test(event.tool_name) } catch { return true }
  }
  return groups.some((group) => !isObject(group) || !Array.isArray(group.hooks) || (matches(group.matcher) &&
    group.hooks.some((entry) => !isObject(entry) || entry.type !== 'command' || !['wired', 'older'].includes(hookEntryState(entry.command, 'claude')))))
}

/** Maps one Claude Code or Codex hook event to the attention calls that keep Needs you truthful. */
function hookRequests(agent, event, permissionRef = null) {
  const name = HOOK_AGENTS[agent]
  const requestKey = (slot) => `${agent}:${slot}`
  // Every call this event makes carries the event that made it, so Needs you can say where a row came from.
  const origin = hookOrigin(agent, event.hook_event_name)
  const producer = (agent === 'claude' || agent === 'codex') &&
    (event.agent_id === undefined || event.agent_id === null) &&
    typeof event.session_id === 'string' && CONVERSATION_REFERENCE.test(event.session_id)
    ? { agentCli: agent, conversationReference: event.session_id.toLowerCase() } : undefined
  const attribution = producer === undefined ? {} : { producer }
  const open = (slot, kind, title, body, prompt) => [{
    method: 'attention.open',
    params: {
      requestKey: requestKey(slot), kind, title, origin, ...attribution,
      ...(body === undefined ? {} : { body }),
      ...(prompt === undefined ? {} : { prompt })
    }
  }]
  const withdraw = (...slots) => slots.map((slot) => ({
    method: 'attention.withdraw',
    params: { requestKey: requestKey(slot), origin, ...attribution }
  }))
  const answered = (...slots) => slots.map((slot) => ({
    method: 'attention.resolve',
    params: { requestKey: requestKey(slot), resolution: IN_TERMINAL, origin, ...attribution }
  }))
  // The harness's own report of the answer, so an answer sent from the phone can be confirmed.
  const proven = (calls, evidence) => calls.map((call) => ({ ...call, params: { ...call.params, evidence } }))
  if (agent === 'opencode') {
    const id = event.sessionID ?? event.info?.id
    if (openCodeSubagent(event)) {
      switch (event.hook_event_name) {
        case 'permission.asked':
          return open('subagent-permission', 'permission', titleText(`OpenCode subagent asks to ${titleText(event.permission, 'use a tool')}`, 'OpenCode subagent asks permission'),
            bodyText(Array.isArray(event.patterns) ? event.patterns.join('\n') : undefined),
            permissionPrompt('opencode', 'subagent', event.permission, event.metadata?.command, { requestRef: event.id }, null))
        case 'permission.replied':
          return event.reply === 'reject' ? withdraw('subagent-permission')
            : ['once', 'always'].includes(event.reply) ? answered('subagent-permission') : []
        case 'question.asked': {
          const summary = userInputSummary('OpenCode subagent', event)
          return open('subagent-question', 'question', summary.title, summary.body,
            questionsPrompt('opencode', event, { requestRef: event.id }, 'subagent'))
        }
        case 'question.replied': return answered('subagent-question')
        case 'question.rejected': return withdraw('subagent-question')
        default: return []
      }
    }
    switch (event.hook_event_name) {
      case 'permission.asked':
        return open('permission', 'permission', titleText(`OpenCode asks to ${titleText(event.permission, 'use a tool')}`, 'OpenCode asks permission'),
          bodyText(Array.isArray(event.patterns) ? event.patterns.join('\n') : undefined),
          // Only `metadata.command` says exactly what runs; `patterns` are what an "always" would cover.
          permissionPrompt('opencode', 'permission', event.permission, event.metadata?.command, { requestRef: event.id }, null))
      case 'permission.replied':
        return proven(event.reply === 'reject' ? withdraw('permission')
          : ['once', 'always'].includes(event.reply) ? answered('permission') : [], openCodeEvidence(event))
      case 'question.asked': {
        const summary = userInputSummary(name, event)
        return open('question', 'question', summary.title, summary.body, questionsPrompt('opencode', event, { requestRef: event.id }))
      }
      case 'question.replied': return proven(answered('question'), openCodeEvidence(event))
      case 'question.rejected': return withdraw('question')
      case 'session.status':
        return event.status?.type === 'busy' ? [...answered('permission', 'question'), ...withdraw('turn', 'error')] : []
      case 'session.idle':
        return [...withdraw('permission', 'question', 'subagent-permission', 'subagent-question'), ...open('turn', 'notice', 'OpenCode finished a turn')]
      case 'session.error':
        return open('error', 'notice', 'OpenCode reported an error',
          bodyText(typeof event.error === 'string' ? event.error : event.error?.data?.message ?? event.error?.message ?? JSON.stringify(event.error)))
      // The session was deleted, or OpenCode quit and BMN's plugin left with it (tui.exit, Story 93.3): nothing it asked
      // can be answered from the phone any more.
      case 'session.deleted':
      case 'tui.exit': return withdraw('permission', 'question', 'turn', 'error', 'subagent-permission', 'subagent-question')
      case 'session.created':
      case 'tui.session.select': {
        const observation = conversationObservation(agent, {
          session_id: id, source: event.hook_event_name === 'session.created' ? 'startup' : 'resume'
        })
        // Another conversation in this terminal: the last one's requests can no longer be answered from the phone.
        const withdrawals = withdraw('permission', 'question', 'turn', 'error', 'subagent-permission', 'subagent-question')
        return observation ? [...withdrawals, observation] : withdrawals
      }
      default: return []
    }
  }
  switch (event.hook_event_name) {
    case 'PreToolUse': {
      if (agent === 'claude' && event.tool_name === 'AskUserQuestion') {
        const summary = userInputSummary(name, event.tool_input)
        return open('question', 'question', summary.title, summary.body,
          questionsPrompt('claude', event.tool_input, { toolUseId: event.tool_use_id }))
      }
      if (agent !== 'codex' || !userInputTool(event.tool_name)) return []
      const summary = userInputSummary(name, event.tool_input)
      return open('question', 'question', summary.title, summary.body, questionsPrompt('codex', event.tool_input,
        { toolUseId: event.tool_use_id }, asyncUserInputTool(event.tool_name) ? 'async-choice' : undefined))
    }
    case 'Notification': {
      const type = event.notification_type
      if (type === 'permission_prompt' || type === 'worker_permission_prompt' ||
        (type === undefined && typeof event.message === 'string' && /permission/i.test(event.message))) {
        return open('permission', 'permission', titleText(event.message, `${name} needs your permission`))
      }
      if (type === 'elicitation_dialog' || type === 'elicitation_url_dialog' || type === 'agent_needs_input') {
        return open('question', 'question', titleText(event.message, `${name} has a question`))
      }
      // idle_prompt repeats a finished turn, which Stop already reported.
      return []
    }
    case 'PermissionRequest':
      // Claude asks permission to show its own question dialog; that is the question, not a permission.
      if (agent === 'claude' && event.tool_name === 'AskUserQuestion') {
        const summary = userInputSummary(name, event.tool_input)
        return open('question', 'question', summary.title, summary.body, questionsPrompt('claude', event.tool_input, {}))
      }
      return open(
        'permission',
        'permission',
        titleText(`${name} wants to use ${titleText(event.tool_name, 'a tool')}`, `${name} needs your permission`),
        bodyText(toolSummary(event.tool_input)),
        // Codex permissions stay plain: its PermissionRequest fires before Auto Review decides.
        agent === 'claude'
          ? permissionPrompt('claude', 'permission', event.tool_name, claudeApproval(event.tool_name, event.tool_input), { toolUseId: event.tool_use_id, requestRef: permissionRef },
            event.cwd, isObject(event.tool_input) ? event.tool_input.description ?? null : null)
          : undefined
      )
    case 'PostToolUseFailure':
    case 'PostToolUse':
      // Claude reports a failed tool separately; it still completed and answered its prompt.
      if (event.hook_event_name === 'PostToolUseFailure' && agent !== 'claude') return []
      // The async question has only been queued when this tool finishes; the owner has not answered it yet.
      if (agent === 'codex' && asyncUserInputTool(event.tool_name)) return withdraw('turn')
      // Later Codex tools may finish while that queued question is still waiting for its owner.
      if (agent === 'codex') {
        if (userInputTool(event.tool_name)) {
          return [...proven(answered('permission', 'question'), codexEvidence(event)), ...withdraw('turn')]
        }
        return [...answered('permission'), ...withdraw('turn')]
      }
      // A tool ran, so any prompt was answered, and a turn a Stop hook sent back to work is running again.
      return [...proven(answered('permission', 'question'), claudeEvidence(event)), ...withdraw('turn')]
    case 'UserPromptSubmit':
      return [...answered('permission', 'question'), ...withdraw('turn')]
    case 'Stop': {
      // Codex can finish the turn that queued an async question before the owner answers it.
      const promptSlots = agent === 'codex' ? ['permission'] : ['permission', 'question']
      // A turn that ends while work is still in flight is a progress update, not a wait for the owner.
      if (resumesByItself(event)) return withdraw(...promptSlots, 'turn')
      return [
        ...withdraw(...promptSlots),
        ...open('turn', 'notice', `${name} finished its turn`, bodyText(event.last_assistant_message))
      ]
    }
    case 'SessionStart': {
      // Compaction keeps the same conversation and the same open requests.
      if (event.source === 'compact') return []
      const observation = conversationObservation(agent, event)
      // Ownership invalidates older controls. Separate generic withdrawals can race a new same-ID question.
      return observation ? [observation] : []
    }
    case 'SessionEnd':
      return withdraw('permission', 'question', 'turn')
    case 'Interrupt':
      return withdraw('permission', 'question')
    default:
      return []
  }
}

/** An OpenCode event from a subagent's session rather than the one the plugin pinned for the owner. */
function openCodeSubagent(event) {
  const id = event.sessionID ?? event.info?.id
  const first = process.env.BMN_OPENCODE_SESSION_ID
  return Boolean(event.info?.parentID || (first && id && id !== first))
}

/**
 * The hook file each agent reads, and the events BMN expects to find wired in it. `hooks check`
 * reports exactly this list and `hooks install` writes exactly these entries; a unit test drives
 * `bmn hook <agent>` with every listed event and fails when one of them no longer does anything,
 * so the list cannot drift away from what `hookRequests` handles.
 * `optional` events are reported but never installed: Codex fires `PermissionRequest` before Auto
 * Review decides whether the owner is needed, so it belongs only in a file without Auto Review.
 * Codex's `PostCompact` only adds its manual `/compact` to the compaction record (Story 36.1): an
 * automatic compaction already arrives as `SessionStart` with source `compact`.
 */
const HOOK_FILES = {
  claude: {
    path: ['.claude', 'settings.json'],
    events: ['Notification', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd'],
    optional: [],
    // BMN needs PreToolUse for the question dialog and, since Story 83.4, for the command guard on Bash; it blocks
    // every tool until it returns, so the entry is gated to those two. Measured on 2.1.302 (Story 83.1): the matcher
    // `AskUserQuestion|Bash` fires for both. An ungated entry still counts, since it covers both too.
    matchers: { PreToolUse: 'AskUserQuestion|Bash' },
    // BMN's own group from before the guard: it still runs for the question, so it counts as an older wording, and
    // `hooks install` (and BMN's start) widen its matcher in place.
    olderMatchers: { PreToolUse: ['AskUserQuestion'] },
// Measured against the real CLI, firing a PostToolUse hook on a real tool call: a matcher,
    // group or entry Claude Code cannot use kills that group and nothing else - a sibling group in
    // the same event still fired, and so did another event's. So BMN never refuses a Claude file
    // over a shape; a group it cannot read is simply one it will not answer for.
    // Measured, one entry at a time, against a real tool call: `timeout` of `"5"`, `-1`, `null`
    // and `0` each stopped the entry running, while `1` and `1.5` ran and an absent timeout ran.
    // So Claude Code wants a positive number, and an entry without one is dead however its
    // command reads.
    timeout: 'positive-number',
    // Measured the same way. Only an absent matcher and an empty one fired. `null`, `["Bash"]` and
    // `42` each did not - so `null` is not absence here, whatever Codex's serde makes of it, and a
    // list is not a matcher Claude Code honours either.
    ungated: ['absent', 'empty']
  },
  codex: {
    path: ['.codex', 'hooks.json'],
    events: ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Interrupt'],
    optional: ['PermissionRequest', 'PostCompact'],
    // Codex declares `Option<u64>`, so a whole number at or above zero is the closest cheap rule.
    // BMN does not police the rest of somebody else's schema. This can be wrong either way: too
    // strict costs the owner a duplicate entry, too loose calls an entry wired that Codex will not
    // load - which is why every Codex report closes by saying BMN does not check that it loads.
    timeout: 'whole-non-negative-number',
    ungated: ['absent', 'null', 'empty']
  }
}

/** The entry docs/agent-control.md documents, and the only one `hooks install` ever writes. */
const HOOK_ENTRY_TIMEOUT = 5

/**
 * The file that harness actually reads. Both harnesses let the owner move their config directory,
 * and BMN follows them there rather than writing a file the harness will never look at.
 */
function hookFilePath(agent) {
  if (agent === 'opencode') {
    // OpenCode 2's terminal reads cli.json from this folder, and loads a local plugin only as a folder
    // named there, from that folder's tui.ts (2.0.28 skips an entry that is a file).
    const config = process.env.OPENCODE_CONFIG_DIR || `${process.env.XDG_CONFIG_HOME || `${homedir()}/.config`}/opencode`
    return `${absoluteUncollapsed(config)}/bmn/tui.ts`
  }
  const [directory, ...rest] = HOOK_FILES[agent].path
  const moved = agent === 'claude' ? process.env.CLAUDE_CONFIG_DIR : agent === 'codex' ? process.env.CODEX_HOME : undefined
  // The owner's own home can hold a `..` as easily as a directory they moved the config to.
  return `${absoluteUncollapsed(moved || `${homedir()}/${directory}`)}/${rest.join('/')}`
}

function hookEntryCommand(agent) {
  return `[ -n "$BMN_CONTROL_SOCKET" ] && command -v bmn >/dev/null && bmn hook ${agent}; exit 0`
}

function hookEntry(agent, event) {
  return { type: 'command', timeout: hookEntryTimeout(agent, event), command: hookEntryCommand(agent) }
}

/**
 * The events whose entry BMN wrote (or would recognise as its own) carries a timeout below the one BMN writes now:
 * Epic 78 raised Claude's permission entry from 5 s, and an entry left at 5 s would cut the phone's wait short.
 * Only BMN's own recognised command in an ungated group counts; the owner's entries are never touched.
 */
function shortTimeouts(agent, data) {
  if (!isObject(data) || !isObject(data.hooks)) return []
  const short = []
  for (const event of HOOK_FILES[agent]?.events ?? []) {
    const wanted = hookEntryTimeout(agent, event)
    // Only a timeout above the ordinary one is raised; Codex's shorter caps never touch an existing entry.
    if (wanted <= HOOK_ENTRY_TIMEOUT || !Array.isArray(data.hooks[event])) continue
    const ours = data.hooks[event].flatMap((group) => isObject(group) && !gatesEvent(group.matcher, agent, event) && Array.isArray(group.hooks) ? group.hooks : [])
      .filter((entry) => isObject(entry) && entry.type === 'command' && ['wired', 'older'].includes(hookEntryState(entry.command, agent)))
    if (ours.some((entry) => typeof entry.timeout === 'number' && entry.timeout > 0 && entry.timeout < wanted)) short.push(event)
  }
  return short
}

/** `data` with BMN's own entries for `events` given the timeout BMN writes now; every other byte of meaning kept. */
function raiseTimeouts(agent, data, events) {
  if (events.length === 0) return data
  const hooks = { ...data.hooks }
  for (const event of events) {
    const wanted = hookEntryTimeout(agent, event)
    hooks[event] = hooks[event].map((group) => !isObject(group) || gatesEvent(group.matcher, agent, event) || !Array.isArray(group.hooks) ? group : {
      ...group,
      hooks: group.hooks.map((entry) => isObject(entry) && entry.type === 'command' && ['wired', 'older'].includes(hookEntryState(entry.command, agent)) &&
        typeof entry.timeout === 'number' && entry.timeout > 0 && entry.timeout < wanted ? { ...entry, timeout: wanted } : entry)
    })
  }
  return { ...data, hooks }
}

/** Whether this is the matcher BMN's own group carried for this event before the current one (Story 83.4). */
function olderMatcher(matcher, agent, event) {
  return typeof matcher === 'string' && (HOOK_FILES[agent]?.olderMatchers?.[event] ?? []).includes(matcher)
}

/** A group holding only BMN's own recognised entries, so changing its matcher changes no one else's hook. */
function onlyOurs(group, agent) {
  return Array.isArray(group.hooks) && group.hooks.length > 0 &&
    group.hooks.every((entry) => isObject(entry) && entry.type === 'command' && ['wired', 'older'].includes(hookEntryState(entry.command, agent)))
}

/** The events whose BMN-only group still carries an older matcher (Story 83.4: Claude's PreToolUse before Bash). */
function olderMatchers(agent, data) {
  if (!isObject(data) || !isObject(data.hooks)) return []
  return Object.keys(HOOK_FILES[agent]?.olderMatchers ?? {}).filter((event) => Array.isArray(data.hooks[event]) &&
    data.hooks[event].some((group) => isObject(group) && olderMatcher(group.matcher, agent, event) && onlyOurs(group, agent)))
}

/** `data` with those groups given the matcher BMN writes now; every other group and byte of meaning kept. */
function widenMatchers(agent, data, events) {
  if (events.length === 0) return data
  const hooks = { ...data.hooks }
  for (const event of events) {
    hooks[event] = hooks[event].map((group) => isObject(group) && olderMatcher(group.matcher, agent, event) && onlyOurs(group, agent)
      ? { ...group, matcher: HOOK_FILES[agent].matchers[event] } : group)
  }
  return { ...data, hooks }
}

/** Codex 0.163.0 clamps these to 3 s and warns at every start for a longer entry (Story 79.6's clean run). */
const CODEX_SHORT_EVENTS = new Set(['SessionEnd', 'Interrupt'])

/** The timeout BMN writes for one event's entry: Claude's permission hook waits for the phone (Epic 78). */
function hookEntryTimeout(agent, event) {
  if (agent === 'codex' && CODEX_SHORT_EVENTS.has(event)) return 3
  return agent === 'claude' && event === 'PermissionRequest' ? PERMISSION_HOOK_TIMEOUT : HOOK_ENTRY_TIMEOUT
}

/**
 * BMN recognises its own hook entry by what it is, not by reading the shell it is written in: a
 * command wrongly read as wired leaves the owner with no hook and no warning.
 *
 * So an entry counts only when it is one BMN itself writes, the earlier wording of one, or the bare
 * call. Anything else reads as missing - and when it mentions `bmn hook <agent>`, `check` prints it,
 * so a hand-written entry is never silently passed over either. `install` adds beside it and never
 * removes or rewrites it, so the cost is a duplicate; the benefit is that no command can be read
 * wrongly, because none is being read.
 *
 * It reports what is *configured*, which is not the same as what will run: the entry BMN writes is
 * itself guarded and does nothing while BMN is not running. That distinction is in the docs.
 */
function recognisedEntries(agent) {
  const documented = hookEntryCommand(agent)
  return [
    documented,
    // The owner's own files predate Epic 13's rename, and `bmn hook` still reads the older name.
    documented.replace('$BMN_CONTROL_SOCKET', '$AITERM_CONTROL_SOCKET'),
    // The call with nothing around it, which is what someone writes who wants it to run always.
    `bmn hook ${agent}`
  ]
}

/**
 * Which of the three an entry is, compared whole after trimming and never parsed: `wired` for the
 * documented command, `older` for the other two, and `named` for a command that merely mentions
 * `bmn hook <agent>`. A `named` entry counts as missing - BMN will not say a command it does not
 * read works - but `check` shows it, because it is the one the owner needs to look at.
 */
function hookEntryState(command, agent) {
  // Reachable for a lenient harness, whose file is read rather than refused over a bad entry.
  if (typeof command !== 'string') return 'missing'
  const text = command.replace(SHELL_BLANKS, '')
  if (text === hookEntryCommand(agent)) return 'wired'
  if (recognisedEntries(agent).includes(text)) return 'older'
  // The note is for the owner to read, not a verdict, so it may look past any whitespace at all.
  return namesHook(command, agent) ? 'named' : 'missing'
}

/**
 * The only whitespace bash separates words with. JavaScript's own `trim` also removes a
 * non-breaking space, a byte-order mark, a carriage return, a vertical tab and every other Unicode
 * space - none of which bash does. Each of those stays part of the first or last word, so
 * `<NBSP>bmn hook claude` runs a program named `<NBSP>bmn`, which does not exist, and reports
 * nothing. Trimming them would call that entry wired: the exact outcome this command exists to
 * prevent, and a plausible one, since a pasted entry is where a non-breaking space comes from.
 */
const SHELL_BLANKS = /^[ \t\n]+|[ \t\n]+$/g

/** The command as a person reads it, for deciding whether an entry is worth showing the owner. */
function collapsed(command) {
  // Whitespace, and every character a reader cannot see, become one space. This decides only
  // whether the owner is shown the entry at all, so it is deliberately generous: `bmn\u034fhook`
  // reads as two words to a person and must not slip past unmentioned. The line printed afterwards
  // shows the command exactly, character for character.
  return command.replace(/[\p{C}\p{Z}\p{M}\s]+/gu, ' ').trim()
}

/**
 * One event's state, and any command registered for it that names the hook without being an entry
 * BMN recognises. A recognised entry settles the event; the named ones are carried out so that
 * `check` can print them beside it.
 */
function hookEventState(listed, agent, event) {
  if (!Array.isArray(listed)) return { state: 'missing', unrecognised: [], gated: [] }
  const groups = listed
  let older = false
  const unrecognised = []
  const gatedEntries = []
  // Only Codex's timeout rule names its reason; a Claude or OpenCode report stays as it was.
  const wholeSeconds = HOOK_FILES[agent].timeout === 'whole-non-negative-number'
  let droppedTimeout = false
  for (const group of groups) {
    if (!isObject(group)) continue
    // BMN does not read matchers, so it does not answer for an entry inside one. What counts as
    // "no matcher" is the harness's business and differs between them: Claude Code fires only for
    // an absent or empty matcher, while Codex's `Option<String>` makes `null` absence too. Every
    // other shape gates, including a whitespace-only pattern, which matches no tool name.
    //
    // Refusing a gated group is a recognition policy, not a claim about delivery: a harness may
    // ignore the matcher on some events (Codex does on `Stop`, `UserPromptSubmit` and `Interrupt`),
    // in which case the entry `install` adds beside it is a duplicate rather than the only one
    // that works.
    const gated = gatesEvent(group.matcher, agent, event)
    const entries = Array.isArray(group.hooks) ? group.hooks : []
    for (const entry of entries) {
      // Only a command entry runs anything; another hook type that names bmn still never calls it.
      if (!isObject(entry) || entry.type !== 'command') continue
      // An entry the harness will not run is not an entry BMN can answer for. It still names the
      // hook, so the owner is shown it rather than left with an unexplained duplicate.
      const recognition = hookEntryState(entry.command, agent)
      const runnable = runnableEntry(entry, agent)
      const read = runnable ? recognition : (namesHook(entry.command, agent) ? 'named' : 'missing')
      if (gated && olderMatcher(group.matcher, agent, event) && (read === 'wired' || read === 'older')) {
        older = true
        continue
      }
      if (gated && read !== 'missing') {
        gatedEntries.push(entry.command)
        continue
      }
      // One of BMN's own entries, kept from wiring by its timeout alone: say why beside the verdict.
      if (wholeSeconds && (recognition === 'wired' || recognition === 'older') && !runnable) droppedTimeout = true
      // Nothing is missing for this event, so there is nothing for the owner to look at.
      if (read === 'wired') return { state: 'wired', unrecognised: [], gated: [] }
      if (read === 'older') older = true
      if (read === 'named') unrecognised.push(entry.command)
    }
  }
  if (older) return { state: 'wired (older wording)', unrecognised: [], gated: [] }
  return {
    state: 'missing',
    unrecognised,
    gated: gatedEntries,
    ...(droppedTimeout ? { reason: TIMEOUT_NOT_WHOLE_SECONDS } : {})
  }
}

/**
 * A hook file as the commands see it: its text, its parsed object and why it could not be used.
 * A file BMN cannot merge into safely - `hooks` that is not an object, an event that is not a list
 * of groups - is `unusable`, never something to overwrite: it is somebody's configuration.
 */
function readHookFile(path, agent) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return { state: 'missing', text: '', data: {} }
    return { state: 'unreadable', detail: error.code ?? 'read failed', text: '', data: {} }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    return { state: 'unparsable', detail: error.message, text, data: {} }
  }
  if (!isObject(data)) return { state: 'unparsable', detail: 'the file is not a JSON object', text, data: {} }
  const unusable = unusableShape(data, agent)
  if (unusable !== undefined) return { state: 'unusable', detail: unusable, text, data }
  return { state: 'read', text, data }
}

/**
 * The one shape rule, and it is about merging rather than about the harness: `hooks` and each
 * expected event must be shapes BMN can add a group to without removing anything. What the harness
 * makes of the rest of the file is the harness's business - `check` reports what is configured,
 * not that a hook fired (`epics.md:787`), and every Codex report says so in as many words.
 */
function unusableShape(data, agent) {
  if (data.hooks !== undefined && !isObject(data.hooks)) return '"hooks" is not an object'
  if (!isObject(data.hooks)) return undefined
  const spec = HOOK_FILES[agent]
  for (const event of [...spec.events, ...spec.optional]) {
    const groups = data.hooks[event]
    if (groups !== undefined && !Array.isArray(groups)) return `"hooks.${event}" is not a list`
  }
  return undefined
}

/**
 * Whether the harness would run this entry at all. An entry it drops cannot report, so it must
 * never read as wired - that is the same false `wired` this command exists to prevent, arriving
 * through a field rather than through the command.
 */
function namesHook(command, agent) {
  return typeof command === 'string' && collapsed(command).includes(`bmn hook ${agent}`)
}

function runnableEntry(entry, agent) {
  const timeout = entry.timeout
  if (timeout === undefined) return true
  if (HOOK_FILES[agent].timeout === 'positive-number') return typeof timeout === 'number' && timeout > 0
  // Codex reads `Option<u64>` seconds: `null` is absence, and a whole number is accepted up to the
  // largest one a JSON number holds exactly.
  return timeout === null || (Number.isSafeInteger(timeout) && timeout >= 0)
}

/** Why one of BMN's own Codex entries does not count; printed beside the verdict and kept as `reason` in `--json`. */
const TIMEOUT_NOT_WHOLE_SECONDS = 'timeout is not a whole number of seconds'

/**
 * Whether this matcher leaves its group gated, by what the harness in question treats as absence. The one
 * matcher BMN itself writes for an event (`matchers`) is not a gate: it is exactly the part BMN needs.
 */
function gatesEvent(matcher, agent, event) {
  if (event !== undefined && HOOK_FILES[agent].matchers?.[event] !== undefined && matcher === HOOK_FILES[agent].matchers[event]) return false
  const ungated = HOOK_FILES[agent].ungated
  if (matcher === undefined) return !ungated.includes('absent')
  if (matcher === null) return !ungated.includes('null')
  if (matcher === '') return !ungated.includes('empty')
  return true
}

/** One agent's report, from one already-read snapshot so a check and an install cannot disagree. */
function checkHooks(agent, path, file = agent === 'opencode' ? undefined : readHookFile(path, agent)) {
  if (agent === 'opencode') return checkOpenCodePlugin(path)
  const spec = HOOK_FILES[agent]
  const hooks = isObject(file.data.hooks) ? file.data.hooks : {}
  const events = [...spec.events, ...spec.optional].map((event) => {
    // An unusable file says nothing about any event, so nothing is reported as wired.
    const read = file.state === 'read'
      ? hookEventState(hooks[event], agent, event)
      : { state: 'missing', unrecognised: [], gated: [] }
    return {
      event,
      optional: spec.optional.includes(event),
      state: read.state,
      ...(read.unrecognised.length === 0 ? {} : { unrecognised: read.unrecognised }),
      ...(read.gated.length === 0 ? {} : { gated: read.gated }),
      ...(read.reason === undefined ? {} : { reason: read.reason })
    }
  })
  const missing = events.filter((row) => !row.optional && row.state === 'missing').map((row) => row.event)
  return { agent, file: path, state: file.state, ...(file.detail === undefined ? {} : { detail: file.detail }), events, missing }
}

/** The documented entry added for each missing event, beside the hooks already registered for it. */
function installHooks(agent, data, missing) {
  const next = { ...data, hooks: isObject(data.hooks) ? { ...data.hooks } : {} }
  for (const event of missing) {
    const groups = Array.isArray(next.hooks[event]) ? [...next.hooks[event]] : []
    // Appended as its own group: an existing group carries a matcher this entry must not inherit.
    const matcher = HOOK_FILES[agent].matchers?.[event]
    groups.push({ ...(matcher === undefined ? {} : { matcher }), hooks: [hookEntry(agent, event)] })
    next.hooks[event] = groups
  }
  return next
}

/** Setup adds only absent groups: no legacy timeout raising or matcher widening. */
export function setupHookGroups(agent, text) {
  if (!HOOK_FILES[agent]) throw new CliError('INVALID_ARGUMENT', 'setup hook groups require Claude Code or Codex')
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1024 * 1024 || rewrittenNumbers(text).length > 0) throw new CliError('REVISION_CONFLICT', 'the hooks file cannot be rewritten without changing an existing value')
  let data
  try { data = text.trim() === '' ? {} : JSON.parse(text) } catch { throw new CliError('REVISION_CONFLICT', 'the hooks file is not a JSON object') }
  if (!isObject(data) || unusableShape(data, agent)) throw new CliError('REVISION_CONFLICT', 'the hooks file has a shape setup leaves as it is')
  const verdicts = absentVerdicts(agent, checkHooks(agent, '', { state: 'read', text, data }))
  return { data, absent: verdicts.absent, left: verdicts.left, placed: verdicts.placed,
    groups: Object.fromEntries(HOOK_FILES[agent].events.map(event => [event, installHooks(agent, {}, [event]).hooks[event][0]])) }
}


/** Epic 71: an agent BMN retired is named as retired, with where its support is kept, in place of `words`. */
async function retiredOr(agent, words) {
  const roster = await import('./agents-roster.mjs').catch(() => null)
  return roster === null ? words : roster.appRefusal(agent, words)
}

async function hookAgentsFor(agent) {
  if (agent === undefined) return Object.keys(HOOK_AGENTS)
  if (!Object.hasOwn(HOOK_AGENTS, agent)) throw new UsageError(await retiredOr(agent, `hooks expects one agent: ${Object.keys(HOOK_AGENTS).join('|')}`))
  return [agent]
}

function describeHookCheck(report) {
  const lines = [`${HOOK_AGENTS[report.agent]}  ${report.file}`]
  if (report.state === 'missing') lines.push('  the file does not exist; every event is missing')
  if (report.state === 'unreadable') lines.push(`  cannot read the file (${report.detail})`)
  if (report.state === 'unparsable') lines.push(`  the file is not valid JSON (${report.detail})`)
  if (report.state === 'unusable') lines.push(`  BMN cannot add to this file: ${report.detail}`)
  for (const row of report.events) {
    const optional = row.optional ? ' (optional)' : ''
    const reason = row.reason === undefined ? '' : `  ${row.reason}`
    lines.push(`  ${row.event.padEnd(19)}${row.state}${optional}${reason}`)
    // Not a command BMN recognises, so it reads as missing; show it rather than leave the owner
    // wondering where the duplicate `install` is about to add came from. JSON quoting shows the
    // command exactly: control characters are escaped and nothing is folded away.
    for (const command of row.unrecognised ?? []) {
      lines.push(`    an entry here names bmn hook ${report.agent} but is not one BMN recognises:`)
      lines.push(`      ${JSON.stringify(command)}`)
    }
    // An entry BMN would otherwise answer for, sitting inside a matcher. Saying it is "not one BMN
    // recognises" would be self-contradictory: it is, and the matcher is the whole reason.
    for (const command of row.gated ?? []) {
      lines.push('    an entry here is inside a matcher, so it wires only part of this event:')
      lines.push(`      ${JSON.stringify(command)}`)
    }
  }
  // The limit is the same whatever the file said, so it is printed unconditionally rather than as
  // a verdict BMN has no evidence for: Codex loads its hook file strictly and BMN does not check
  // that it will, and a hook it has never trusted does not run however it is written.
  if (report.agent === 'codex') {
    lines.push('  Codex loads this file strictly and BMN does not check that it will, and hooks')
    lines.push('  run only once trusted: run /hooks in Codex, then confirm the event appears.')
  }
  return lines.join('\n')
}

/**
 * `hooks check` and `hooks install` are owner commands: they read and write the owner's own hook
 * files and never touch the control socket, so they work before BMN is running and say what is
 * *configured*, never whether a hook has fired.
 */
async function runHooks(argv) {
  let parsed
  try {
    parsed = parseArguments(argv)
  } catch (error) {
    if (error instanceof UsageError) return usageFailure(error.message)
    throw error
  }
  const [action, agent, ...rest] = parsed.positionals
  try {
    for (const name of Object.keys(parsed.options)) {
      if (!['json', 'file', 'help', 'yes', 'absent'].includes(name)) throw new UsageError(`hooks does not accept --${name}`)
    }
    if (parsed.options.help || action === undefined) {
      process.stdout.write(`${HOOKS_USAGE}\n`)
      return parsed.options.help ? 0 : 2
    }
    if (action === 'print') {
      if (agent !== 'opencode' || rest.length || parsed.options.file || parsed.options.json || parsed.options.yes) throw new UsageError('hooks print expects opencode without options')
      writeSync(1, OPENCODE_PLUGIN)
      return 0
    }
    if (!['check', 'install'].includes(action)) throw new UsageError(`hooks expects check or install, not ${action}`)
    if (action !== 'install' && parsed.options.yes) throw new UsageError('--yes is only for hooks install')
    if (action !== 'install' && parsed.options.absent) throw new UsageError('--absent is only for hooks install')
    if (parsed.options.absent && !parsed.options.yes) throw new UsageError('hooks install --absent writes without asking: it needs --yes')
    if (rest.length > 0) throw new UsageError(`hooks ${action} takes at most one agent`)
    if (action === 'install' && agent === undefined && !parsed.options.absent) throw new UsageError('hooks install expects one agent')
    if (parsed.options.file !== undefined && agent === undefined) {
      throw new UsageError('--file needs the agent whose file it is')
    }
    const agents = await hookAgentsFor(agent)
    const pathFor = (name) => parsed.options.file === undefined
      ? hookFilePath(name)
      : absoluteUncollapsed(parsed.options.file)
    if (action === 'install' && parsed.options.absent) return await installAbsentCommand(agents, pathFor, parsed.options.json === true)
    return action === 'check'
      ? await checkHooksCommand(agents, pathFor, parsed.options.json === true)
      : await installHooksCommand(agents[0], pathFor(agents[0]), parsed.options.json === true, parsed.options.yes === true)
  } catch (error) {
    if (error instanceof UsageError) return usageFailure(error.message)
    throw error
  }
}

async function checkHooksCommand(agents, pathFor, asJson) {
  const reports = agents.map((name) => checkHooks(name, pathFor(name)))
  const ok = reports.every((report) => report.state === 'read' && report.missing.length === 0)
  // Story 60.8: what the prompt guard does in each app right now, read from the approved team on disk.
  let guard = null
  try {
    guard = await import('./agents-guard.mjs')
  } catch {
    // Without its files there is no guard to describe.
  }
  const standing = new Map(guard === null ? [] : reports.map((report) => [report.agent, guard.guardStanding(report.agent)]))
  // Epic 66.4: whether this app's hook hands a waiting message to its agent, and on which version that was measured.
  const messages = new Map(guard === null ? [] : reports.map((report) => [report.agent, guard.messageStanding(report.agent)]))
  // Epic 69: whether this app's turns are recorded, and on which version waiting for the prompt hook was measured.
  const marks = await import('./turn-marks.mjs').catch(() => null)
  const turns = new Map(marks === null ? [] : reports.map((report) => [report.agent, marks.turnStanding(report.agent)]))
  const more = (report) => ({ ...(standing.has(report.agent) ? { guard: standing.get(report.agent), messages: messages.get(report.agent) } : {}), ...(turns.has(report.agent) ? { turnChanges: turns.get(report.agent) } : {}) })
  if (asJson) {
    // This owner command finishes synchronously; a pipe can lose an asynchronous stdout write
    // before the CLI exits. The desktop checker reads that pipe, so finish the report first.
    writeSync(1, `${JSON.stringify({ ok, agents: reports.map((report) => ({ ...report, ...more(report) })) }, null, 2)}\n`)
    return ok ? 0 : 1
  }
  const lines = reports.map((report) => `${describeHookCheck(report)}${Object.values(more(report)).map((line) => `\n  ${line}`).join('')}`)
  lines.push(ok
    ? 'Every hook BMN expects is wired. This is what is configured, not proof that a hook fired.'
    : 'Run `bmn hooks install <agent>` to add the missing entries. This reports configuration, not that a hook fired.')
  process.stdout.write(`${lines.join('\n\n')}\n`)
  return ok ? 0 : 1
}

/**
 * OpenCode 2 loads a terminal plugin only when cli.json names its folder in "plugins", and reads the
 * folder's tui.ts; OpenCode 1's server plugin lived in plugin/ or plugins/, where OpenCode 2 refuses to
 * load it (2.0.28). `path` is the tui.ts: its folder is the entry, and the folder above holds cli.json.
 */
function openCodeFiles(path) {
  const entry = dirname(path)
  const config = dirname(entry)
  return { entry, cli: `${config}/cli.json`, older: ['plugin', 'plugins'].map((folder) => `${config}/${folder}/bmn.ts`) }
}

/** BMN's own plugin text, from any release, as its comments say: true of a copy someone edited too. */
function openCodeBMNText(text) {
  return text !== null && text.includes('// Shipped by BMN') && text.includes('bmn hook opencode')
}

/**
 * The terminal plugin file's bytes and the file they were read from, through one descriptor, or null when it is
 * absent. What it holds for BMN (Story 96.3): `current`, `earlier` (byte for byte a plugin BMN shipped before, which
 * only BMN wrote), `edited` (BMN's comments, other bytes) or `foreign`; only an earlier one is BMN's to upgrade.
 */
function readOpenCodePlugin(path) {
  let fd
  try { fd = openSync(path, constants.O_RDONLY) } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try {
    const stat = fstatSync(fd)
    const bytes = readFileSync(fd)
    const text = bytes.toString('utf8')
    const earlier = EARLIER_OPENCODE_PLUGINS[createHash('sha256').update(bytes).digest('hex')]
    const state = text === OPENCODE_PLUGIN ? 'current' : earlier?.kind === 'terminal' ? 'earlier' : openCodeBMNText(text) ? 'edited' : 'foreign'
    return { bytes, text, identity: `${stat.dev}:${stat.ino}`, state }
  } finally {
    closeSync(fd)
  }
}

/** cli.json as BMN can add to it: its text, its data and the plugins it names, or why it cannot. */
function readOpenCodeCli(path) {
  let text
  try { text = currentText(path) } catch (error) {
    return { state: 'unreadable', reason: `cannot read ${path} (${error.code ?? error.message})` }
  }
  if (text === null) return { state: 'missing', text: null, data: {}, plugins: [] }
  let data
  try { data = JSON.parse(text) } catch (error) {
    return { state: 'unparsable', reason: `${path} is not valid JSON (${error.message}); BMN leaves it untouched` }
  }
  if (!isObject(data)) return { state: 'unusable', reason: `${path} does not hold a JSON object; BMN leaves it untouched` }
  if (data.plugins !== undefined && !Array.isArray(data.plugins)) {
    return { state: 'unusable', reason: `"plugins" in ${path} is not a list; BMN leaves it untouched` }
  }
  return { state: 'read', text, data, plugins: data.plugins ?? [] }
}

/** The older plugin files that are BMN's own; anything else in their place is the owner's and stays. */
function olderOpenCodePlugins(path) {
  return openCodeFiles(path).older.flatMap((file) => {
    try {
      const text = currentText(file)
      return openCodeBMNText(text) ? [{ file, text }] : []
    } catch {
      return []
    }
  })
}

function checkOpenCodePlugin(path) {
  let text
  try { text = currentText(path) } catch (error) {
    return { agent: 'opencode', file: path, state: 'unreadable', detail: error.code, events: [], missing: ['plugin', 'cli.json'] }
  }
  const older = olderOpenCodePlugins(path)
  // Story 96.3: only BMN's current plugin or one it shipped earlier, byte for byte, is BMN's; an edited copy is not.
  let found
  try { found = readOpenCodePlugin(path)?.state ?? 'missing' } catch { found = 'missing' }
  // OpenCode 2 refuses OpenCode 1's plugin at every start, so while it stays the plugin needs a reinstall.
  const plugin = found === 'current' && older.length === 0 ? 'wired' : ['current', 'earlier'].includes(found) ? 'wired (older wording)' : 'missing'
  const reasons = [
    ...(found === 'earlier' ? ['an earlier release of BMN\'s plugin; BMN upgrades it at its next start'] : []),
    ...(found === 'edited' ? ['a copy of BMN\'s plugin edited since BMN wrote it; BMN leaves it as it is, and install replaces it'] : []),
    ...(older.length === 0 ? [] : [`OpenCode 1's plugin is still at ${older.map((entry) => entry.file).join(', ')}; install removes it`])
  ]
  const { entry, cli: cliPath } = openCodeFiles(path)
  const cli = readOpenCodeCli(cliPath)
  const listed = cli.state === 'read' && cli.plugins.includes(entry)
  const events = [
    { event: 'plugin', optional: false, state: plugin, ...(reasons.length === 0 ? {} : { reason: reasons.join('; ') }) },
    { event: 'cli.json', optional: false, state: listed ? 'wired' : 'missing',
      ...(cli.reason === undefined ? {} : { reason: cli.reason }) }
  ]
  return { agent: 'opencode', file: path, state: text === null ? 'missing' : 'read', events,
    missing: events.filter((row) => row.state !== 'wired').map((row) => row.event) }
}

async function confirmHookWrite(path, target, entries, diff, yes, asJson, fullReplacement = null) {
  if (yes) return true
  if (asJson || !process.stdin.isTTY || !process.stderr.isTTY) {
    writeSync(2, 'bmn: CONFIRMATION_REQUIRED: hooks install needs a TTY or explicit --yes; nothing was installed\n')
    return false
  }
  writeSync(2, `Hook file: ${path}\nResolved target: ${target}\nEntries to add or replace: ${entries.join(', ')}\nProposed diff:\n${diff}\n`)
  if (fullReplacement !== null) writeSync(2, `Proposed full file:\n${fullReplacement}\n`)
  return new Promise((resolve) => {
    const prompt = createInterface({ input: process.stdin, output: process.stderr })
    let settled = false
    const finish = (approved) => {
      if (settled) return
      settled = true
      prompt.close()
      resolve(approved)
    }
    prompt.on('close', () => finish(false))
    prompt.on('SIGINT', () => finish(false))
    prompt.question('Install these hooks? [y/N] ', (answer) => finish(/^(y|yes)$/i.test(answer.trim())))
  })
}

function confirmationResult(path, asJson) {
  if (!asJson && process.stdin.isTTY && process.stderr.isTTY) {
    writeSync(2, `bmn: nothing was installed in ${path}\n`)
    return 1
  }
  return 2
}

async function installOpenCodePlugin(path, asJson, yes) {
  const { entry, cli: cliPath } = openCodeFiles(path)
  let before
  let cli
  let older
  const targets = new Map()
  try {
    before = currentText(path)
    cli = readOpenCodeCli(cliPath)
    older = olderOpenCodePlugins(path)
    for (const file of [path, cliPath, ...older.map((old) => old.file)]) targets.set(file, linkTarget(file))
  } catch (error) {
    process.stderr.write(`bmn: ${error.code ?? 'IO_ERROR'}: ${error.message}\n`)
    return 1
  }
  if (cli.state !== 'read' && cli.state !== 'missing') {
    process.stderr.write(`bmn: ${cli.reason}; nothing was installed\n`)
    return 1
  }
  const writePlugin = before !== OPENCODE_PLUGIN
  const cliNext = cli.plugins.includes(entry) ? null
    : `${JSON.stringify({ ...cli.data, plugins: [...cli.plugins, entry] }, null, cli.text === null ? 2 : jsonIndent(cli.text))}\n`
  const installed = [...(writePlugin ? ['plugin'] : []), ...(cliNext === null ? [] : ['cli.json'])]
  if (installed.length === 0 && older.length === 0) {
    const result = { installed: [], backups: [], removed: [], file: path }
    process.stdout.write(`${asJson ? JSON.stringify(result, null, 2) : `Already wired OpenCode plugin: ${path}`}\n`)
    return 0
  }
  if (cliNext !== null && rewrittenNumbers(cli.text ?? '').length > 0) {
    process.stderr.write(`bmn: ${cliPath} holds a number BMN cannot write back unchanged; nothing was installed\n`)
    return 1
  }
  const diff = [
    ...(writePlugin ? [unifiedDiff(before ?? '', OPENCODE_PLUGIN, path)] : []),
    ...(cliNext === null ? [] : [unifiedDiff(cli.text ?? '', cliNext, cliPath)]),
    ...older.map((old) => unifiedDiff(old.text, '', old.file))
  ].join('\n')
  const entries = [...installed, ...older.map((old) => `remove ${old.file}`)]
  if (!await confirmHookWrite(path, targets.get(path), entries, diff, yes, asJson, writePlugin ? OPENCODE_PLUGIN : null)) {
    return confirmationResult(path, asJson)
  }
  return withDefaultsAdmission(async () => {
    const unchanged = (file, expected) => () => {
      assertDefaultsAdmission()
      if (linkTarget(file) !== targets.get(file)) throw new CliError('REVISION_CONFLICT', `${file} changed target while bmn was reading it; nothing more was written`)
      if (currentText(file) !== expected) throw new CliError('REVISION_CONFLICT', `${file} changed while bmn was reading it; nothing more was written`)
    }
    const stamp = new Date().toISOString()
    const backups = []
    const removed = []
    // Every file that exists is copied before it changes. The plugin goes first and the cli.json entry
    // second, so a stop between them leaves a plugin OpenCode does not load yet, never an entry naming nothing.
    const copy = (file, to) => {
      copyFileSync(file, to)
      backups.push(to)
    }
    try {
      if (writePlugin) {
        unchanged(path, before)()
        if (before !== null) copy(path, `${path}.bmn-backup-${stamp}`)
        writeAtomically(path, OPENCODE_PLUGIN, unchanged(path, before))
      }
      if (cliNext !== null) {
        unchanged(cliPath, cli.text)()
        if (cli.text !== null) copy(cliPath, `${cliPath}.bmn-backup-${stamp}`)
        writeAtomically(cliPath, cliNext, unchanged(cliPath, cli.text))
      }
      for (const old of older) {
        unchanged(old.file, old.text)()
        // Kept in BMN's own folder, outside plugin/ and plugins/, where OpenCode would try to load it.
        copy(old.file, `${entry}/${basename(dirname(old.file))}-bmn.ts.bmn-backup-${stamp}`)
        unlinkSync(old.file)
        removed.push(old.file)
      }
    } catch (error) {
      process.stderr.write(`bmn: ${error.code ?? 'IO_ERROR'}: ${error.message}\n`)
      return 1
    }
    const result = { installed, backups, removed, file: path }
    const lines = [`Installed OpenCode plugin: ${path}`, ...(installed.includes('cli.json') ? [`Named in: ${cliPath}`] : []),
      ...removed.map((file) => `Removed OpenCode 1's plugin: ${file}`), ...backups.map((file) => `Backup: ${file}`),
      'Restart OpenCode to load it. `bmn hooks check` reports configuration, not that a hook fired.']
    process.stdout.write(`${asJson ? JSON.stringify(result, null, 2) : lines.join('\n')}\n`)
    return 0
  })
}

async function installHooksCommand(agent, path, asJson, yes) {
  if (agent === 'opencode') return installOpenCodePlugin(path, asJson, yes)
  // One read: the report, the merge and the conflict check all describe the same bytes.
  const file = readHookFile(path, agent)
  if (file.state !== 'read' && file.state !== 'missing') {
    const reason = file.state === 'unparsable'
      ? `${path} is not valid JSON (${file.detail}); it was left untouched`
      : file.state === 'unusable'
        ? `${path} is not a hook file BMN can add to: ${file.detail}; it was left untouched`
        : `cannot read ${path} (${file.detail})`
    process.stderr.write(`bmn: ${reason}\n`)
    return 1
  }
  const report = checkHooks(agent, path, file)
  const raised = file.state === 'read' ? shortTimeouts(agent, file.data) : []
  const widened = file.state === 'read' ? olderMatchers(agent, file.data) : []
  if (report.missing.length === 0 && raised.length === 0 && widened.length === 0) {
    const message = `Nothing to do: every hook BMN expects is already in ${path}.`
    process.stdout.write(`${asJson ? JSON.stringify({ installed: [], backup: null, file: path }, null, 2) : message}\n`)
    return 0
  }
  // Only now, when there is a write to do. AC2 gives an already-wired file a successful no-op, and
  // a number elsewhere in it is no reason to fail that.
  const rewritten = rewrittenNumbers(file.text)
  if (rewritten.length > 0) {
    process.stderr.write(
      `bmn: ${path} holds a number BMN cannot write back unchanged (${rewritten[0]}); `
      + 'it was left untouched. Add the entry by hand, or shorten that number.\n'
    )
    return 1
  }
  const indent = jsonIndent(file.text)
  const nextText = `${JSON.stringify(installHooks(agent, widenMatchers(agent, raiseTimeouts(agent, file.data, raised), widened), report.missing), null, indent)}\n`
  let target
  try { target = linkTarget(path) } catch (error) {
    process.stderr.write(`bmn: ${error.message}\n`)
    return 1
  }
  const diff = unifiedDiff(file.text, nextText, path)
  const changes = [...report.missing, ...raised.map((event) => `${event} timeout ${hookEntryTimeout(agent, event)} s`),
    ...widened.map((event) => `${event} matcher ${HOOK_FILES[agent].matchers[event]}`)]
  if (!await confirmHookWrite(path, target, changes, diff, yes, asJson)) return confirmationResult(path, asJson)
  return withDefaultsAdmission(async () => {
    const unchanged = () => {
      holdAtTestGate()
      assertDefaultsAdmission()
      if (linkTarget(path) !== target) {
        throw new CliError('REVISION_CONFLICT', `${path} changed target while bmn was reading it; nothing was written`)
      }
      const now = currentText(path)
      if ((now ?? '') !== file.text) {
        throw new CliError('REVISION_CONFLICT', `${path} changed while bmn was reading it; nothing was written`)
      }
    }
    let backup = null
    try {
      unchanged()
      // Every file that exists is copied first, whatever BMN thinks of its shape. Keying this on one
      // state meant a file BMN could not vouch for was written over without a copy of it.
      if (file.state !== 'missing') {
        backup = `${path}.bmn-backup-${new Date().toISOString()}`
        copyFileSync(path, backup)
      }
      // Checked once more with the replacement already staged, so the window is as small as a rename.
      writeAtomically(path, nextText, unchanged)
    } catch (error) {
      if (error instanceof CliError) {
        process.stderr.write(`bmn: ${error.code}: ${error.message}\n`)
        return 1
      }
      process.stderr.write(`bmn: cannot write ${path} (${error.code ?? error.message})\n`)
      return 1
    }
    const trust = agent === 'codex'
      ? 'Codex must trust the hooks once: run /hooks in Codex. `bmn hooks check` reports configuration, not that a hook fired.'
      : '`bmn hooks check` reports configuration, not that a hook fired.'
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ installed: report.missing, ...(raised.length === 0 ? {} : { raised }), ...(widened.length === 0 ? {} : { widened }), backup, file: path, diff, note: trust }, null, 2)}\n`)
      return 0
    }
    const lines = report.missing.length === 0 ? [] : [`Added ${report.missing.length} hook ${report.missing.length === 1 ? 'entry' : 'entries'} to ${path}: ${report.missing.join(', ')}`]
    if (raised.length > 0) lines.push(`Raised BMN's own entry timeout in ${path}: ${raised.map((event) => `${event} to ${hookEntryTimeout(agent, event)} s`).join(', ')}`)
    if (widened.length > 0) lines.push(`Widened BMN's own matcher in ${path}: ${widened.map((event) => `${event} to ${HOOK_FILES[agent].matchers[event]}`).join(', ')}`)
    if (backup !== null) lines.push(`Backup: ${backup}`)
    lines.push('', diff, '', trust)
    process.stdout.write(`${lines.join('\n')}\n`)
    return 0
  })
}

// ---------------------------------------------------------------------------------------------
// Story 75.9: the entries BMN installs by itself when it starts

/** Why BMN left an event as it is: an entry of its own wording the app will not run, one inside a matcher, or one it did not write. */
const LEFT_WHY = { changed: 'changed', gated: 'gated', foreign: 'not BMN\'s' }

/** The folder an app keeps its settings in: an app that never ran here has none, and BMN creates none for it. */
function appSetUp(agent, path) {
  return existsSync(agent === 'opencode' ? dirname(openCodeFiles(path).entry) : dirname(path))
}

/**
 * One app's events as the start-up install reads them. Only an event with no entry of BMN's in any shape is
 * absent; an event carrying one BMN would not answer for - inside a matcher, in BMN's wording but with a
 * field the app will not run, or naming `bmn hook <agent>` in a wording BMN did not write - is left as it is,
 * so nothing is ever added beside it. An older wording still runs and counts as in place.
 */
function absentVerdicts(agent, report) {
  const placed = []
  const older = []
  const absent = []
  const left = []
  for (const row of report.events) {
    if (row.state === 'wired' || row.state === 'wired (older wording)') {
      placed.push(row.event)
      if (row.state !== 'wired') older.push(row.event)
    } else if ((row.gated ?? []).length > 0) {
      left.push({ event: row.event, why: 'gated' })
    } else if ((row.unrecognised ?? []).length > 0) {
      const ours = row.unrecognised.some((command) => ['wired', 'older'].includes(hookEntryState(command, agent)))
      left.push({ event: row.event, why: ours ? 'changed' : 'foreign' })
    } else if (!row.optional) {
      absent.push(row.event)
    }
  }
  return { placed, older, absent, left }
}

/** What the start-up install found for a file it could not add to, by the file's state. */
function unusableFile(file, path) {
  if (file.state === 'unreadable') return { why: 'unreadable', detail: `cannot read ${path} (${file.detail})` }
  if (file.state === 'unparsable') return { why: 'unparsable', detail: `${path} is not valid JSON (${file.detail})` }
  return { why: 'unusable', detail: `${path} is not a hook file BMN can add to: ${file.detail}` }
}

/**
 * Writes one hook file BMN read as `before`: a copy first when the file exists, then the replacement staged
 * and checked once more against the bytes and the link that were read. Returns the backup's path, if any.
 */
function writeHookFile(path, before, target, nextText) {
  assertDefaultsAdmission()
  const unchanged = () => {
    holdAtTestGate()
    assertDefaultsAdmission()
    if (linkTarget(path) !== target) throw new CliError('REVISION_CONFLICT', `${path} changed target while bmn was reading it; nothing was written`)
    if ((currentText(path) ?? null) !== before) throw new CliError('REVISION_CONFLICT', `${path} changed while bmn was reading it; nothing was written`)
  }
  unchanged()
  let backup = null
  if (before !== null) {
    backup = `${path}.bmn-backup-${new Date().toISOString()}`
    copyFileSync(path, backup)
  }
  writeAtomically(path, nextText, unchanged)
  return backup
}

function absentClaudeOrCodex(agent, path) {
  const file = readHookFile(path, agent)
  if (file.state !== 'read' && file.state !== 'missing') return { state: 'left', placed: [], older: [], installed: [], left: [], ...unusableFile(file, path) }
  const verdicts = absentVerdicts(agent, checkHooks(agent, path, file))
  const done = { placed: verdicts.placed, older: verdicts.older, left: verdicts.left }
  // Epic 78: BMN's own entry with a timeout too short for what it now does is BMN's to raise.
  const raised = file.state === 'read' ? shortTimeouts(agent, file.data) : []
  // Story 83.4: BMN's own group with the matcher from before the guard is BMN's to widen.
  const widened = file.state === 'read' ? olderMatchers(agent, file.data) : []
  if (verdicts.absent.length === 0 && raised.length === 0 && widened.length === 0) return { state: 'checked', ...done, installed: [] }
  if (rewrittenNumbers(file.text).length > 0) {
    return { state: 'left', ...done, installed: [], why: 'numbers', detail: `${path} holds a number BMN cannot write back unchanged` }
  }
  const nextText = `${JSON.stringify(installHooks(agent, widenMatchers(agent, raiseTimeouts(agent, file.data, raised), widened), verdicts.absent), null, jsonIndent(file.text))}\n`
  const backup = writeHookFile(path, file.state === 'missing' ? null : file.text, linkTarget(path), nextText)
  return {
    state: 'installed', ...done, placed: [...verdicts.placed, ...verdicts.absent], installed: verdicts.absent,
    ...(raised.length === 0 ? {} : { raised }), ...(widened.length === 0 ? {} : { widened }), ...(backup === null ? {} : { backups: [backup] })
  }
}

/**
 * Story 96.3: BMN's earlier plugin, read as `read`, replaced by the current one. A copy is made and read back first;
 * the new text is published by rename only while the path still leads to the same file with the same bytes, and is
 * read back after. Returns the copy's path.
 */
function upgradeOpenCodePlugin(path, read) {
  assertDefaultsAdmission()
  const target = linkTarget(path)
  const unchanged = () => {
    holdAtTestGate()
    assertDefaultsAdmission()
    if (linkTarget(path) !== target) throw new CliError('REVISION_CONFLICT', `${path} changed target while bmn was reading it; nothing was written`)
    const now = readOpenCodePlugin(path)
    if (now === null || now.identity !== read.identity || !now.bytes.equals(read.bytes)) {
      throw new CliError('REVISION_CONFLICT', `${path} changed while bmn was reading it; nothing was written`)
    }
  }
  unchanged()
  const backup = `${path}.bmn-backup-${new Date().toISOString()}`
  copyFileSync(path, backup, constants.COPYFILE_EXCL)
  if (!readFileSync(backup).equals(read.bytes)) throw new CliError('IO_ERROR', `the copy ${backup} does not read back as ${path}; the plugin was not upgraded`)
  writeAtomically(path, OPENCODE_PLUGIN, unchanged)
  if (currentText(path) !== OPENCODE_PLUGIN) throw new CliError('IO_ERROR', `${path} does not read back as BMN's plugin after the upgrade; its copy is ${backup}`)
  return backup
}

/**
 * OpenCode's two entries: the plugin file and its folder named in cli.json. A plugin file there that is not
 * BMN's is left, and so is cli.json then, which would otherwise make OpenCode load it. BMN's own plugin from an
 * earlier release, byte for byte, is upgraded (Story 96.3); a copy of it someone edited is left and reported as
 * changed. OpenCode 1's plugin still beside it counts as in place and is left for `hooks install`. A cli.json BMN
 * cannot add to leaves both files as they are, as `hooks install` does.
 */
function absentOpenCode(path) {
  const { entry, cli: cliPath } = openCodeFiles(path)
  const before = readOpenCodePlugin(path)
  const cli = readOpenCodeCli(cliPath)
  const older = olderOpenCodePlugins(path)
  const placed = []
  const olderEvents = []
  const absent = []
  const left = []
  const upgrade = before?.state === 'earlier'
  if (before === null) absent.push('plugin')
  else if (before.state === 'current' || upgrade) {
    placed.push('plugin')
    if (older.length > 0) olderEvents.push('plugin')
  } else left.push({ event: 'plugin', why: before.state === 'edited' ? 'changed' : 'foreign' })
  if (cli.state !== 'read' && cli.state !== 'missing') {
    return { state: 'left', placed, older: upgrade ? ['plugin'] : olderEvents, installed: [], left, why: cli.state, detail: cli.reason.replace(/; BMN leaves it untouched$/, '') }
  }
  if (cli.plugins.includes(entry)) placed.push('cli.json')
  else if (left.length === 0) absent.push('cli.json')
  const done = { placed, older: olderEvents, left }
  if (absent.length === 0 && !upgrade) return { state: 'checked', ...done, installed: [] }
  if (absent.includes('cli.json') && rewrittenNumbers(cli.text ?? '').length > 0) {
    return { state: 'left', ...done, older: upgrade ? ['plugin'] : olderEvents, installed: [], why: 'numbers', detail: `${cliPath} holds a number BMN cannot write back unchanged` }
  }
  const backups = []
  // The plugin first and cli.json second, as `hooks install` writes them: a stop between leaves a plugin OpenCode does not load yet.
  if (absent.includes('plugin')) writeHookFile(path, null, linkTarget(path), OPENCODE_PLUGIN)
  if (upgrade) backups.push(upgradeOpenCodePlugin(path, before))
  if (absent.includes('cli.json')) {
    const nextText = `${JSON.stringify({ ...cli.data, plugins: [...cli.plugins, entry] }, null, cli.text === null ? 2 : jsonIndent(cli.text))}\n`
    const backup = writeHookFile(cliPath, cli.text, linkTarget(cliPath), nextText)
    if (backup !== null) backups.push(backup)
  }
  return { state: 'installed', ...done, placed: [...placed, ...absent], installed: absent,
    ...(upgrade ? { upgraded: ['plugin'] } : {}), ...(backups.length === 0 ? {} : { backups }) }
}

/**
 * `hooks install --absent`: what BMN runs at every start. Each app set up on this computer gets the entries it
 * lacks entirely and nothing else; what BMN leaves is listed with why. A second run writes nothing. Exit 0 when
 * every set-up app has every entry BMN expects, 1 when one was left or could not be written.
 */
async function installAbsentCommand(agents, pathFor, asJson) {
  return withDefaultsAdmission(async () => {
    const results = []
    for (const agent of agents) {
      const path = pathFor(agent)
      if (!appSetUp(agent, path)) {
        results.push({ agent, file: path, state: 'not-set-up', placed: [], older: [], installed: [], left: [] })
        continue
      }
      try {
        results.push({ agent, file: path, ...(agent === 'opencode' ? absentOpenCode(path) : absentClaudeOrCodex(agent, path)) })
      } catch (error) {
        const detail = error instanceof CliError ? error.message : `cannot write ${path} (${error.code ?? error.message})`
        results.push({ agent, file: path, state: 'failed', placed: [], older: [], installed: [], left: [], why: 'failed', detail })
      }
    }
    const ok = results.every((result) => result.state !== 'failed' && result.state !== 'left' && result.left.length === 0)
    if (asJson) {
      writeSync(1, `${JSON.stringify({ ok, agents: results }, null, 2)}\n`)
      return ok ? 0 : 1
    }
    const lines = results.map((result) => {
      const name = HOOK_AGENTS[result.agent]
      if (result.state === 'not-set-up') return `${name}: not set up on this computer; nothing written`
      const head = `${name}  ${result.file}`
      const body = [
        ...(result.installed.length > 0 ? [`  added: ${result.installed.join(', ')}`] : []),
        ...((result.upgraded ?? []).length > 0 ? [`  upgraded from an earlier BMN release: ${result.upgraded.join(', ')}`] : []),
        ...((result.raised ?? []).length > 0 ? [`  timeout raised: ${result.raised.join(', ')}`] : []),
        ...((result.widened ?? []).length > 0 ? [`  matcher widened: ${result.widened.join(', ')}`] : []),
        `  in place: ${result.placed.length}${result.older.length > 0 ? ` (${result.older.join(', ')} in an older wording)` : ''}`,
        ...result.left.map((row) => `  ${row.event}: ${LEFT_WHY[row.why] ?? row.why}, left as it is${row.detail ? ` (${row.detail})` : ''}`),
        ...(result.detail ? [`  ${result.detail}; left as it is`] : []),
        ...(result.backups ?? []).map((backup) => `  backup: ${backup}`)
      ]
      return [head, ...body].join('\n')
    })
    process.stdout.write(`${lines.join('\n\n')}\n`)
    return ok ? 0 : 1
  })
}

/**
 * A test seam, like BMN_PROC_ROOT: it holds an installer open so another writer can get in between the
 * read and the rename, which is the only way to exercise the conflict refusal. The hold is a handshake,
 * not a timer: it says it is waiting, then waits to be let go.
 */
function holdAtTestGate() {
  const gate = process.env.BMN_HOOKS_TEST_GATE
  if (!gate) return
  writeFileSync(`${gate}.waiting`, '')
  const deadline = Date.now() + 10_000
  while (!existsSync(gate) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
  }
}

/**
 * The Claude config folder this session's agent reads, resolved exactly as `hooks install` resolves it,
 * so BMN's history setting reaches `claude glm` (its own CLAUDE_CONFIG_DIR) as well as `~/.claude`.
 */
function claudeConfigDir() {
  return absoluteUncollapsed(process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`)
}
