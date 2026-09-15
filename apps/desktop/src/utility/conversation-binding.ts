import { access, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type {
  AgentCli,
  BoundConversationBinding,
  ConversationLaunchContext,
  PersistedConversationBinding,
  UnsupportedConversationBinding
} from '@ai-terminal/protocol'

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export const RELEVANT_ENVIRONMENT_KEYS: ReadonlySet<string> = new Set([
  'CLAUDE_CONFIG_DIR',
  'CLICOLOR',
  'CLICOLOR_FORCE',
  'CODEX_HOME',
  'COLORTERM',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'NO_COLOR',
  'TERM'
])

export type ClaudeOptionArity = 'none' | 'required' | 'optional' | 'variadic'

export interface ClaudeOptionDefinition {
  canonicalName: string
  aliases: readonly string[]
  arity: ClaudeOptionArity
}

export interface ClaudeOptionGrammar {
  byAlias: ReadonlyMap<string, ClaudeOptionDefinition>
  canonicalNames: ReadonlySet<string>
}

// This is the sole hand-maintained Claude option policy. Grammar and aliases come from --help.
export const CLAUDE_IDENTITY_NEUTRAL_OPTIONS: ReadonlySet<string> = new Set([
  // Adds filesystem scope without selecting or relocating a conversation.
  '--add-dir',
  // Selects an agent definition without selecting a conversation.
  '--agent',
  // Supplies agent definitions without selecting a conversation.
  '--agents',
  // Makes an owner-selected permission mode available without enabling it.
  '--allow-dangerously-skip-permissions',
  // Restricts allowed tools without selecting a conversation.
  '--allowedTools',
  // Extends the system prompt without selecting a conversation.
  '--append-system-prompt',
  // Configures compaction without selecting a conversation.
  '--autocompact',
  // Changes terminal rendering without selecting a conversation.
  '--ax-screen-reader',
  // Selects minimal configuration loading without selecting a conversation.
  '--bare',
  // Selects API beta headers without selecting a conversation.
  '--betas',
  // Enables agent-to-user messaging without selecting a conversation.
  '--brief',
  // Enables browser integration without selecting a conversation.
  '--chrome',
  // Replays an explicitly chosen permission mode without changing conversation identity.
  '--dangerously-skip-permissions',
  // Enables diagnostic output without selecting a conversation.
  '--debug',
  // Selects a diagnostic output file without selecting a conversation.
  '--debug-file',
  // Disables slash commands without selecting a conversation.
  '--disable-slash-commands',
  // Restricts denied tools without selecting a conversation.
  '--disallowedTools',
  // Selects model effort without selecting a conversation.
  '--effort',
  // Changes prompt construction without selecting a conversation.
  '--exclude-dynamic-system-prompt-sections',
  // Selects fallback models without selecting a conversation.
  '--fallback-model',
  // Supplies startup file resources without selecting a conversation.
  '--file',
  // Changes stream output detail without selecting a conversation.
  '--forward-subagent-text',
  // Enables IDE integration without selecting a conversation.
  '--ide',
  // Includes hook events without selecting a conversation.
  '--include-hook-events',
  // Includes partial stream messages without selecting a conversation.
  '--include-partial-messages',
  // Selects the stdin format without selecting a conversation.
  '--input-format',
  // Selects structured output validation without selecting a conversation.
  '--json-schema',
  // Sets a spend limit without selecting a conversation.
  '--max-budget-usd',
  // Supplies MCP configuration without selecting a conversation.
  '--mcp-config',
  // Selects the model without selecting a conversation.
  '--model',
  // Sets a display name without selecting a conversation.
  '--name',
  // Disables browser integration without selecting a conversation.
  '--no-chrome',
  // Selects the stdout format without selecting a conversation.
  '--output-format',
  // Selects the permission mode without selecting a conversation.
  '--permission-mode',
  // Selects the permission responder without selecting a conversation.
  '--permission-prompts',
  // Adds local plugins without selecting a conversation.
  '--plugin-dir',
  // Adds URL-hosted plugins without selecting a conversation.
  '--plugin-url',
  // Configures prompt suggestions without selecting a conversation.
  '--prompt-suggestions',
  // Echoes streamed user messages without selecting a conversation.
  '--replay-user-messages',
  // Selects restricted tool behavior without selecting a conversation.
  '--restricted',
  // Disables customizations without selecting a conversation.
  '--safe-mode',
  // Selects configuration sources without selecting a conversation.
  '--setting-sources',
  // Supplies settings without selecting a conversation.
  '--settings',
  // Restricts MCP configuration sources without selecting a conversation.
  '--strict-mcp-config',
  // Replaces the system prompt without selecting a conversation.
  '--system-prompt',
  // Configures system-prompt snapshots without selecting a conversation.
  '--system-prompt-snapshot',
  // Selects available tools without selecting a conversation.
  '--tools',
  // Enables verbose output without selecting a conversation.
  '--verbose'
])

const ANSI_CONTROL_SEQUENCE_INTRODUCER = `${String.fromCharCode(0x1b)}[`

function stripAnsiControlSequences(output: string): string {
  return output
    .split(ANSI_CONTROL_SEQUENCE_INTRODUCER)
    .map((part, index) => index === 0 ? part : part.replace(/^[0-?]*[ -/]*[@-~]/, ''))
    .join('')
}

export function parseClaudeHelpOptionGrammar(helpOutput: string): ClaudeOptionGrammar | undefined {
  const lines = stripAnsiControlSequences(helpOutput).replace(/\r/g, '').split('\n')
  const optionsStart = lines.findIndex((line) => line.trim() === 'Options:')
  if (optionsStart === -1) return undefined
  const byAlias = new Map<string, ClaudeOptionDefinition>()
  const canonicalNames = new Set<string>()
  for (const line of lines.slice(optionsStart + 1)) {
    if (/^\S/.test(line) && line.trim().endsWith(':')) break
    if (!/^ {2}\S/.test(line) || !line.trimStart().startsWith('-')) continue
    const syntax = line.slice(2).split(/\s{2,}/, 1)[0]!.trim()
    const placeholder = syntax.match(/(?:^|\s)(<[^>]+>|\[[^\]]+\])$/)?.[1]
    const aliasesSyntax = placeholder
      ? syntax.slice(0, syntax.length - placeholder.length).trim()
      : syntax
    const aliases = aliasesSyntax
      .split(/,\s*/)
      .map((alias) => alias.trim())
      .filter((alias) => /^-{1,2}[^\s=,]+$/.test(alias))
    const canonicalName = aliases.find((alias) => alias.startsWith('--'))
    if (!canonicalName || aliases.length === 0) continue
    let arity: ClaudeOptionArity = 'none'
    if (placeholder?.startsWith('<')) {
      arity = placeholder.slice(1, -1).endsWith('...') ? 'variadic' : 'required'
    } else if (placeholder?.startsWith('[')) {
      arity = 'optional'
    }
    const definition: ClaudeOptionDefinition = { canonicalName, aliases, arity }
    canonicalNames.add(canonicalName)
    for (const alias of aliases) {
      if (byAlias.has(alias)) return undefined
      byAlias.set(alias, definition)
    }
  }
  return canonicalNames.size === 0 ? undefined : { byAlias, canonicalNames }
}

