// MODULE: hook-configuration-check.test.ts - the window's hooks check is the CLI's read-only report, dated and redacted
import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { runHookConfigurationCheck } from './hook-configuration-check'
import type { HookCheckAgentReport, HookCheckReport } from '@bmn/protocol'

const CLI = fileURLToPath(new URL('../../bin/bmn', import.meta.url))
const CLAUDE_EVENTS = ['Notification', 'PostToolUse', 'PostToolUseFailure', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd']
const CODEX_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SessionStart', 'SessionEnd', 'Interrupt']
const checkedAt = '2026-09-24T12:00:00.000Z'
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

/** Every fixture redirects each harness's own config directory into a fresh temporary folder. */
async function configFixture(): Promise<{ root: string; env: Record<string, string> }> {
  const root = await mkdtemp(join(tmpdir(), 'bmn-hookcheck-'))
  roots.add(root)
  const env = {
    CLAUDE_CONFIG_DIR: join(root, 'claude'),
    CODEX_HOME: join(root, 'codex'),
    OPENCODE_CONFIG_DIR: join(root, 'opencode')
  }
  return { root, env }
}

/** The bare call is one of the three commands the checker recognises, so it reads as an older wiring. */
function hookFile(events: readonly string[], agent: 'claude' | 'codex'): string {
  const hooks = Object.fromEntries(events.map((event) => [event, [{ hooks: [{ type: 'command', command: `bmn hook ${agent}` }] }]]))
  return `${JSON.stringify({ hooks }, null, 2)}\n`
}

async function writeHookFile(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

const check = (env: Record<string, string>) =>
  runHookConfigurationCheck(CLI, { env, now: () => new Date(checkedAt) })

function agentNamed(report: HookCheckReport, agent: string): HookCheckAgentReport {
  expect(report.state).toBe('checked')
  if (report.state !== 'checked') throw new Error('the report was not checked')
  const row = report.agents.find((candidate) => candidate.agent === agent)
  expect(row).toBeDefined()
  return row!
}

describe('runHookConfigurationCheck', () => {
  it('reports all three harnesses with a checked time, wired entries and missing entries', async () => {
    const { root, env } = await configFixture()
    await writeHookFile(join(root, 'claude', 'settings.json'), hookFile(CLAUDE_EVENTS, 'claude'))
    await writeHookFile(join(root, 'codex', 'hooks.json'), hookFile(['Stop'], 'codex'))

    const report = await check(env)

    expect(report).toMatchObject({ state: 'checked', checkedAt, ok: false })
    expect(report.state === 'checked' && report.agents.map((row) => row.agent)).toEqual(['claude', 'codex', 'opencode'])
    const claude = agentNamed(report, 'claude')
    expect(claude).toMatchObject({ state: 'read', missing: [] })
    expect(claude.entries).toEqual(CLAUDE_EVENTS.map((event) => ({ event, optional: false, state: 'wired (older wording)' })))
    const codex = agentNamed(report, 'codex')
    expect(codex).toMatchObject({ state: 'read' })
    expect(codex.entries.find((entry) => entry.event === 'Stop')).toMatchObject({ state: 'wired (older wording)' })
    expect(codex.missing).toEqual(CODEX_EVENTS.filter((event) => event !== 'Stop'))
    expect(agentNamed(report, 'opencode')).toMatchObject({
      state: 'missing',
      entries: [{ event: 'plugin', optional: false, state: 'missing' }],
      missing: ['plugin']
    })
  })

  it('reads the shipped OpenCode plugin as wired', async () => {
    const { root, env } = await configFixture()
    const { stdout: plugin } = await new Promise<{ stdout: string }>((resolve, reject) =>
      execFile(process.execPath, [CLI, 'hooks', 'print', 'opencode'], { env }, (error, stdout) => {
        if (error) reject(error)
        else resolve({ stdout: stdout as string })
      })
    )
    await writeHookFile(join(root, 'opencode', 'plugin', 'bmn.ts'), plugin)

    const report = await check(env)

    const opencode = agentNamed(report, 'opencode')
    expect(opencode).toMatchObject({ state: 'read', missing: [] })
    expect(opencode.entries).toEqual([{ event: 'plugin', optional: false, state: 'wired' }])
  })

  it('carries no configuration contents: commands, parse errors and read reasons stay out', async () => {
    const { root, env } = await configFixture()
    await writeHookFile(join(root, 'claude', 'settings.json'), '{ "hooks": "CLAUDE-SECRET-TOKEN" ')
    await writeHookFile(join(root, 'codex', 'hooks.json'), `${JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo CODEX-SECRET-COMMAND && bmn hook codex' }] }] }
    }, null, 2)}\n`)

    const report = await check(env)

    const text = JSON.stringify(report)
    expect(text).not.toContain('SECRET')
    expect(text).not.toContain('detail')
    expect(text).not.toContain('unrecognised')
    expect(text).not.toContain('gated')
    expect(report).toMatchObject({ state: 'checked' })
    const claude = agentNamed(report, 'claude')
    expect(claude).toMatchObject({ state: 'unparsable', missing: CLAUDE_EVENTS })
    expect(claude.entries.every((entry) => entry.state === 'missing')).toBe(true)
    // A command that only names the hook counts as missing, and is not quoted into the window.
    const codex = agentNamed(report, 'codex')
    expect(codex.entries.find((entry) => entry.event === 'Stop')).toMatchObject({ state: 'missing' })
    expect(codex.missing).toContain('Stop')
  })

  it('reads an unreadable file as its state, without the operating system reason', async () => {
    const { root, env } = await configFixture()
    const unreadable = join(root, 'claude', 'settings.json')
    await writeHookFile(unreadable, hookFile(CLAUDE_EVENTS, 'claude'))
    await chmod(unreadable, 0o000)

    try {
      const report = await check(env)

      expect(agentNamed(report, 'claude')).toMatchObject({ state: 'unreadable', missing: CLAUDE_EVENTS })
      expect(JSON.stringify(report)).not.toContain('EACCES')
    } finally {
      await chmod(unreadable, 0o600)
    }
  })

  it('keeps every harness row when the OpenCode plugin cannot be read', async () => {
    const { root, env } = await configFixture()
    await mkdir(join(root, 'opencode', 'plugin', 'bmn.ts'), { recursive: true })

    const report = await check(env)

    expect(report.state).toBe('checked')
    expect(agentNamed(report, 'opencode')).toMatchObject({ state: 'unreadable', missing: ['plugin'] })
    expect(report.state === 'checked' && report.agents.map((row) => row.agent)).toEqual(['claude', 'codex', 'opencode'])
  })

  it('leaves every hook file byte-for-byte unchanged', async () => {
    const { root, env } = await configFixture()
    const claude = join(root, 'claude', 'settings.json')
    const codex = join(root, 'codex', 'hooks.json')
    await writeHookFile(claude, hookFile(['Stop'], 'claude'))
    await writeHookFile(codex, hookFile(['Stop'], 'codex'))
    const before = await Promise.all([readFile(claude), readFile(codex)])

    await check(env)

    expect(await Promise.all([readFile(claude), readFile(codex)])).toEqual(before)
  })

  it('fails with a reason when the checker times out', async () => {
    const { root, env } = await configFixture()
    const stalling = join(root, 'stall-bmn.js')
    await writeFile(stalling, 'setTimeout(() => process.exit(0), 60000)\n')

    const report = await runHookConfigurationCheck(stalling, {
      env,
      timeoutMs: 300,
      now: () => new Date(checkedAt)
    })

    expect(report).toEqual({ state: 'failed', checkedAt, reason: 'The hook checker timed out' })
  })

  it('fails with a reason when the checker exits abnormally or prints no report', async () => {
    const { root, env } = await configFixture()
    const breaking = join(root, 'broken-bmn.js')
    await writeFile(breaking, 'process.exit(3)\n')
    const talking = join(root, 'talk-bmn.js')
    await writeFile(talking, "process.stdout.write('not a report\\n')\n")

    await expect(runHookConfigurationCheck(breaking, { env, now: () => new Date(checkedAt) })).resolves.toEqual({
      state: 'failed', checkedAt, reason: 'The hook checker exited with status 3'
    })
    await expect(runHookConfigurationCheck(talking, { env, now: () => new Date(checkedAt) })).resolves.toEqual({
      state: 'failed', checkedAt, reason: 'The hook checker printed a report BMN cannot read'
    })
  })

  it('fails with a reason when the checker cannot start', async () => {
    const { env } = await configFixture()

    const report = await runHookConfigurationCheck('/nonexistent/bmn', {
      executable: '/nonexistent/node',
      env,
      now: () => new Date(checkedAt)
    })

    expect(report).toEqual({ state: 'failed', checkedAt, reason: 'The hook checker could not start' })
  })
})
