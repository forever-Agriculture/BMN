import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { BoundConversationBinding } from '@ai-terminal/protocol'
import {
  CLAUDE_IDENTITY_NEUTRAL_OPTIONS,
  buildNativeResumeLaunch,
  captureRelevantLaunchEnvironment,
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