export interface ConversationLaunchInput {
  cwd: string
  executable: string
  argv: readonly string[]
}

export interface PreparedConversationLaunch {
  executable: string
  argv: readonly string[]
  binding: PersistedConversationBinding
  injectedArguments: readonly string[]
}

export interface ClaudeSessionIdCapability {
  supported: boolean
  detail: string
  grammar?: ClaudeOptionGrammar
}

function bindReference(value: unknown): string | undefined {
  return typeof value === 'string' && UUID_PATTERN.test(value) ? value.toLowerCase() : undefined
}

export function isLowercaseConversationReference(value: string): boolean {
  return bindReference(value) === value
}

export function captureRelevantLaunchEnvironment(
  environment: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string | null>> {
  const captured: Record<string, string | null> = {}
  for (const key of RELEVANT_ENVIRONMENT_KEYS) {
    const value = environment[key]
    captured[key] = typeof value === 'string' ? value : null
  }
  captured.TERM = 'xterm-256color'
  return captured
}

export function applyCapturedLaunchEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  captured: Readonly<Record<string, string | null>>
): Record<string, string | undefined> {
  const restored = { ...environment }
  for (const key of RELEVANT_ENVIRONMENT_KEYS) delete restored[key]
  for (const [key, value] of Object.entries(captured)) {
    if (!RELEVANT_ENVIRONMENT_KEYS.has(key)) continue
    if (value === null) delete restored[key]
    else restored[key] = value
  }
  return restored
}

