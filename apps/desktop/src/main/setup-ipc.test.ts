// MODULE: setup-ipc.test.ts - Exact setup commands, owner actions and confirmation admission
import { expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { SETUP_INSTALL_COMMANDS, METHOD_REGISTRY, type SessionRecord, type SetupAppsSnapshot, type SetupDefaultsReport } from '@bmn/protocol'
import { installSetupIpcHandlers } from './setup-ipc'
import type { SetupReadinessReader } from './setup-readiness'

const allowed = { allowed: true } as unknown as IpcMainInvokeEvent
function fixture(curlAvailable = true) {
  const handlers = new Map<string, (event: IpcMainInvokeEvent, params?: unknown) => unknown>()
  const snapshot: SetupAppsSnapshot = { platform: 'linux', curlAvailable, checkedAt: '2026-10-20T00:00:00.000Z',
    apps: [{ app: 'codex', program: '/synthetic/codex', onPath: true, version: '0.163.0', signIn: 'unknown', method: null, qualification: 'failed' }] }
  const read = vi.fn(async () => snapshot), confirm = vi.fn()
  const defaultsReport = vi.fn((): SetupDefaultsReport => ({ code: 'NOT_APPROVED', source: null, names: [], rows: [] }))
  let evidence: unknown = { codex: 'not-observed' }
  const create = vi.fn(async params => params)
  let known: SessionRecord | undefined
  const request = vi.fn(async (method: string) => method === METHOD_REGISTRY.setupHookEvidence ? evidence : method === METHOD_REGISTRY.setupWorkspace
    ? { workspaceId: 'synthetic-workspace', state: 'existing', revision: 2, updatedAt: snapshot.checkedAt }
    : known ? [known] : [])
  installSetupIpcHandlers({ handle: (channel, handler) => handlers.set(channel, handler) }, {
    senderIsAllowed: event => (event as unknown as { allowed: boolean }).allowed,
    reader: { read, confirm } as unknown as SetupReadinessReader,
    client: () => ({ request: request as never }), createSession: create,
    session: () => known, defaultsReport
  })
  return { handlers, create, read, confirm, snapshot, request, defaultsReport,
    setKnown: (record: SessionRecord) => { known = record }, setEvidence: (value: unknown) => { evidence = value } }
}

it('exposes cached defaults only to the owner window without starting another native probe', () => {
  const f = fixture()
  expect(() => f.handlers.get('aiterm:setup:defaults')!({ allowed: false } as unknown as IpcMainInvokeEvent))
    .toThrowError(expect.objectContaining({ code: 'UNAUTHORIZED' }))
  expect(f.defaultsReport).not.toHaveBeenCalled()
  expect(f.handlers.get('aiterm:setup:defaults')!(allowed)).toMatchObject({ code: 'NOT_APPROVED' })
  expect(f.read).not.toHaveBeenCalled()
})

it('starts measured install and direct login commands with create-time setup metadata', async () => {
  const f = fixture()
  await f.handlers.get('aiterm:setup:start')!(allowed, { app: 'codex', action: 'install', expectedProgram: '/synthetic/codex' })
  expect(f.create).toHaveBeenLastCalledWith(expect.objectContaining({
    executable: SETUP_INSTALL_COMMANDS.codex.executable, argv: SETUP_INSTALL_COMMANDS.codex.argv,
    setup: { app: 'codex', action: 'install' }, workspaceId: 'synthetic-workspace'
  }))
  await f.handlers.get('aiterm:setup:start')!(allowed, { app: 'codex', action: 'login', expectedProgram: '/synthetic/codex' })
  expect(f.create).toHaveBeenLastCalledWith(expect.objectContaining({
    executable: '/synthetic/codex', argv: ['login'], setup: { app: 'codex', action: 'login' }
  }))
})

it('refuses root prerequisites and changed commands without starting a session', async () => {
  const f = fixture(false)
  await expect(f.handlers.get('aiterm:setup:start')!(allowed, { app: 'codex', action: 'install', expectedProgram: '/synthetic/codex' }))
    .rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(f.handlers.get('aiterm:setup:start')!(allowed, { app: 'codex', action: 'login', expectedProgram: '/changed/codex' }))
    .rejects.toMatchObject({ code: 'REVISION_CONFLICT' })
  expect(f.create).not.toHaveBeenCalled()
})

it('requires the owner window and an actual completed app session before a confirmation', async () => {
  const f = fixture()
  expect(() => f.handlers.get('aiterm:setup:apps')!({ allowed: false } as unknown as IpcMainInvokeEvent))
    .toThrowError(expect.objectContaining({ code: 'UNAUTHORIZED' }))
  expect(f.read).not.toHaveBeenCalled()
  const input = { app: 'codex', sessionId: 'synthetic-session', version: '0.163.0' }
  await expect(f.handlers.get('aiterm:setup:confirm')!(allowed, input)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  const record = { sessionId: input.sessionId, workspaceId: 'synthetic-workspace', setup: { app: 'codex', action: 'install' },
    lastProcess: { state: 'exited' } } as SessionRecord
  f.setKnown(record)
  await expect(f.handlers.get('aiterm:setup:confirm')!(allowed, input)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  record.setup!.action = 'check'
  await f.handlers.get('aiterm:setup:confirm')!(allowed, input)
  expect(f.confirm).toHaveBeenCalledWith('codex', '0.163.0')
})

it('admits only one concurrent start for an app', async () => {
  const f = fixture()
  const input = { app: 'codex', action: 'login', expectedProgram: '/synthetic/codex' }
  const outcomes = await Promise.allSettled([f.handlers.get('aiterm:setup:start')!(allowed, input), f.handlers.get('aiterm:setup:start')!(allowed, input)])
  expect(outcomes.filter(row => row.status === 'fulfilled')).toHaveLength(1)
  expect(f.create).toHaveBeenCalledOnce()
})


it('shows Codex trust only for setup-installed hooks and never infers observation from a failed/malformed read', async () => {
  const f = fixture(), read = () => f.handlers.get('aiterm:setup:apps')!(allowed) as Promise<SetupAppsSnapshot>
  expect((await read()).apps[0]?.hookTrust).toBeUndefined()
  expect(f.request).not.toHaveBeenCalledWith(METHOD_REGISTRY.setupHookEvidence, expect.anything())
  f.defaultsReport.mockReturnValue({ code: 'OK', source: '/synthetic', names: [], rows: [{
    kind: 'hooks', app: 'codex', code: 'OK', state: 'installed', transaction: 'synthetic', paths: [], recoveryPaths: [] }] })
  expect((await read()).apps[0]?.hookTrust).toBe('pending')
  f.setEvidence({ codex: 'observed', secret: 'synthetic-extra-field' })
  const observed = await read(); expect(observed.apps[0]?.hookTrust).toBe('observed')
  expect(JSON.stringify(observed)).not.toContain('synthetic-extra-field')
  f.setEvidence({ codex: 'unknown-value' }); expect((await read()).apps[0]?.hookTrust).toBe('unavailable')
})
