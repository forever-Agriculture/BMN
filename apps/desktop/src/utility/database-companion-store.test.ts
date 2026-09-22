import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_APP_SETTINGS,
  ERROR_CODES,
  type ArtifactRecord,
  type ProgressRecord,
  type ProgressState
} from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  artifactBytesUsed,
  claimHandoffDraft,
  closeAttention,
  createDraft,
  discardHandoffDraft,
  expireAttention,
  finishHandoffDraft,
  getAttention,
  getDraft,
  getReceipt,
  getSettings,
  getTelegramMessage,
  insertArtifact,
  listAgentHandoffs,
  listArtifacts,
  listAttention,
  listDrafts,
  listProgress,
  markAttentionSeen,
  markStaleAgentHandoffs,
  appendAttentionBody,
  openAttention,
  prepareAgentHandoff,
  putReceipt,
  putSettingsSection,
  putTelegramMessage,
  setArtifactState,
  updateDraft,
  updateHandoffDraft,
  upsertProgress,
  withdrawAgentHandoff
} from './database-companion-store'
import { initializeDatabase, type DatabaseConnection } from './database-initialization'
import { DEFAULT_WORKSPACE_ID } from './store-schema'

const testRequire = createRequire(import.meta.url)
const BetterSqlite3 = testRequire('better-sqlite3') as new (path: string) => DatabaseConnection
const now = '2026-09-14T12:00:00.000Z'
let database: DatabaseConnection

beforeEach(() => {
  database = new BetterSqlite3(':memory:')
  initializeDatabase(database, now)
  database.prepare(
    `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
     VALUES ('s1', ?, 'One', '/work', '/bin/bash', '[]', 1, ?, 0)`
  ).run(DEFAULT_WORKSPACE_ID, now)
  database.prepare(
    `INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
     VALUES ('s2', ?, 'Two', '/work/two', '/bin/bash', '[]', 1, ?, 1)`
  ).run(DEFAULT_WORKSPACE_ID, now)
})

afterEach(() => database.close())

function artifact(id: string, bytes: number): ArtifactRecord {
  return {
    artifactId: id,
    sessionId: 's1',
    incarnationId: null,
    direction: 'input',
    source: 'owner',
    originalName: `${id}.png`,
    mediaType: 'image/png',
    byteLength: bytes,
    sha256: 'a'.repeat(64),
    storedPath: `/store/aa/${id}`,
    sourcePath: null,
    state: 'ready',
    createdAt: now
  }
}

/** What `bmn publish` stores: this session's own output, ready to be referenced. */
function published(id: string): ArtifactRecord {
  return { ...artifact(id, 10), direction: 'output', source: 'agent' }
}

function progress(observedAt: string, state: ProgressState = 'claimed-done'): Omit<ProgressRecord, 'evidence'> {
  return {
    sessionId: 's1', source: 'agent', incarnationId: 'i1', state, label: 'Story 12.1',
    detail: null, observedAt, receivedAt: now
  }
}

function agentHandoff(draftId: string, requestId: string, createdAt: string = now) {
  return {
    draftId,
    requestId,
    sourceSessionId: 's1',
    sourceIncarnationId: 'incarnation-1',
    destinationSessionId: 's2',
    destinationName: 'Two',
    text: 'A result for the other session',
    artifactIds: [] as string[],
    createdAt
  }
}