export function agentCli(executable: string): AgentCli {
  const command = basename(executable).toLowerCase()
  if (command === 'claude' || command === 'claude.exe') return 'claude'
  if (command === 'codex' || command === 'codex.exe') return 'codex'
  return 'other'
}

export function conversationIdentity(binding: PersistedConversationBinding): string | undefined {
  return binding.status === 'bound'
    ? `${binding.agentCli}:${binding.conversationReference}`
    : undefined
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

function invalidBoundBinding(input: unknown, reason: string): UnsupportedConversationBinding {
  const candidate = record(input)
  const context = record(candidate?.launchContext)
  const executable = typeof context?.executable === 'string' ? context.executable : ''
  const candidateCli = candidate?.agentCli
  const cli: AgentCli = candidateCli === 'claude' || candidateCli === 'codex' || candidateCli === 'other'
    ? candidateCli
    : agentCli(executable)
  return {
    sessionId: typeof candidate?.sessionId === 'string' ? candidate.sessionId : '',
    agentCli: cli,
    status: 'unsupported',
    captureRoute: 'unsupported',
    launchContext: {
      cwd: typeof context?.cwd === 'string' ? context.cwd : '',
      executable,
      argv: [],
      environment: captureRelevantLaunchEnvironment({})
    },
    detail: `Stored conversation binding is unsupported: ${reason}`,
    capturedAt: typeof candidate?.capturedAt === 'string' && Number.isFinite(Date.parse(candidate.capturedAt))
      ? candidate.capturedAt
      : new Date(0).toISOString()
  }
}

export function parseBoundBinding(input: unknown): PersistedConversationBinding {
  const candidate = record(input)
  if (!candidate) return invalidBoundBinding(input, 'stored state is not an object')
  const launchContext = record(candidate.launchContext)
  if (!launchContext) return invalidBoundBinding(input, 'stored launch context is not an object')
  if (
    typeof candidate.sessionId !== 'string' || candidate.sessionId.length === 0 ||
    typeof launchContext.cwd !== 'string' || launchContext.cwd.length === 0 ||
    typeof launchContext.executable !== 'string' || launchContext.executable.length === 0
  ) {
    return invalidBoundBinding(input, 'stored conversation binding identity or launch context is empty')
  }
  if (
    candidate.agentCli !== 'claude' &&
    candidate.agentCli !== 'codex' &&
    candidate.agentCli !== 'other'
  ) {
    return invalidBoundBinding(input, 'stored agent CLI is invalid')
  }
  if (agentCli(launchContext.executable) !== candidate.agentCli) {
    return invalidBoundBinding(input, 'stored executable identity does not match the bound agent CLI')
  }
  if (
    !Array.isArray(launchContext.argv) ||
    !launchContext.argv.every((argument) => typeof argument === 'string')
  ) {
    return invalidBoundBinding(input, 'stored launch arguments must contain only strings')
  }
  const environment = record(launchContext.environment)
  const environmentKeys = environment ? Object.keys(environment) : []
  if (
    !environment ||
    environmentKeys.length !== RELEVANT_ENVIRONMENT_KEYS.size ||
    !environmentKeys.every((key) => RELEVANT_ENVIRONMENT_KEYS.has(key)) ||
    !Object.values(environment).every((value) => typeof value === 'string' || value === null)
  ) {
    return invalidBoundBinding(input, 'stored launch environment must contain exactly the relevant keys')
  }
  if (typeof candidate.detail !== 'string' || candidate.detail.length === 0) {
    return invalidBoundBinding(input, 'stored binding detail is empty')
  }
  if (
    typeof candidate.capturedAt !== 'string' ||
    candidate.capturedAt.length === 0 ||
    !Number.isFinite(Date.parse(candidate.capturedAt))
  ) {
    return invalidBoundBinding(input, 'stored binding capture time is invalid')
  }
  const parsedContext: ConversationLaunchContext = {
    cwd: launchContext.cwd,
    executable: launchContext.executable,
    argv: [...launchContext.argv] as string[],
    environment: { ...environment } as Record<string, string | null>
  }
  if (candidate.status === 'bound') {
    if (
      (candidate.agentCli !== 'claude' && candidate.agentCli !== 'codex') ||
      !isLowercaseConversationReference(String(candidate.conversationReference ?? ''))
    ) {
      return invalidBoundBinding(input, 'stored conversation reference must be a lowercase UUID')
    }
    if (
      (candidate.agentCli === 'claude' &&
        candidate.captureRoute !== 'claude-session-id' &&
        candidate.captureRoute !== 'explicit-resume-reference') ||
      (candidate.agentCli === 'codex' && candidate.captureRoute !== 'explicit-resume-reference')
    ) {
      return invalidBoundBinding(input, 'stored capture route does not match the bound agent CLI')
    }
    return {
      sessionId: candidate.sessionId,
      agentCli: candidate.agentCli,
      status: 'bound',
      conversationReference: candidate.conversationReference as string,
      captureRoute: candidate.captureRoute as BoundConversationBinding['captureRoute'],
      launchContext: parsedContext,
      detail: candidate.detail,
      capturedAt: candidate.capturedAt
    }
  }
  if (
    candidate.status === 'unsupported' &&
    candidate.captureRoute === 'unsupported' &&
    candidate.conversationReference === undefined
  ) {
    return {
      sessionId: candidate.sessionId,
      agentCli: candidate.agentCli,
      status: 'unsupported',
      captureRoute: 'unsupported',
      launchContext: parsedContext,
      detail: candidate.detail,
      capturedAt: candidate.capturedAt
    }
  }
  return invalidBoundBinding(input, 'stored status, reference, or capture route is invalid')
}

function unsupportedBinding(
  sessionId: string,
  cli: AgentCli,
  launchContext: ConversationLaunchContext,
  detail: string,
  capturedAt: string
): UnsupportedConversationBinding {
  return {
    sessionId,
    agentCli: cli,
    status: 'unsupported',
    captureRoute: 'unsupported',
    launchContext,
    detail,
    capturedAt
  }
}

interface ClaudeArgumentResult {
  contextArgv: string[]
  explicitSessionId: string | undefined
  unsafeReason?: string
}

function claudeArguments(
  argv: readonly string[],
  grammar: ClaudeOptionGrammar,
  allowExplicitSessionId: boolean
): ClaudeArgumentResult {
  const contextArgv: string[] = []
  let explicitSessionId: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    const equalsIndex = argument.indexOf('=')
    const flag = equalsIndex === -1 ? argument : argument.slice(0, equalsIndex)
    const option = grammar.byAlias.get(flag)
    if (!option) {
      return {
        contextArgv,
        explicitSessionId,
        unsafeReason: `Claude argument ${flag} is absent from the probed option grammar`
      }
    }
    const attachedValue = equalsIndex === -1 ? undefined : argument.slice(equalsIndex + 1)
    if (equalsIndex !== -1 && (option.arity === 'none' || attachedValue?.length === 0)) {
      return {
        contextArgv,
        explicitSessionId,
        unsafeReason: `Claude flag ${flag} does not accept this attached value`
      }
    }
    if (option.canonicalName === '--session-id') {
      if (!allowExplicitSessionId || explicitSessionId) {
        return {
          contextArgv,
          explicitSessionId,
          unsafeReason: allowExplicitSessionId
            ? 'Claude conversation identity is ambiguous: repeated --session-id'
            : 'Stored Claude --session-id selectors cannot be replayed'
        }
      }
      const reference = bindReference(attachedValue ?? argv[index + 1])
      if (attachedValue === undefined) index += 1
      if (option.arity !== 'required' || !reference) {
        return {
          contextArgv,
          explicitSessionId,
          unsafeReason: 'Claude --session-id requires one valid UUID'
        }
      }
      explicitSessionId = reference
      continue
    }
    if (!CLAUDE_IDENTITY_NEUTRAL_OPTIONS.has(option.canonicalName)) {
      return {
        contextArgv,
        explicitSessionId,
        unsafeReason: `Claude option ${option.canonicalName} is not admitted for exact conversation binding`
      }
    }
    contextArgv.push(argument)
    if (option.arity === 'none') continue
    if (attachedValue !== undefined) continue
    if (option.arity === 'required') {
      const value = argv[index + 1]
      if (value === undefined) {
        return {
          contextArgv,
          explicitSessionId,
          unsafeReason: `Claude flag ${flag} is missing its value`
        }
      }
      contextArgv.push(value)
      index += 1
      continue
    }
    if (option.arity === 'optional') {
      const value = argv[index + 1]
      if (value !== undefined && !value.startsWith('-')) {
        contextArgv.push(value)
        index += 1
      }
      continue
    }
    let consumed = 0
    while (argv[index + 1] !== undefined && !argv[index + 1]!.startsWith('-')) {
      contextArgv.push(argv[index + 1]!)
      index += 1
      consumed += 1
    }
    if (consumed === 0) {
      return {
        contextArgv,
        explicitSessionId,
        unsafeReason: `Claude flag ${flag} is missing its variadic value`
      }
    }
  }
  return { contextArgv, explicitSessionId }
}

