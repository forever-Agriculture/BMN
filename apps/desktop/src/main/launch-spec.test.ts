import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { METHOD_REGISTRY, type ProtocolMethod } from '@ai-terminal/protocol'
import { prepareConversationLaunch } from '../utility/conversation-binding'
import {
  createApplicationSession,
  hasExplicitApplicationLaunch,
  parseApplicationLaunchSpec
} from './launch-spec'

const roots = new Set<string>()
const reference = '11111111-1111-4111-8111-111111111111'

afterEach(async () => {
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function executableFixture(): Promise<{ root: string; executable: string }> {
  const root = await mkdtemp(join(tmpdir(), 'aiterm-launch-spec-test-'))
  roots.add(root)
  const executable = join(root, 'codex')
  await writeFile(executable, '#!/bin/sh\n', 'utf8')
  await chmod(executable, 0o700)
  return { root, executable }
}

describe('application launch specification', () => {
  it('restores saved workspaces without creating a fresh session unless argv has --', () => {
    expect(hasExplicitApplicationLaunch(['electron', '.'])).toBe(false)
    expect(hasExplicitApplicationLaunch(['electron', '.', '--aiterm-test-mode'])).toBe(false)
    expect(hasExplicitApplicationLaunch(['electron', '.', '--', '/bin/bash'])).toBe(true)
  })

  it('takes only arguments after -- and reaches the Codex explicit-resume binding through the production caller', async () => {
    const { root, executable } = await executableFixture()
    const environment = { PATH: root, SHELL: '/bin/bash' }
    const launch = parseApplicationLaunchSpec(
      ['electron', '.', '--self-test', '--aiterm-test-mode', '--', 'codex', 'resume', reference],
      environment,
      root
    )
    const calls: Array<{ method: ProtocolMethod; params: object }> = []
    const client = {
      async request<Result>(method: ProtocolMethod, params: object): Promise<Result> {
        calls.push({ method, params })
        const prepared = await prepareConversationLaunch(
          'session-1',
          params as Parameters<typeof prepareConversationLaunch>[1],
          environment,
          () => 'unused',
          '2026-09-13T00:00:00.000Z',
          async () => ({ supported: false, detail: 'not Claude' })
        )
        return { sessionId: 'session-1', incarnationId: 'incarnation-1', binding: prepared.binding } as Result
      }
    }

    const created = await createApplicationSession<{
      binding: Awaited<ReturnType<typeof prepareConversationLaunch>>['binding']
    }>(client, launch, { cols: 80, rows: 24 })

    expect(launch).toEqual({ cwd: root, executable, argv: ['resume', reference] })
    expect(calls[0]).toMatchObject({
      method: METHOD_REGISTRY.sessionCreate,
      params: {
        workspaceId: '00000000-0000-4000-8000-000000000001',
        name: 'codex'
      }
    })
    expect(created.binding).toMatchObject({
      status: 'bound',
      agentCli: 'codex',
      conversationReference: reference,
      captureRoute: 'explicit-resume-reference'
    })
  })

  it.each([
    ['malformed', ['resume', 'not-a-uuid']],
    ['missing', ['resume']]
  ])('keeps a %s explicit Codex reference visible instead of opening a guessed chat', async (_case, argv) => {
    const { root } = await executableFixture()
    const environment = { PATH: root }
    const launch = parseApplicationLaunchSpec(
      ['electron', '.', '--', 'codex', ...argv],
      environment,
      root
    )
    const prepared = await prepareConversationLaunch(
      'session-2',
      launch,
      environment,
      () => 'unused',
      '2026-09-13T00:00:00.000Z',
      async () => ({ supported: false, detail: 'not Claude' })
    )

    expect(prepared.binding).toMatchObject({
      status: 'unsupported',
      agentCli: 'codex'
    })
    expect(prepared.binding.detail).toContain('cannot pin a TUI session id')
  })

  it('uses the configured shell without leaking self-test flags when -- is absent', () => {
    expect(
      parseApplicationLaunchSpec(
        ['electron', '.', '--self-test', '--aiterm-test-mode'],
        { AITERM_SHELL: '/bin/zsh' },
        '/workspace'
      )
    ).toEqual({ cwd: '/workspace', executable: '/bin/zsh', argv: [] })
    expect(() => parseApplicationLaunchSpec(['electron', '.', '--'], {}, '/workspace')).toThrow(
      'must be followed by an executable'
    )
  })
})
