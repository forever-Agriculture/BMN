import { describe, expect, it, vi } from 'vitest'
import { restoreArchive } from './archive-undo'
import type { SessionRecord, WorkspaceRecord } from '@bmn/protocol'

const workspace: WorkspaceRecord = { workspaceId: 'workspace', name: 'Saved work', defaultCwd: null, pinnedFilePaths: [], archivedAt: '2026-10-01', revision: 2, marker: 'none', position: 0 }
const session = { sessionId: 'session', workspaceId: 'workspace', name: 'Stopped', archivedAt: '2026-10-01', revision: 3 } as SessionRecord
function api() {
  return { listWorkspaces: vi.fn().mockResolvedValue([workspace]), listSessions: vi.fn().mockResolvedValue([session]),
    updateWorkspace: vi.fn().mockResolvedValue({ ...workspace, archivedAt: null, revision: 3 }),
    updateSession: vi.fn().mockResolvedValue({ ...session, archivedAt: null, revision: 4 }) }
}
describe('one revision-addressed archive Undo', () => {
  it('restores the captured workspace once using its returned revision', async () => {
    const ownerApi = api()
    expect(await restoreArchive({ kind: 'workspace', id: 'workspace', revision: 2 }, ownerApi)).toMatchObject({ kind: 'workspace', record: { archivedAt: null } })
    expect(ownerApi.updateWorkspace).toHaveBeenCalledExactlyOnceWith({ workspaceId: 'workspace', expectedRevision: 2, archived: false })
    expect(ownerApi.updateSession).not.toHaveBeenCalled()
  })
  it.each([null, '2026-10-02'])('refuses restored or changed workspace %s', async archivedAt => {
    const ownerApi = api(); ownerApi.listWorkspaces.mockResolvedValue([{ ...workspace, archivedAt, revision: 4 }])
    await expect(restoreArchive({ kind: 'workspace', id: 'workspace', revision: 2 }, ownerApi)).rejects.toThrow(/changed/)
    expect(ownerApi.updateWorkspace).not.toHaveBeenCalled()
  })
  it('never restores the parent on behalf of a session', async () => {
    const ownerApi = api()
    await expect(restoreArchive({ kind: 'session', id: 'session', revision: 3 }, ownerApi)).rejects.toThrow(/parent workspace/)
    expect(ownerApi.updateSession).not.toHaveBeenCalled(); expect(ownerApi.updateWorkspace).not.toHaveBeenCalled()
  })
  it('restores a stopped session without actions on any other record', async () => {
    const ownerApi = api(); ownerApi.listWorkspaces.mockResolvedValue([{ ...workspace, archivedAt: null }])
    await restoreArchive({ kind: 'session', id: 'session', revision: 3 }, ownerApi)
    expect(ownerApi.updateSession).toHaveBeenCalledExactlyOnceWith({ sessionId: 'session', expectedRevision: 3, archived: false })
  })
  it('propagates a host revision refusal after the read', async () => {
    const ownerApi = api(); ownerApi.updateWorkspace.mockRejectedValue(new Error('Revision conflict'))
    await expect(restoreArchive({ kind: 'workspace', id: 'workspace', revision: 2 }, ownerApi)).rejects.toThrow('Revision conflict')
  })
  it('rejects deleted and re-archived sessions', async () => {
    const ownerApi = api(); ownerApi.listWorkspaces.mockResolvedValue([{ ...workspace, archivedAt: null }])
    ownerApi.listSessions.mockResolvedValue([{ ...session, revision: 5 }])
    await expect(restoreArchive({ kind: 'session', id: 'session', revision: 3 }, ownerApi)).rejects.toThrow(/changed/)
    ownerApi.listSessions.mockResolvedValue([])
    await expect(restoreArchive({ kind: 'session', id: 'session', revision: 3 }, ownerApi)).rejects.toThrow(/no longer available/)
    expect(ownerApi.updateSession).not.toHaveBeenCalled()
  })
})