export async function prepareConversationLaunch(
  sessionId: string,
  input: ConversationLaunchInput,
  environment: Readonly<Record<string, string | undefined>>,
  createConversationReference: () => string,
  capturedAt: string,
  claudeSessionIdCapability: () => Promise<ClaudeSessionIdCapability>
): Promise<PreparedConversationLaunch> {
  const cli = agentCli(input.executable)
  const launchContext: ConversationLaunchContext = {
    cwd: input.cwd,
    executable: input.executable,
    argv: [...input.argv],
    environment: captureRelevantLaunchEnvironment(environment)
  }
  if (cli === 'other') {
    return {
      executable: input.executable,
      argv: [...input.argv],
      injectedArguments: [],
      binding: unsupportedBinding(
        sessionId,
        cli,
        launchContext,
        'Native conversation resume is available only for direct Claude or Codex CLI launches',
        capturedAt
      )
    }
  }
  if (cli === 'codex') {
    const explicitReference = input.argv.length === 2 && input.argv[0] === 'resume'
      ? bindReference(input.argv[1])
      : undefined
    if (explicitReference) {
      return {
        executable: input.executable,
        argv: [...input.argv],
        injectedArguments: [],
        binding: {
          sessionId,
          agentCli: 'codex',
          status: 'bound',
          conversationReference: explicitReference,
          captureRoute: 'explicit-resume-reference',
          launchContext: { ...launchContext, argv: [] },
          detail: 'Codex conversation reference was supplied explicitly at launch',
          capturedAt
        }
      }
    }
    return {
      executable: input.executable,
      argv: [...input.argv],
      injectedArguments: [],
      binding: unsupportedBinding(
        sessionId,
        cli,
        launchContext,
        'Codex 0.154.0 cannot pin a TUI session id at launch or correlate a spawned TUI process to one rollout under concurrent same-directory launches',
        capturedAt
      )
    }
  }

  const capability = await claudeSessionIdCapability()
  if (!capability.supported || !capability.grammar) {
    return {
      executable: input.executable,
      argv: [...input.argv],
      injectedArguments: [],
      binding: unsupportedBinding(
        sessionId,
        cli,
        launchContext,
        `Claude exact conversation binding is unavailable because the probed option grammar cannot admit --session-id: ${capability.detail}`,
        capturedAt
      )
    }
  }
  const parsed = claudeArguments(input.argv, capability.grammar, true)
  if (parsed.unsafeReason) {
    return {
      executable: input.executable,
      argv: [...input.argv],
      injectedArguments: [],
      binding: unsupportedBinding(sessionId, cli, launchContext, parsed.unsafeReason, capturedAt)
    }
  }
  const conversationReference = bindReference(parsed.explicitSessionId ?? createConversationReference())
  if (!conversationReference) {
    throw new Error('The generated Claude conversation reference must be a UUID')
  }
  return {
    executable: input.executable,
    argv: parsed.explicitSessionId
      ? [...input.argv]
      : [...input.argv, '--session-id', conversationReference],
    injectedArguments: parsed.explicitSessionId ? [] : ['--session-id'],
    binding: {
      sessionId,
      agentCli: 'claude',
      status: 'bound',
      conversationReference,
      captureRoute: 'claude-session-id',
      launchContext: { ...launchContext, argv: parsed.contextArgv },
      detail: parsed.explicitSessionId
        ? 'Claude conversation reference was supplied explicitly at launch'
        : 'BMN pinned the Claude conversation UUID before spawning the process',
      capturedAt
    }
  }
}

