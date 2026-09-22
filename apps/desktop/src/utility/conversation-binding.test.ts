import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { BoundConversationBinding } from '@bmn/protocol'
import {
  agentCli,
  isConversationReference,
  opencodeResumeArguments,
  OPENCODE_RESUME_OPTIONS_CLI_VERSION,
  shownCommand,
  CLAUDE_IDENTITY_NEUTRAL_OPTIONS,
  CODEX_RESUME_OPTIONS,
  CODEX_RESUME_OPTIONS_CLI_VERSION,
  bindingFromObservation,
  buildNativeResumeLaunch,
  captureRelevantLaunchEnvironment,
  codexResumeArguments,
  codexResumeCommand,
  parseClaudeHelpOptionGrammar,
  parseBoundBinding,
  prepareConversationLaunch,
  type ClaudeSessionIdCapability
} from './conversation-binding'

const conversationId = '11111111-1111-4111-8111-111111111111'
const capturedAt = '2026-09-12T12:00:00.000Z'
const claudeHelp = readFileSync(
  new URL('./test-fixtures/claude-2.1.270-help.txt', import.meta.url),
  'utf8'
)
const claudeGrammar = parseClaudeHelpOptionGrammar(claudeHelp)!
const supportedCapability = async (): Promise<ClaudeSessionIdCapability> => ({
  supported: true,
  detail: 'test capability',
  grammar: claudeGrammar
})

const refusedClaudeArguments: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['resume without a value', ['--resume']],
  ['resume with a UUID', ['--resume', conversationId]],
  ['resume with an attached UUID', [`--resume=${conversationId}`]],
  ['short continue', ['-c']],
  ['long continue', ['--continue']],
  ['bare positional UUID', [conversationId]],
  ['short resume with UUID', ['-r', conversationId]],
  ['short resume without a value', ['-r']],
  ['continue with attached value', ['--continue=true']],
  ['last without a value', ['--last']],
  ['last with attached value', ['--last=3']],
  ['clustered short selector', ['-rc']],
  ['unknown uppercase short selector', ['-R']],
  ['resume-last spelling', ['--resume-last']],
  ['fork-session spelling', ['--fork-session']],
  ['fork-session combined with exact resume', ['--fork-session', '--resume', conversationId]],
  ['from-pr with value', ['--from-pr', '123']],
  ['from-pr with attached value', ['--from-pr=123']],
  ['short worktree alias', ['-w', 'feature']],
  ['bare short worktree alias', ['-w']],
  ['valueless tmux before continue', ['--tmux', '--continue']],
  ['optional worktree before continue', ['--worktree', '--continue']],
  ['non-persistent session', ['--no-session-persistence']],
  ['teleport selector', ['--teleport', conversationId]],
  ['unknown historical remote flag', ['--remote', 'task']],
  ['remote-control shape changer', ['--remote-control', 'name']],
  ['unknown option', ['--not-a-real-claude-option']],
  ['optional safe flag before continue', ['--debug', '--continue']],
  ['optional safe short alias before continue', ['-d', '--continue']],
  ['variadic safe flag before continue', ['--add-dir', '/a', '--continue']],
  ['valueless safe flag before continue', ['--verbose', '--continue']],
  ['valueless safe flag followed by a positional prompt', ['--verbose', 'prompt']],
  ['attached variadic followed by another bare value', ['--add-dir=/a', '/b']],
  ['attached variadic followed by a prompt', ['--add-dir=/repo', 'fix it']],
  ['attached variadic followed by a subcommand', ['--add-dir=/a', 'attach', conversationId]],
  ['variadic with no value', ['--add-dir']],
  ['variadic followed by an option', ['--add-dir', '--verbose']],
  ['required option with no value', ['--model']],
  ['variadic followed by an explicit selector', ['--add-dir', '--session-id', conversationId]],
  ['attached value on a valueless option', ['--verbose=x']],
  ['empty attached required value', ['--model=']],
  ['explicit session-id with a non-UUID value', ['--session-id', 'not-a-uuid']]
]