describe('companion store', () => {
  it('records artifacts, their quota use and state', () => {
    insertArtifact(database, artifact('a1', 10))
    insertArtifact(database, artifact('a2', 32))
    expect(artifactBytesUsed(database)).toBe(42)
    expect(listArtifacts(database, 's1').map((row) => row.artifactId).sort()).toEqual(['a1', 'a2'])
    expect(setArtifactState(database, 'a1', 'missing').state).toBe('missing')
    expect(() => setArtifactState(database, 'nope', 'missing')).toThrow(
      expect.objectContaining({ code: ERROR_CODES.notFound })
    )
  })

  it('keeps one open attention per key until a correlated close', () => {
    const params = { sessionId: 's1', incarnationId: 'i1', requestKey: 'k', kind: 'question' as const, title: 'Pick?' }
    const first = openAttention(database, params, 'r1', now)
    expect(openAttention(database, params, 'r2', now).requestId).toBe('r1')
    const revised = openAttention(database, { ...params, title: 'Pick now?' }, 'r3', now)
    expect(revised).toMatchObject({ requestId: 'r1', title: 'Pick now?', revision: 2 })

    const seen = markAttentionSeen(database, first.requestId, now)
    expect(seen).toMatchObject({ state: 'open', seenAt: now })

    const answered = closeAttention(database, { sessionId: 's1', requestKey: 'k' }, 'answered', 'yes', now)
    expect(answered).toMatchObject({ state: 'answered', resolution: 'yes' })
    expect(() => closeAttention(database, { requestId: 'r1' }, 'answered', 'again', now)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.notFound })
    )

    const reopened = openAttention(database, params, 'r4', now)
    expect(reopened.requestId).toBe('r4')
    expect(listAttention(database).map((row) => [row.requestId, row.state])).toEqual([
      ['r4', 'open'],
      ['r1', 'answered']
    ])
  })

  it('adds to an open request without moving its revision, and refuses a closed one', () => {
    // The desktop notifier and the pending Telegram page both key on `requestId:revision`, so
    // touching the revision here would notify twice and never page. Returning null for a request
    // that is no longer open is what makes the read and the write one step.
    const opened = openAttention(database, {
      sessionId: 's1', incarnationId: null, requestKey: 'growing', kind: 'notice', title: 'Building'
    }, 'r-growing', now)
    const seen = markAttentionSeen(database, opened.requestId, now)

    const grown = appendAttentionBody(database, opened.requestId, 'one\ntwo')

    expect(grown).toMatchObject({ body: 'one\ntwo', revision: opened.revision, seenAt: seen.seenAt, state: 'open' })

    // It replaces the body rather than adding to it: the caller owns the whole text, because the
    // lines it keeps are the ones the owner has not read yet.
    expect(appendAttentionBody(database, opened.requestId, 'two\nthree'))
      .toMatchObject({ body: 'two\nthree', revision: opened.revision })

    closeAttention(database, { requestId: opened.requestId }, 'answered', 'done', now)

    expect(appendAttentionBody(database, opened.requestId, 'three')).toBeNull()
    expect(appendAttentionBody(database, 'never-existed', 'three')).toBeNull()
  })

  it('does not close a request that changed kind or revision before activation', () => {
    const first = openAttention(database, {
      sessionId: 's1', incarnationId: null, requestKey: 'changing', kind: 'notice', title: 'Finished'
    }, 'r-changing', now)
    const revised = openAttention(database, {
      sessionId: 's1', incarnationId: null, requestKey: 'changing', kind: 'question', title: 'Continue?'
    }, 'unused', now)

    expect(() => closeAttention(database, {
      requestId: first.requestId,
      expectedKind: first.kind,
      expectedRevision: first.revision
    }, 'answered', 'Opened in BMN', now)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.revisionConflict })
    )
    expect(listAttention(database)[0]).toMatchObject({
      requestId: first.requestId,
      kind: 'question',
      state: 'open',
      revision: revised.revision
    })
  })

  it('expires only past-due open requests, and says expiry closed them', () => {
    openAttention(database, {
      sessionId: 's1', incarnationId: null, requestKey: 'old', kind: 'permission', title: 'Old',
      expiresAt: '2026-09-14T11:00:00.000Z'
    }, 'r1', now)
    openAttention(database, { sessionId: 's1', incarnationId: null, requestKey: 'new', kind: 'notice', title: 'New' }, 'r2', now)
    expect(expireAttention(database, now)).toBe(1)
    expect(listAttention(database).find((row) => row.requestId === 'r1')).toMatchObject({
      state: 'expired',
      resolvedBy: 'expiry'
    })
  })

  it('stores what opened and what closed a request, and leaves both null when nobody says', () => {
    openAttention(database, {
      sessionId: 's1', incarnationId: null, requestKey: 'k', kind: 'question', title: 'Which?',
      origin: 'hook:claude:Notification'
    }, 'r1', now)
    const closed = closeAttention(
      database, { sessionId: 's1', requestKey: 'k' }, 'answered', 'yes', now, 'hook:claude:PostToolUse'
    )
    openAttention(database, { sessionId: 's2', incarnationId: null, requestKey: 'k', kind: 'notice', title: 'Done' }, 'r2', now)
    const anonymous = closeAttention(database, { sessionId: 's2', requestKey: 'k' }, 'withdrawn', null, now)

    expect(closed).toMatchObject({ openedBy: 'hook:claude:Notification', resolvedBy: 'hook:claude:PostToolUse' })
    expect(anonymous).toMatchObject({ openedBy: null, resolvedBy: null })
  })

  it('reopening the same request with only a different origin changes nothing the owner can see', () => {
    const first = openAttention(database, {
      sessionId: 's1', incarnationId: null, requestKey: 'k', kind: 'question', title: 'Which?', origin: 'cli'
    }, 'r1', now)
    markAttentionSeen(database, first.requestId, now)
    const again = openAttention(database, {
      sessionId: 's1', incarnationId: null, requestKey: 'k', kind: 'question', title: 'Which?',
      origin: 'hook:codex:PreToolUse'
    }, 'r2', now)

    // Provenance is display-only: a repeat that says only a different origin must not bump the revision
    // an owner action is checked against, nor make a request the owner already read unread again.
    expect(again.requestId).toBe(first.requestId)
    expect(again.revision).toBe(first.revision)
    expect(again.seenAt).toBe(now)
    expect(again.openedBy).toBe('cli')
    // Reported, never stored: the caller needs to be able to say the event changed nothing.
    expect(first.changed).toBe(true)
    expect(again.changed).toBe(false)
  })

  it('reopening with changed content still records the origin that changed it', () => {
    const first = openAttention(database, {
      sessionId: 's1', incarnationId: null, requestKey: 'k', kind: 'question', title: 'Which?', origin: 'cli'
    }, 'r1', now)
    const again = openAttention(database, {
      sessionId: 's1', incarnationId: null, requestKey: 'k', kind: 'question', title: 'Which one now?',
      origin: 'hook:codex:PreToolUse'
    }, 'r2', now)

    expect(again.requestId).toBe(first.requestId)
    expect(again.revision).toBe(first.revision + 1)
    expect(again.openedBy).toBe('hook:codex:PreToolUse')
    expect(again.changed).toBe(true)
  })

  it('keeps the newest progress observation per source', () => {
    const base = {
      sessionId: 's1', source: 'agent', incarnationId: 'i1', label: 'Story 2.2', detail: null, receivedAt: now
    }
    expect(upsertProgress(database, { ...base, state: 'running', observedAt: '2026-09-14T12:00:00.000Z' }).applied).toBe(true)
    expect(upsertProgress(database, { ...base, state: 'failed', observedAt: '2026-09-14T11:00:00.000Z' }).applied).toBe(false)
    expect(upsertProgress(database, { ...base, state: 'claimed-done', observedAt: '2026-09-14T12:05:00.000Z' }).applied).toBe(true)
    expect(listProgress(database)).toEqual([
      expect.objectContaining({ state: 'claimed-done', observedAt: '2026-09-14T12:05:00.000Z', evidence: [] })
    ])
  })

  it('links only files the same session published, and snapshots their names', () => {
    insertArtifact(database, published('out-1'))
    insertArtifact(database, published('out-2'))
    const stored = upsertProgress(database, progress('2026-09-14T12:00:00.000Z'), ['out-2', 'out-1'])

    expect(stored.applied).toBe(true)
    // The order given is the order kept, so the reporter decides what reads first.
    expect(stored.record.evidence).toEqual([
      { artifactId: 'out-2', name: 'out-2.png' },
      { artifactId: 'out-1', name: 'out-1.png' }
    ])
    expect(listProgress(database)[0]?.evidence).toEqual(stored.record.evidence)
  })

  it('refuses a report whose evidence is not this session\'s own published output', () => {
    insertArtifact(database, published('out-1'))
    // Handed to the session, not published by it: an agent must not cite its own brief as proof.
    insertArtifact(database, { ...published('given'), direction: 'input' })
    insertArtifact(database, { ...published('elsewhere'), sessionId: 's2' })
    insertArtifact(database, { ...published('detached'), sessionId: null })
    insertArtifact(database, { ...published('gone'), state: 'missing' })

    for (const id of ['given', 'elsewhere', 'detached', 'gone', 'never-published']) {
      expect(() => upsertProgress(database, progress('2026-09-14T12:00:00.000Z'), [id]))
        .toThrow(expect.objectContaining({ code: ERROR_CODES.invalidArgument }))
    }
    expect(() => upsertProgress(database, progress('2026-09-14T12:00:00.000Z'), ['out-1', 'out-1']))
      .toThrow(/given twice/)
    expect(() => upsertProgress(database, progress('2026-09-14T12:00:00.000Z'), Array(11).fill('out-1')))
      .toThrow(/at most 10/)
    // Nothing was written by any of the refusals.
    expect(listProgress(database)).toEqual([])
  })

  it('refuses the whole report on bad evidence, leaving the previous observation and its files', () => {
    insertArtifact(database, published('out-1'))
    upsertProgress(database, progress('2026-09-14T12:00:00.000Z', 'running'), ['out-1'])

    expect(() => upsertProgress(database, progress('2026-09-14T12:09:00.000Z', 'verified'), ['out-1', 'nope']))
      .toThrow(/not a file this session published/)

    expect(listProgress(database)).toEqual([
      expect.objectContaining({
        state: 'running',
        observedAt: '2026-09-14T12:00:00.000Z',
        evidence: [{ artifactId: 'out-1', name: 'out-1.png' }]
      })
    ])
  })

  it('replaces links with the new report and never inherits the previous report\'s files', () => {
    insertArtifact(database, published('out-1'))
    insertArtifact(database, published('out-2'))
    upsertProgress(database, progress('2026-09-14T12:00:00.000Z'), ['out-1'])

    upsertProgress(database, progress('2026-09-14T12:01:00.000Z'), ['out-2'])
    expect(listProgress(database)[0]?.evidence).toEqual([{ artifactId: 'out-2', name: 'out-2.png' }])

    upsertProgress(database, progress('2026-09-14T12:02:00.000Z'))
    expect(listProgress(database)[0]?.evidence).toEqual([])
  })

  it('keeps an out-of-order report from replacing the current observation or its files', () => {
    insertArtifact(database, published('out-1'))
    insertArtifact(database, published('out-2'))
    insertArtifact(database, published('out-3'))
    upsertProgress(database, progress('2026-09-14T12:05:00.000Z', 'verified'), ['out-2', 'out-1'])

    const older = upsertProgress(database, progress('2026-09-14T12:00:00.000Z', 'running'), ['out-3'])

    // The refusal hands back the observation that stands, with its own files in their own order.
    expect(older.applied).toBe(false)
    expect(older.record.evidence).toEqual([
      { artifactId: 'out-2', name: 'out-2.png' },
      { artifactId: 'out-1', name: 'out-1.png' }
    ])
    expect(listProgress(database)).toEqual([
      expect.objectContaining({
        state: 'verified',
        evidence: [{ artifactId: 'out-2', name: 'out-2.png' }, { artifactId: 'out-1', name: 'out-1.png' }]
      })
    ])
  })

  it('lets a report at the very same observed time replace the one before it, files and all', () => {
    insertArtifact(database, published('out-1'))
    insertArtifact(database, published('out-2'))
    const sameMoment = '2026-09-14T12:00:00.000Z'
    upsertProgress(database, progress(sameMoment, 'running'), ['out-1'])

    // Only a strictly older observation is refused, so a tie replaces — and must carry its own files.
    const tie = upsertProgress(database, progress(sameMoment, 'verified'), ['out-2'])

    expect(tie.applied).toBe(true)
    expect(listProgress(database)).toEqual([
      expect.objectContaining({
        state: 'verified',
        observedAt: sameMoment,
        evidence: [{ artifactId: 'out-2', name: 'out-2.png' }]
      })
    ])
  })

  it('keeps a link and its name after the original is lost, and never deletes the original', () => {
    insertArtifact(database, published('out-1'))
    upsertProgress(database, progress('2026-09-14T12:00:00.000Z'), ['out-1'])

    setArtifactState(database, 'out-1', 'missing')
    expect(listProgress(database)[0]?.evidence).toEqual([{ artifactId: 'out-1', name: 'out-1.png' }])

    // A later report drops the link; the stored file itself is untouched.
    upsertProgress(database, progress('2026-09-14T12:01:00.000Z'))
    expect(listProgress(database)[0]?.evidence).toEqual([])
    expect(listArtifacts(database, 's1').map((row) => row.artifactId)).toContain('out-1')
  })

  it('stores control receipts with results and errors', () => {
    putReceipt(database, { key: 'k1', paramsHash: 'h', state: 'staged' }, now)
    expect(getReceipt(database, 'k1')).toEqual({ key: 'k1', paramsHash: 'h', state: 'staged' })
    putReceipt(database, { key: 'k1', paramsHash: 'h', state: 'done', result: { ok: 1 } }, now)
    expect(getReceipt(database, 'k1')).toEqual({ key: 'k1', paramsHash: 'h', state: 'done', result: { ok: 1 } })
    expect(getReceipt(database, 'missing')).toBeUndefined()
  })

  it('creates a draft once per origin and tracks its state', () => {
    const draft = {
      draftId: 'd1', sessionId: 's1', origin: 'telegram' as const, originKey: 'tg:5', requestId: null,
      text: 'hello', artifactId: null, state: 'draft' as const, detail: null
    }
    expect(createDraft(database, draft, now).created).toBe(true)
    expect(createDraft(database, { ...draft, draftId: 'd2' }, now)).toMatchObject({
      created: false,
      record: { draftId: 'd1' }
    })
    updateDraft(database, 'd1', 'discarded', null, now)
    expect(listDrafts(database)).toEqual([])
  })

  it('persists handoff metadata, edits monotonically, and claims one paste attempt', () => {
    insertArtifact(database, artifact('handoff-file', 10))
    const created = createDraft(database, {
      draftId: 'handoff-1', sessionId: 's2', origin: 'handoff', originKey: null,
      sourceSessionId: 's1', requestId: null, text: 'Review this', artifactId: null,
      artifactIds: ['handoff-file'], attemptedIncarnationId: null,
      state: 'draft', detail: null
    }, now).record
    expect(created).toMatchObject({
      sourceSessionId: 's1', sessionId: 's2', artifactIds: ['handoff-file'], state: 'draft'
    })

    const edited = updateHandoffDraft(database, created.draftId, {
      sessionId: 's2', sourceSessionId: 's1', text: 'Review this now',
      artifactIds: ['handoff-file'], expectedUpdatedAt: created.updatedAt
    }, '2026-09-14T11:00:00.000Z')
    expect(Date.parse(edited.updatedAt)).toBe(Date.parse(created.updatedAt) + 1)
    expect(() => updateHandoffDraft(database, created.draftId, {
      sessionId: 's2', sourceSessionId: 's1', text: 'Stale edit', artifactIds: [],
      expectedUpdatedAt: created.updatedAt
    }, now)).toThrow(expect.objectContaining({ code: ERROR_CODES.revisionConflict }))

    const firstClaim = claimHandoffDraft(database, edited.draftId, edited.updatedAt, 'incarnation-2', now)
    const duplicate = claimHandoffDraft(database, edited.draftId, edited.updatedAt, 'incarnation-2', now)
    expect(firstClaim).toMatchObject({ claimed: true, record: { state: 'uncertain', detail: 'Pasting…' } })
    expect(duplicate).toMatchObject({ claimed: false, record: { state: 'uncertain' } })
    const accepted = finishHandoffDraft(database, edited.draftId, 'accepted', 'Pasted to terminal — not submitted', now)
    expect(accepted).toMatchObject({
      state: 'accepted', attemptedIncarnationId: 'incarnation-2',
      detail: 'Pasted to terminal — not submitted'
    })
    expect(() => updateHandoffDraft(database, edited.draftId, {
      sessionId: 's2', sourceSessionId: 's1', text: 'Too late', artifactIds: [],
      expectedUpdatedAt: accepted.updatedAt
    }, now)).toThrow(/Only an unsent handoff/)
  })

  it('creates an agent petition and exposes only its own metadata projection', () => {
    const prepared = prepareAgentHandoff(database, agentHandoff('agent-draft', 'agent-request'), now)

    expect(prepared).toEqual({ draftId: 'agent-draft', requestId: 'agent-request', state: 'draft' })
    expect(getDraft(database, 'agent-draft')).toMatchObject({
      draftId: 'agent-draft', sessionId: 's2', sourceSessionId: 's1', preparedBy: 'agent',
      requestId: 'agent-request', text: 'A result for the other session', state: 'draft'
    })
    expect(getAttention(database, 'agent-request')).toMatchObject({
      sessionId: 's1', incarnationId: 'incarnation-1', requestKey: 'handoff:agent-draft',
      kind: 'handoff', title: 'Asks to hand off to "Two"', body: 'A result for the other session',
      state: 'open', openedBy: 'cli', expiresAt: '2026-09-15T12:00:00.000Z'
    })
    expect(listAgentHandoffs(database, 's1')).toEqual([{
      draftId: 'agent-draft', destinationSessionId: 's2', state: 'draft',
      updatedAt: now
    }])
    expect(listAgentHandoffs(database, 's2')).toEqual([])
  })

  it('rolls back a petition when the draft and attention cannot commit together', () => {
    openAttention(database, {
      sessionId: 's2', incarnationId: null, requestKey: 'occupied', kind: 'notice', title: 'Occupied'
    }, 'request-clash', now)

    expect(() => database.transaction(() => prepareAgentHandoff(
      database, agentHandoff('rolled-back-draft', 'request-clash'), now
    ))()).toThrow()
    expect(() => getDraft(database, 'rolled-back-draft')).toThrow(expect.objectContaining({ code: ERROR_CODES.notFound }))
    expect(listAgentHandoffs(database, 's1')).toEqual([])
    expect(listAttention(database)).toHaveLength(1)
  })

  it('enforces the ten-second rate limit and three pending handoff cap', () => {
    const at = (seconds: number) => new Date(Date.parse(now) + seconds * 1000).toISOString()
    const prepare = (number: number, seconds: number) => prepareAgentHandoff(
      database, agentHandoff(`agent-draft-${number}`, `agent-request-${number}`, at(seconds)), at(seconds)
    )

    prepare(1, 0)
    expect(() => prepare(2, 1)).toThrow(/Wait 10 seconds/)
    prepare(2, 10)
    prepare(3, 20)
    expect(() => prepare(4, 30)).toThrow(/three pending handoffs/)
    expect(listAgentHandoffs(database, 's1')).toHaveLength(3)
    expect(listAttention(database).filter((record) => record.kind === 'handoff' && record.state === 'open'))
      .toHaveLength(3)
  })

  it('withdraws a draft before owner editing and keeps owner edits after withdrawal', () => {
    const first = prepareAgentHandoff(database, agentHandoff('withdraw-before', 'withdraw-before-request'), now)
    const firstRequest = withdrawAgentHandoff(database, 's1', first.draftId, '2026-09-14T12:00:01.000Z')
    expect(firstRequest).toMatchObject({ state: 'withdrawn', resolution: 'withdrawn by agent', resolvedBy: 'cli' })
    expect(getDraft(database, first.draftId)).toMatchObject({ state: 'discarded', detail: 'Withdrawn by the agent' })

    const second = prepareAgentHandoff(
      database, agentHandoff('withdraw-after', 'withdraw-after-request', '2026-09-14T12:00:10.000Z'),
      '2026-09-14T12:00:10.000Z'
    )
    const edited = updateHandoffDraft(database, second.draftId, {
      sessionId: 's2', sourceSessionId: 's1', text: 'Owner edit kept here', artifactIds: [],
      expectedUpdatedAt: getDraft(database, second.draftId).updatedAt
    }, '2026-09-14T12:00:11.000Z')
    const secondRequest = withdrawAgentHandoff(database, 's1', second.draftId, '2026-09-14T12:00:12.000Z')
    expect(secondRequest).toMatchObject({ state: 'withdrawn', resolution: 'withdrawn by agent', resolvedBy: 'cli' })
    expect(secondRequest.body).toContain('The agent withdrew this; the owner\'s edits are kept')
    expect(getDraft(database, second.draftId)).toMatchObject({
      state: 'draft', text: 'Owner edit kept here',
      detail: "The agent withdrew this; the owner's edits are kept"
    })
    expect(Date.parse(getDraft(database, second.draftId).updatedAt)).toBeGreaterThan(Date.parse(edited.updatedAt))
  })

  it('resolves delivery, owner discard, and expiry with the draft state', () => {
    const delivered = prepareAgentHandoff(database, agentHandoff('delivered', 'delivered-request'), now)
    const claimed = claimHandoffDraft(database, delivered.draftId, now, 'incarnation-2', '2026-09-14T12:00:01.000Z')
    expect(claimed.claimed).toBe(true)
    const accepted = finishHandoffDraft(
      database, delivered.draftId, 'accepted', 'Pasted to terminal — not submitted', '2026-09-14T12:00:02.000Z'
    )
    expect(accepted).toMatchObject({ state: 'accepted', detail: 'Pasted to terminal — not submitted' })
    expect(getAttention(database, delivered.requestId)).toMatchObject({
      state: 'answered', resolution: 'pasted, not submitted', resolvedBy: 'owner'
    })

    const discarded = prepareAgentHandoff(
      database, agentHandoff('discarded', 'discarded-request', '2026-09-14T12:00:10.000Z'),
      '2026-09-14T12:00:10.000Z'
    )
    expect(discardHandoffDraft(database, discarded.draftId, '2026-09-14T12:00:11.000Z')).toMatchObject({
      state: 'discarded'
    })
    expect(getAttention(database, discarded.requestId)).toMatchObject({
      state: 'answered', resolution: 'discarded', resolvedBy: 'owner'
    })

    const expiredAt = '2026-09-14T12:00:20.000Z'
    const expired = prepareAgentHandoff(database, agentHandoff('expired', 'expired-request', expiredAt), expiredAt)
    expect(expireAttention(database, '2026-09-15T12:00:20.000Z')).toBe(1)
    expect(getAttention(database, expired.requestId)).toMatchObject({ state: 'expired', resolvedBy: 'expiry' })
    expect(getDraft(database, expired.draftId)).toMatchObject({
      state: 'discarded', detail: 'The handoff request expired'
    })
  })

  it('marks a pending source request stale once its incarnation changes', () => {
    const prepared = prepareAgentHandoff(database, agentHandoff('stale', 'stale-request'), now)
    expect(markStaleAgentHandoffs(database, { s1: 'incarnation-new' })).toBe(1)
    expect(getAttention(database, prepared.requestId).body)
      .toContain('prepared by an earlier process of this session')
    expect(markStaleAgentHandoffs(database, { s1: 'incarnation-new' })).toBe(0)
  })

  it('maps Telegram messages to sessions', () => {
    putTelegramMessage(database, 77, 's1', 'r1', 'incarnation-1', now)
    expect(getTelegramMessage(database, 77)).toEqual({
      sessionId: 's1', requestId: 'r1', incarnationId: 'incarnation-1'
    })
    expect(getTelegramMessage(database, 78)).toBeUndefined()
  })

  it('saves the near-black Black color mode', () => {
    putSettingsSection(database, 'appearance', { identity: 'knight', colorMode: 'black', terminalFontSize: 14 }, now)
    expect(getSettings(database).appearance).toEqual({ identity: 'knight', colorMode: 'black', terminalFontSize: 14 })
  })

  it('validates settings and keeps the stored value on invalid input', () => {
    expect(getSettings(database)).toEqual(DEFAULT_APP_SETTINGS)
    putSettingsSection(database, 'appearance', { identity: 'cross', colorMode: 'dark', terminalFontSize: 16 }, now)
    expect(getSettings(database).appearance).toEqual({ identity: 'cross', colorMode: 'dark', terminalFontSize: 16 })
    putSettingsSection(database, 'appearance', { identity: 'boss', colorMode: 'dark', terminalFontSize: 16 }, now)
    expect(getSettings(database).appearance).toEqual({ identity: 'boss', colorMode: 'dark', terminalFontSize: 16 })
    expect(() => putSettingsSection(database, 'appearance', { identity: 'neon', colorMode: 'dark', terminalFontSize: 16 }, now)).toThrow(
      expect.objectContaining({ code: ERROR_CODES.invalidArgument })
    )
    expect(() => putSettingsSection(database, 'appearance', { identity: 'cross', colorMode: 'neon', terminalFontSize: 16 }, now))
      .toThrow(/Color mode/)
    expect(() => putSettingsSection(database, 'appearance', { identity: 'cross', colorMode: 'dark', terminalFontSize: 99 }, now)).toThrow()
    expect(() => putSettingsSection(database, 'telegram', { ...DEFAULT_APP_SETTINGS.telegram, enabled: true }, now))
      .toThrow(/allowed chat/)
    expect(getSettings(database).appearance).toEqual({ identity: 'boss', colorMode: 'dark', terminalFontSize: 16 })
  })

  it('splits a theme stored before identity and color mode were separate choices', () => {
    expect(getSettings(database).appearance).toEqual({ identity: 'knight', colorMode: 'black', terminalFontSize: 14 })
    const store = database.prepare("INSERT OR REPLACE INTO app_setting(key, value_json, updated_at) VALUES ('appearance', ?, ?)")
    for (const [theme, identity, colorMode] of [
      ['knight', 'knight', 'steel'],
      ['cross', 'cross', 'brown'],
      ['brown', 'cross', 'brown'],
      ['dark', 'cross', 'dark']
    ]) {
      store.run(JSON.stringify({ theme, terminalFontSize: 15 }), now)
      expect(getSettings(database).appearance).toEqual({ identity, colorMode, terminalFontSize: 15 })
    }
    store.run(JSON.stringify({ theme: 'constructor', terminalFontSize: 15 }), now)
    expect(getSettings(database).appearance).toEqual(DEFAULT_APP_SETTINGS.appearance)
    putSettingsSection(database, 'appearance', { identity: 'knight', colorMode: 'brown', terminalFontSize: 15 }, now)
    expect(getSettings(database).appearance).toEqual({ identity: 'knight', colorMode: 'brown', terminalFontSize: 15 })
  })

  it('validates voice settings', () => {
    expect(getSettings(database).voice).toEqual({ model: 'base', language: 'auto', modelFolder: null, holdSpaceToTalk: true, vocabulary: [] })
    putSettingsSection(database, 'voice', { model: 'small', language: 'uk' }, now)
    expect(getSettings(database).voice).toEqual({ model: 'small', language: 'uk', modelFolder: null, holdSpaceToTalk: true, vocabulary: [] })
    expect(() => putSettingsSection(database, 'voice', { model: 'large', language: 'uk' }, now)).toThrow(/Base or Small/)
    expect(() => putSettingsSection(database, 'voice', { model: 'base', language: 'klingon' }, now)).toThrow(/not supported/)
    expect(getSettings(database).voice).toEqual({ model: 'small', language: 'uk', modelFolder: null, holdSpaceToTalk: true, vocabulary: [] })
  })

  it('remembers hold Space to talk and keeps it on for sections saved before it existed', () => {
    putSettingsSection(database, 'voice', { model: 'small', language: 'uk', modelFolder: null, holdSpaceToTalk: false }, now)
    expect(getSettings(database).voice.holdSpaceToTalk).toBe(false)
    expect(() => putSettingsSection(database, 'voice', { model: 'small', language: 'uk', holdSpaceToTalk: 'no' }, now)).toThrow(/Hold Space to talk/)
    expect(getSettings(database).voice.holdSpaceToTalk).toBe(false)
    putSettingsSection(database, 'voice', { model: 'small', language: 'uk', modelFolder: null }, now)
    expect(getSettings(database).voice.holdSpaceToTalk).toBe(true)
  })

  it('stores the voice vocabulary under the shared rules and keeps legacy sections empty', () => {
    putSettingsSection(database, 'voice', { model: 'base', language: 'auto', modelFolder: null, holdSpaceToTalk: true }, now)
    expect(getSettings(database).voice.vocabulary).toEqual([])
    putSettingsSection(database, 'voice', {
      model: 'base', language: 'uk', modelFolder: null, holdSpaceToTalk: true, vocabulary: [' BMN ', 'dev-auto', 'Олександр']
    }, now)
    expect(getSettings(database).voice).toEqual({
      model: 'base', language: 'uk', modelFolder: null, holdSpaceToTalk: true, vocabulary: ['BMN', 'dev-auto', 'Олександр']
    })
    const saved = getSettings(database).voice
    for (const [vocabulary, reason] of [
      [['BMN', 'bmn'], /in the list twice/],
      [['a,b'], /commas/],
      [['x'.repeat(41)], /at most 40 characters/],
      [Array.from({ length: 31 }, (_, index) => `word${index}`), /at most 30 words/],
      [Array.from({ length: 12 }, (_, index) => `identifier-${index}-xxxxxx`), /223 bytes/],
      [['ok', 7], /list of words/],
      ['BMN', /list of words/]
    ] as Array<[unknown, RegExp]>) {
      expect(() => putSettingsSection(database, 'voice', { ...saved, vocabulary }, now)).toThrow(reason)
    }
    expect(getSettings(database).voice).toEqual(saved)
    // Saving another field keeps the vocabulary only when the whole section carries it.
    putSettingsSection(database, 'voice', { ...saved, language: 'en' }, now)
    expect(getSettings(database).voice.vocabulary).toEqual(['BMN', 'dev-auto', 'Олександр'])
  })

  it('refuses a vocabulary without quoting its words in the error', () => {
    let message = ''
    try {
      putSettingsSection(database, 'voice', { ...getSettings(database).voice, vocabulary: ['PrivateProject', 'privateproject'] }, now)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/in the list twice/)
    expect(message.toLowerCase()).not.toContain('privateproject')
  })

  it('loads a voice row stored before the vocabulary existed with an empty vocabulary and its other fields intact', () => {
    database.prepare(
      `INSERT INTO app_setting(key, value_json, updated_at) VALUES ('voice', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    ).run('{"model":"small","language":"uk","modelFolder":"/media/models","holdSpaceToTalk":false}', now)
    expect(getSettings(database).voice).toEqual({
      model: 'small', language: 'uk', modelFolder: '/media/models', holdSpaceToTalk: false, vocabulary: []
    })
  })

  it('carries the approved vocabulary through a backup copy of the database', () => {
    putSettingsSection(database, 'voice', {
      model: 'base', language: 'uk', modelFolder: null, holdSpaceToTalk: true, vocabulary: ['BMN', 'Олександр']
    }, now)
    const folder = mkdtempSync(join(tmpdir(), 'bmn-voice-backup-'))
    try {
      const path = join(folder, 'backup.sqlite')
      database.prepare('VACUUM INTO ?').run(path)
      const copy = new BetterSqlite3(path)
      try {
        expect(getSettings(copy).voice.vocabulary).toEqual(['BMN', 'Олександр'])
      } finally {
        copy.close()
      }
    } finally {
      rmSync(folder, { recursive: true, force: true })
    }
  })

  it('keeps the voice model folder only as a normalized absolute path', () => {
    putSettingsSection(database, 'voice', { model: 'base', language: 'en', modelFolder: '/media/disk/models//whisper/' }, now)
    expect(getSettings(database).voice).toEqual({ model: 'base', language: 'en', modelFolder: '/media/disk/models/whisper/', holdSpaceToTalk: true, vocabulary: [] })
    for (const modelFolder of ['models/whisper', '', 42, '/media/\0disk']) {
      expect(() => putSettingsSection(database, 'voice', { model: 'base', language: 'en', modelFolder }, now)).toThrow(/absolute path/)
    }
    putSettingsSection(database, 'voice', { model: 'base', language: 'en', modelFolder: null }, now)
    expect(getSettings(database).voice.modelFolder).toBeNull()
  })
})