export function buildNativeResumeLaunch(
  binding: BoundConversationBinding,
  claudeGrammar?: ClaudeOptionGrammar
): ConversationLaunchInput & {
  environment: Readonly<Record<string, string | null>>
} {
  const parsedBinding = parseBoundBinding(binding)
  if (parsedBinding.status !== 'bound') throw new Error(parsedBinding.detail)
  binding = parsedBinding
  let argv: string[]
  if (binding.agentCli === 'claude') {
    if (!claudeGrammar) {
      throw new Error('Stored Claude launch context requires a probed option grammar')
    }
    const parsed = claudeArguments(binding.launchContext.argv, claudeGrammar, false)
    if (parsed.unsafeReason || parsed.explicitSessionId) {
      throw new Error(parsed.unsafeReason ?? 'Stored Claude launch context contains a selector')
    }
    argv = [...parsed.contextArgv, '--resume', binding.conversationReference]
  } else {
    if (binding.launchContext.argv.length > 0) {
      throw new Error('Stored Codex resume context must not contain arguments')
    }
    argv = ['resume', binding.conversationReference]
  }
  return {
    cwd: binding.launchContext.cwd,
    executable: binding.launchContext.executable,
    argv,
    environment: { ...binding.launchContext.environment }
  }
}

function claudeProjectKey(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function codexRolloutExists(directory: string, suffix: string, depth = 0): Promise<boolean> {
  if (depth > 3) return false
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(suffix)) return true
    if (entry.isDirectory() && await codexRolloutExists(join(directory, entry.name), suffix, depth + 1)) {
      return true
    }
  }
  return false
}

export async function conversationReferenceExists(
  binding: BoundConversationBinding
): Promise<boolean> {
  if (binding.agentCli === 'claude') {
    const configRoot = binding.launchContext.environment.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    return pathExists(
      join(
        configRoot,
        'projects',
        claudeProjectKey(binding.launchContext.cwd),
        `${binding.conversationReference}.jsonl`
      )
    )
  }
  const codexRoot = binding.launchContext.environment.CODEX_HOME ?? join(homedir(), '.codex')
  return codexRolloutExists(
    join(codexRoot, 'sessions'),
    `-${binding.conversationReference}.jsonl`
  )
}