const safeClaudeArguments: ReadonlyArray<readonly [string, readonly string[]]> = [
  ['no flags', []],
  ['known value flags', ['--model', 'sonnet', '--permission-mode', 'default']],
  ['known attached value', ['--model=sonnet']],
  ['known valueless flag', ['--verbose']],
  ['flag value shaped like a selector', ['--model', '--continue']],
  ['camelCase variadic alias', ['--allowedTools', 'Bash', 'Edit']],
  ['kebab-case variadic alias', ['--allowed-tools', 'Bash', 'Edit']],
  ['camelCase denied-tools alias', ['--disallowedTools', 'Bash', 'Edit']],
  ['kebab-case denied-tools alias', ['--disallowed-tools', 'Bash', 'Edit']],
  ['variadic add-dir values', ['--add-dir', '/a', '/b']],
  ['optional debug without a value', ['--debug']],
  ['optional debug with a value', ['--debug', 'api']]
]

function boundClaude(argv: readonly string[]): BoundConversationBinding {
  return {
    sessionId: 'app-session',
    agentCli: 'claude',
    status: 'bound',
    conversationReference: conversationId,
    captureRoute: 'claude-session-id',
    launchContext: {
      cwd: '/workspace',
      executable: '/usr/bin/claude',
      argv: [...argv],
      environment: captureRelevantLaunchEnvironment({ CLAUDE_CONFIG_DIR: '/config/claude' })
    },
    detail: 'pinned before spawn',
    capturedAt
  }
}

function hookCodex(argv: readonly string[]): BoundConversationBinding {
  return {
    sessionId: 'app-session',
    agentCli: 'codex',
    status: 'bound',
    conversationReference: conversationId,
    captureRoute: 'hook-session-start',
    launchContext: {
      cwd: '/workspace',
      executable: '/usr/bin/codex',
      argv: [...argv],
      environment: captureRelevantLaunchEnvironment({ CODEX_HOME: '/config/codex' })
    },
    detail: 'reported by the harness',
    capturedAt
  }
}

describe('conversation identity capture and native resume', () => {
  it('derives aliases and arities from the real Claude 2.1.270 help fixture', () => {
    expect(claudeGrammar.byAlias.get('--allowed-tools')).toMatchObject({
      canonicalName: '--allowedTools',
      arity: 'variadic'
    })
    expect(claudeGrammar.byAlias.get('--allowedTools')).toBe(
      claudeGrammar.byAlias.get('--allowed-tools')
    )
    expect(claudeGrammar.byAlias.get('--tmux')?.arity).toBe('none')
    expect(claudeGrammar.byAlias.get('-w')).toMatchObject({
      canonicalName: '--worktree',
      arity: 'optional'
    })
    expect(claudeGrammar.byAlias.get('--session-id')?.arity).toBe('required')
  })

  it('audits every identity-neutral canonical name against the real help fixture', () => {
    expect(
      [...CLAUDE_IDENTITY_NEUTRAL_OPTIONS].filter(
        (canonicalName) => !claudeGrammar.canonicalNames.has(canonicalName)
      )
    ).toEqual([])
    expect(CLAUDE_IDENTITY_NEUTRAL_OPTIONS).not.toContain('--resume')
    expect(CLAUDE_IDENTITY_NEUTRAL_OPTIONS).not.toContain('--continue')
    expect(CLAUDE_IDENTITY_NEUTRAL_OPTIONS).not.toContain('--from-pr')
    expect(CLAUDE_IDENTITY_NEUTRAL_OPTIONS).not.toContain('--fork-session')
    expect(CLAUDE_IDENTITY_NEUTRAL_OPTIONS).not.toContain('--teleport')
    expect(CLAUDE_IDENTITY_NEUTRAL_OPTIONS).not.toContain('--remote-control')
    expect(CLAUDE_IDENTITY_NEUTRAL_OPTIONS).not.toContain('--worktree')
    expect(CLAUDE_IDENTITY_NEUTRAL_OPTIONS).not.toContain('--tmux')
    expect(CLAUDE_IDENTITY_NEUTRAL_OPTIONS).not.toContain('--no-session-persistence')
  })

  it('pins a distinct Claude UUID before spawn and keeps only resume-safe launch context', async () => {
    const prepared = await prepareConversationLaunch(
      'app-session',
      {
        cwd: '/workspace',
        executable: '/usr/bin/claude',
        argv: ['--model', 'sonnet', '--permission-mode', 'default']
      },
      {
        CLAUDE_CONFIG_DIR: '/config/claude',
        ANTHROPIC_API_KEY: 'must-not-be-stored',
        TERM: 'old'
      },
      () => conversationId,
      capturedAt,
      supportedCapability
    )

    expect(prepared.argv).toEqual([
      '--model',
      'sonnet',
      '--permission-mode',
      'default',
      '--session-id',
      conversationId
    ])
    expect(prepared.injectedArguments).toEqual(['--session-id'])
    expect(prepared.binding).toMatchObject({
      sessionId: 'app-session',
      agentCli: 'claude',
      status: 'bound',
      conversationReference: conversationId,
      captureRoute: 'claude-session-id',
      launchContext: {
        cwd: '/workspace',
        executable: '/usr/bin/claude',
        argv: ['--model', 'sonnet', '--permission-mode', 'default']
      }
    })
    expect(prepared.binding.launchContext.environment).toEqual({
      CLAUDE_CONFIG_DIR: '/config/claude',
      CLICOLOR: null,
      CLICOLOR_FORCE: null,
      CODEX_HOME: null,
      COLORTERM: null,
      LANG: null,
      LC_ALL: null,
      LC_CTYPE: null,
      NO_COLOR: null,
      TERM: 'xterm-256color'
    })
  })

  it('rejects an ambiguous discovered identity instead of choosing a latest candidate', async () => {
    const prepared = await prepareConversationLaunch(
      'app-session',
      {
        cwd: '/workspace',
        executable: '/usr/bin/claude',
        argv: [
          '--session-id',
          '11111111-1111-4111-8111-111111111111',
          '--session-id',
          '22222222-2222-4222-8222-222222222222'
        ]
      },
      {},
      () => conversationId,
      capturedAt,
      supportedCapability
    )

    expect(prepared.binding).toMatchObject({
      status: 'unsupported',
      detail: expect.stringContaining('ambiguous')
    })
  })

  it('records a new Codex TUI session as unsupported without changing its launch', async () => {
    const prepared = await prepareConversationLaunch(
      'app-session',
      { cwd: '/workspace', executable: '/usr/bin/codex', argv: ['--model', 'gpt-5.6'] },
      {},
      () => conversationId,
      capturedAt,
      supportedCapability
    )

    expect(prepared.argv).toEqual(['--model', 'gpt-5.6'])
    expect(prepared.injectedArguments).toEqual([])
    expect(prepared.binding).toMatchObject({
      agentCli: 'codex',
      status: 'unsupported',
      captureRoute: 'unsupported',
      detail: expect.stringContaining('concurrent same-directory')
    })
  })

  it.each(refusedClaudeArguments)(
    'refuses %s at capture without minting a reference',
    async (_name, argv) => {
      const createReference = vi.fn(() => conversationId)
      const probeCapability = vi.fn(supportedCapability)
      const prepared = await prepareConversationLaunch(
        'app-session',
        { cwd: '/workspace', executable: '/usr/bin/claude', argv },
        {},
        createReference,
        capturedAt,
        probeCapability
      )

      expect(prepared.argv).toEqual(argv)
      expect(prepared.injectedArguments).toEqual([])
      expect(prepared.binding).toMatchObject({ status: 'unsupported' })
      expect(createReference).not.toHaveBeenCalled()
      expect(probeCapability).toHaveBeenCalledOnce()
    }
  )

  it.each(refusedClaudeArguments)('refuses %s in stored resume context', (_name, argv) => {
    expect(() => buildNativeResumeLaunch(boundClaude(argv), claudeGrammar)).toThrow()
  })

  it('refuses a stored session-id selector even when its UUID is valid', () => {
    expect(() =>
      buildNativeResumeLaunch(boundClaude(['--session-id', conversationId]), claudeGrammar)
    ).toThrow(/Stored Claude --session-id/)
  })

  it.each([
    [
      'uppercase reference',
      { conversationReference: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
      /lowercase UUID/
    ],
    [
      'mismatched executable',
      { launchContext: { ...boundClaude([]).launchContext, executable: '/bin/sh' } },
      /executable identity/
    ],
    [
      'unapproved environment key',
      {
        launchContext: {
          ...boundClaude([]).launchContext,
          environment: { LD_PRELOAD: '/tmp/injected.so' }
        }
      },
      /exactly the relevant keys/
    ]
  ])('refuses a stored binding with %s', (_name, mutation, message) => {
    const binding = { ...boundClaude([]), ...mutation } as BoundConversationBinding
    expect(() => buildNativeResumeLaunch(binding, claudeGrammar)).toThrow(message)
  })

  it.each(safeClaudeArguments)('accepts %s with exact arity at capture', async (_name, argv) => {
    const prepared = await prepareConversationLaunch(
      'app-session',
      { cwd: '/workspace', executable: '/usr/bin/claude', argv },
      {},
      () => conversationId,
      capturedAt,
      supportedCapability
    )

    expect(prepared.binding).toMatchObject({
      status: 'bound',
      conversationReference: conversationId
    })
    expect(prepared.binding.launchContext.argv).toEqual(argv)
  })

  it.each(safeClaudeArguments)('accepts %s with exact arity in stored resume context', (_name, argv) => {
    expect(buildNativeResumeLaunch(boundClaude(argv), claudeGrammar).argv).toEqual([
      ...argv,
      '--resume',
      conversationId
    ])
  })

  it.each([
    ['session-id pair', ['--session-id', conversationId]],
    ['session-id attached value', [`--session-id=${conversationId}`]]
  ] as const)('accepts an exact binding from %s without minting a reference', async (_name, argv) => {
    const createReference = vi.fn(() => 'unreachable')
    const probeCapability = vi.fn(supportedCapability)
    const prepared = await prepareConversationLaunch(
      'app-session',
      { cwd: '/workspace', executable: '/usr/bin/claude', argv },
      {},
      createReference,
      capturedAt,
      probeCapability
    )

    expect(prepared.binding).toMatchObject({
      status: 'bound',
      conversationReference: conversationId
    })
    expect(prepared.injectedArguments).toEqual([])
    expect(createReference).not.toHaveBeenCalled()
    expect(probeCapability).toHaveBeenCalledOnce()
  })

  it('keeps the launch unmodified and does not mint when session-id injection is unsupported', async () => {
    const createReference = vi.fn(() => conversationId)
    const prepared = await prepareConversationLaunch(
      'app-session',
      { cwd: '/workspace', executable: '/usr/bin/claude', argv: ['--model', 'sonnet'] },
      {},
      createReference,
      capturedAt,
      async () => ({ supported: false, detail: 'help has no such option' })
    )

    expect(prepared.argv).toEqual(['--model', 'sonnet'])
    expect(prepared.injectedArguments).toEqual([])
    expect(prepared.binding).toMatchObject({
      status: 'unsupported',
      detail: expect.stringContaining('--session-id')
    })
    expect(createReference).not.toHaveBeenCalled()
  })

  it('keeps the launch unmodified when help is unparseable', async () => {
    const createReference = vi.fn(() => conversationId)
    const argv = ['--model', 'sonnet']
    const prepared = await prepareConversationLaunch(
      'app-session',
      { cwd: '/workspace', executable: '/usr/bin/claude', argv },
      {},
      createReference,
      capturedAt,
      async () => ({ supported: false, detail: 'no parsable option table' })
    )

    expect(prepared.argv).toEqual(argv)
    expect(prepared.binding.status).toBe('unsupported')
    expect(createReference).not.toHaveBeenCalled()
  })

  it('refuses an allowlisted flag that is absent from the probed help grammar at both call sites', async () => {
    const helpWithoutModel = claudeHelp.replace(/^ {2}--model <model>.*\n(?: {40}.*\n)*/m, '')
    const grammarWithoutModel = parseClaudeHelpOptionGrammar(helpWithoutModel)!
    const argv = ['--model', 'sonnet']
    const createReference = vi.fn(() => conversationId)
    const prepared = await prepareConversationLaunch(
      'app-session',
      { cwd: '/workspace', executable: '/usr/bin/claude', argv },
      {},
      createReference,
      capturedAt,
      async () => ({ supported: true, detail: 'synthetic fixture', grammar: grammarWithoutModel })
    )

    expect(prepared.argv).toEqual(argv)
    expect(prepared.binding.status).toBe('unsupported')
    expect(createReference).not.toHaveBeenCalled()
    expect(() => buildNativeResumeLaunch(boundClaude(argv), grammarWithoutModel)).toThrow(
      /absent from the probed option grammar/
    )
  })

  it('normalizes an explicitly supplied Claude UUID to lowercase', async () => {
    const uppercase = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const prepared = await prepareConversationLaunch(
      'app-session',
      { cwd: '/workspace', executable: '/usr/bin/claude', argv: ['--session-id', uppercase] },
      {},
      () => 'unreachable',
      capturedAt,
      supportedCapability
    )

    expect(prepared.argv).toEqual(['--session-id', uppercase])
    expect(prepared.binding).toMatchObject({
      conversationReference: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
  })

  it('normalizes an explicitly supplied Codex UUID and admits exactly resume plus UUID', async () => {
    const uppercase = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'
    const exact = await prepareConversationLaunch(
      'app-session',
      { cwd: '/workspace', executable: '/usr/bin/codex', argv: ['resume', uppercase] },
      {},
      () => 'unreachable',
      capturedAt,
      supportedCapability
    )
    const withExtra = await prepareConversationLaunch(
      'other-session',
      { cwd: '/workspace', executable: '/usr/bin/codex', argv: ['resume', uppercase, '--last'] },
      {},
      () => 'unreachable',
      capturedAt,
      supportedCapability
    )

    expect(exact.binding).toMatchObject({
      status: 'bound',
      conversationReference: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    expect(withExtra.binding).toMatchObject({ status: 'unsupported' })
  })

  it('refuses to parse an invalid bound row with an incomplete environment key set', () => {
    expect(parseBoundBinding({
      ...boundClaude([]),
      launchContext: {
        ...boundClaude([]).launchContext,
        environment: { TERM: 'xterm-256color' }
      }
    })).toMatchObject({
      status: 'unsupported',
      detail: expect.stringContaining('exactly the relevant keys')
    })
  })

  it('admits an explicitly located Claude conversation through the shared binding parser', () => {
    expect(parseBoundBinding({
      ...boundClaude([]),
      captureRoute: 'explicit-resume-reference'
    })).toMatchObject({
      status: 'bound',
      agentCli: 'claude',
      conversationReference: conversationId,
      captureRoute: 'explicit-resume-reference'
    })
  })

  it('builds exact bound resume argv with original cwd, flags, and relevant environment', () => {
    expect(buildNativeResumeLaunch(boundClaude(['--model', 'sonnet']), claudeGrammar)).toEqual({
      cwd: '/workspace',
      executable: '/usr/bin/claude',
      argv: ['--model', 'sonnet', '--resume', conversationId],
      environment: captureRelevantLaunchEnvironment({ CLAUDE_CONFIG_DIR: '/config/claude' })
    })
  })
})

describe('conversation identity reported by the harness SessionStart hook', () => {
  it('shows a command whose argument boundaries survive being read as one line', () => {
    const binding = { ...hookCodex(['--config', 'shell_environment_policy.inherit = all']) }
    expect(codexResumeCommand(binding)).toBe(
      `/usr/bin/codex resume ${conversationId} --config "shell_environment_policy.inherit = all"`
    )
  })

  it('cuts the transcript path, never the command, when a detail reaches the 2000-character cap', () => {
    const binding = bindingFromObservation(
      {
        agentCli: 'codex',
        conversationReference: conversationId,
        source: 'startup',
        transcriptPath: `/${'p'.repeat(2_400)}`
      },
      hookCodex(['--model', 'gpt-6']),
      capturedAt
    )
    expect(binding.detail.length).toBe(2_000)
    expect(binding.detail).toContain(`Resume runs: /usr/bin/codex resume ${conversationId} --model gpt-6`)
    expect(binding.detail).toContain('; transcript /ppp')
  })

  it('pins the Codex resume options read by hand from codex resume --help', () => {
    expect(CODEX_RESUME_OPTIONS_CLI_VERSION).toBe('0.155.1')
    expect([...CODEX_RESUME_OPTIONS.keys()]).toEqual([
      '-a', '--add-dir', '--approve-for-me', '--ask-for-approval', '-C', '-c', '--cd', '--config',
      '--dangerously-bypass-approvals-and-sandbox', '--dangerously-bypass-hook-trust',
      '--disable', '--enable', '-i', '--image', '--local-provider', '-m', '--model',
      '--no-alt-screen', '--oss', '-p', '--profile', '--remote', '--remote-auth-token-env',
      '-s', '--sandbox', '--search', '--strict-config', '--worktree'
    ])
    // Carrying either would print a page instead of resuming the conversation.
    expect(CODEX_RESUME_OPTIONS.has('--help')).toBe(false)
    expect(CODEX_RESUME_OPTIONS.has('--version')).toBe(false)
  })

  it.each([
    ['a flag and a valued option', ['--search', '-m', 'gpt-6'], ['--search', '-m', 'gpt-6'], [], 0],
    ['an attached value', ['--model=gpt-6'], ['--model=gpt-6'], [], 0],
    ['one image and nothing greedy after it', ['-i', 'a.png', 'PRIVATE PROMPT', '--oss'],
      ['-i', 'a.png', '--oss'], [], 1],
    ['an option codex resume does not accept', ['--full-auto'], [], ['--full-auto'], 0],
    ['a prompt', ['Do the thing'], [], [], 1],
    ['an option missing its value', ['--model'], [], ['--model'], 0],
    ['everything after a literal separator', ['--search', '--', '-m', 'x'], ['--search'], [], 2]
  ])('splits %s into carried and dropped launch arguments', (_name, argv, carried, options, positionals) => {
    expect(codexResumeArguments(argv)).toEqual({
      carried,
      droppedOptions: options,
      droppedPositionals: positionals
    })
  })

  it('resumes a hook-captured Codex conversation with the id first and the accepted options after', () => {
    expect(buildNativeResumeLaunch(hookCodex(['--model', 'gpt-6', '--full-auto', 'a prompt']))).toEqual({
      cwd: '/workspace',
      executable: '/usr/bin/codex',
      argv: ['resume', conversationId, '--model', 'gpt-6'],
      environment: captureRelevantLaunchEnvironment({ CODEX_HOME: '/config/codex' })
    })
  })

  it('still refuses stored arguments on the explicit Codex resume route', () => {
    expect(() =>
      buildNativeResumeLaunch({ ...hookCodex(['--model', 'gpt-6']), captureRoute: 'explicit-resume-reference' })
    ).toThrow(/must not contain arguments/)
  })

  it('lets the harness word supersede a selector Claude was pinned with, and nothing else', () => {
    expect(buildNativeResumeLaunch(
      { ...boundClaude(['--session-id', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '--model', 'sonnet']), captureRoute: 'hook-session-start' },
      claudeGrammar
    ).argv).toEqual(['--model', 'sonnet', '--resume', conversationId])
    expect(() => buildNativeResumeLaunch(
      { ...boundClaude(['--resume', conversationId]), captureRoute: 'hook-session-start' },
      claudeGrammar
    )).toThrow()
  })

  it.each([
    ['claude', 'hook-session-start'],
    ['codex', 'hook-session-start']
  ] as const)('admits a %s binding captured from the hook through the shared parser', (agent, route) => {
    const base = agent === 'claude' ? boundClaude([]) : hookCodex([])
    expect(parseBoundBinding({ ...base, captureRoute: route })).toMatchObject({
      status: 'bound',
      agentCli: agent,
      captureRoute: 'hook-session-start'
    })
  })

  it('names the source, the replaced conversation and the command Resume runs', () => {
    const binding = bindingFromObservation(
      { agentCli: 'codex', conversationReference: conversationId, source: 'startup' },
      { ...hookCodex(['--model', 'gpt-6', '--full-auto', 'a prompt']), conversationReference: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      capturedAt
    )
    expect(binding.captureRoute).toBe('hook-session-start')
    expect(binding.detail).toBe(
      'Reported by Codex at session start; replaces cccccccc-cccc-4ccc-8ccc-cccccccccccc; ' +
      `Resume runs: /usr/bin/codex resume ${conversationId} --model gpt-6; ` +
      'not carried: --full-auto, 1 positional argument'
    )
  })

  it('keeps the session launch context and names a Claude clear without a resume command', () => {
    const binding = bindingFromObservation(
      { agentCli: 'claude', conversationReference: conversationId, source: 'clear', transcriptPath: '/home/o/.claude/x.jsonl' },
      { ...boundClaude(['--model', 'sonnet']), conversationReference: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' },
      capturedAt
    )
    expect(binding.launchContext.argv).toEqual(['--model', 'sonnet'])
    expect(binding.detail).toBe(
      'Reported by Claude Code after the conversation was cleared; ' +
      'replaces cccccccc-cccc-4ccc-8ccc-cccccccccccc; transcript /home/o/.claude/x.jsonl'
    )
  })

  it('rebinds an unsupported Codex session and says only where the word came from', () => {
    const unsupported = {
      sessionId: 'app-session',
      agentCli: 'codex' as const,
      status: 'unsupported' as const,
      captureRoute: 'unsupported' as const,
      launchContext: hookCodex([]).launchContext,
      detail: 'Codex 0.154.0 cannot pin a TUI session id at launch',
      capturedAt
    }
    expect(bindingFromObservation(
      { agentCli: 'codex', conversationReference: conversationId, source: 'startup' },
      unsupported,
      capturedAt
    )).toMatchObject({
      status: 'bound',
      captureRoute: 'hook-session-start',
      conversationReference: conversationId,
      detail: `Reported by Codex at session start; Resume runs: /usr/bin/codex resume ${conversationId}`
    })
  })
})

describe('OpenCode 1.18.31 conversation binding', () => {
  // One real id read locally and confirmed by `opencode export` on 2026-09-22.
  const reference = 'ses_f5656e404ffehVbLiXJ8YHJQjV'
  const context = {
    cwd: '/repo', executable: '/usr/bin/opencode', argv: [] as string[],
    environment: captureRelevantLaunchEnvironment({})
  }
  const bound: BoundConversationBinding = {
    sessionId: 'bmn-session', agentCli: 'opencode', status: 'bound', conversationReference: reference,
    captureRoute: 'hook-session-start', launchContext: context, detail: 'Reported by OpenCode', capturedAt
  }

  it('classifies direct launches and waits for the hook without probing Claude', async () => {
    expect(agentCli('/bin/opencode')).toBe('opencode')
    const capability = vi.fn(supportedCapability)
    const result = await prepareConversationLaunch('bmn-session', context, {}, () => conversationId, capturedAt, capability)
    expect(result.binding).toMatchObject({ agentCli: 'opencode', status: 'unsupported', detail: 'OpenCode reports its session when it starts; Resume becomes available then' })
    expect(result.injectedArguments).toEqual([])
    expect(capability).not.toHaveBeenCalled()
  })

  it('pins the observed case-sensitive id grammar independently from UUIDs', () => {
    expect(OPENCODE_RESUME_OPTIONS_CLI_VERSION).toBe('1.18.31')
    expect(isConversationReference('opencode', reference)).toBe(true)
    expect(isConversationReference('opencode', conversationId)).toBe(false)
    expect(isConversationReference('claude', reference)).toBe(false)
    expect(isConversationReference('codex', reference)).toBe(false)
    expect(isConversationReference('claude', conversationId)).toBe(true)
    for (const value of [reference + '\n', reference.slice(0, -1), 'SES_' + reference.slice(4), 'ses_' + 'x'.repeat(26)]) {
      expect(isConversationReference('opencode', value)).toBe(false)
    }
    expect(parseBoundBinding(bound)).toEqual(bound)
    expect(parseBoundBinding({ ...bound, captureRoute: 'claude-session-id' }).status).toBe('unsupported')
  })

  it('observes an exact mixed-case reference and describes carried and dropped arguments', () => {
    const argv = ['project', '--model', 'provider/model', '--agent=build', '--port', '4096', '--hostname=localhost', '--prompt', 'private prompt', '--continue', '--fork', '--session', reference]
    const observed = bindingFromObservation({ agentCli: 'opencode', conversationReference: reference, source: 'startup' }, { ...bound, launchContext: { ...context, argv } }, capturedAt)
    const launch = buildNativeResumeLaunch(observed)
    expect(launch.cwd).toBe('/repo/project')
    expect(launch.argv).toEqual(['--session', reference, '--model', 'provider/model', '--agent=build', '--port', '4096', '--hostname=localhost'])
    expect(observed.detail).toContain('Reported by OpenCode at session start')
    expect(observed.detail).toContain(`Resume runs: ${shownCommand(launch.executable, launch.argv)}`)
    expect(observed.detail).toContain('not carried: --prompt, --continue, --fork, --session')
    expect(observed.detail).not.toContain('private prompt')
    expect(observed.conversationReference).toBe(reference)
  })

  it('drops malformed options without swallowing selectors and retains the project as cwd', () => {
    expect(opencodeResumeArguments(['--model', '--fork', '--agent=', '--unknown', 'value', '/project'])).toEqual({
      carried: [], droppedOptions: ['--model', '--fork', '--agent', '--unknown'], droppedPositionals: 1, projectPath: '/project'
    })
    expect(buildNativeResumeLaunch({ ...bound, launchContext: { ...context, argv: ['--', '/other'] } }).cwd).toBe('/other')
    expect(opencodeResumeArguments(['--mini', '--no-replay', '--mdns', '--replay-limit', '20', '/project']))
      .toEqual({ carried: [], droppedOptions: ['--mini', '--no-replay', '--mdns', '--replay-limit'],
        droppedPositionals: 0, projectPath: '/project' })
  })
})
