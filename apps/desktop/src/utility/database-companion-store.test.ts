import { mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_APP_SETTINGS,
  isTelegramQuietHours,
  ERROR_CODES,
  type ArtifactRecord,
  type AttentionPrompt,
  type AttentionQuestionsPrompt,
  type ProgressRecord,
  type ProgressState
} from '@bmn/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  artifactBytesUsed,
  claimInputDraft,
  closeAttention,
  commitQuietDelivery,
  createDraft,
  discardDraft,
  expireAttention,
  getAttention,
  getDraft,
  getReceipt,
  getRawSetting,
  getSettings,
  getTelegramMessage,
  insertArtifact,
  listAgentHandoffs,
  listArtifacts,
  listAttention,
  listQuietAttention,
  listDrafts,
  listProgress,
  markAttentionSeen,
  markStaleAgentHandoffs,
  appendAttentionBody,
  openAttention,
  putReceipt,
  putSettingsSection,
  putRawSetting,
  switchHealthAlertsOff,
  putTelegramMessage,
  queueAgentHandoff,
  quietDelivered,
  setArtifactState,
  updateDraft,
  upsertProgress,
  usageNoticeExists,
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

/** A handoff an agent prepared for the owner to paste, as stored before Story 75.5: a draft and its open request. */
function legacyHandoff(draftId: string, requestId: string, createdAt: string = now): void {
  database.prepare(
    `INSERT INTO input_draft(draft_id, session_id, origin, origin_key, source_session_id, request_id, text, artifact_id,
       artifact_ids_json, attempted_incarnation_id, state, detail, created_at, updated_at, prepared_by)
     VALUES (?, 's2', 'handoff', NULL, 's1', ?, 'A result for the other session', NULL, '[]', NULL, 'draft', NULL, ?, ?, 'agent')`
  ).run(draftId, requestId, createdAt, createdAt)
  openAttention(database, {
    sessionId: 's1', incarnationId: 'incarnation-1', requestKey: `handoff:${draftId}`, kind: 'handoff',
    title: 'Asks to hand off to "Two"', body: 'A result for the other session',
    expiresAt: new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString()
  }, requestId, createdAt)
}

/** A handoff queued since Story 75.5: its delivery record, stored file and waiting message, stored whole. */
function queuedHandoff(handoffId: string, attachmentIds: string[] = [], at: string = now) {
  return queueAgentHandoff(database, {
    handoffId, messageId: `message-${handoffId}`, senderSessionId: 's1', receiverSessionId: 's2', senderRoot: '/work',
    stamp: '[BMN handoff from session "One" (s1) in /work]', pointer: `Handoff ${handoffId}: read all of it`,
    text: 'A result for the other session', file: { ...published(`stored-${handoffId}`), originalName: `handoff-${handoffId}.md` },
    attachmentIds, receiverRefusal: null
  }, at)
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

  describe('structured prompts (Epic 30)', () => {
    const question: AttentionQuestionsPrompt = {
      type: 'questions', harness: 'claude', shape: 'choice', requestRef: null, toolUseId: 'toolu_1',
      questions: [{ id: null, header: 'Auth method', text: 'Which auth?', multiSelect: false,
        options: [{ label: 'JWT', description: 'Stateless' }, { label: 'Cookies', description: null }] }]
    }
    const asked = {
      sessionId: 's1', incarnationId: 'i1', requestKey: 'claude:question', kind: 'question' as const,
      title: 'Claude asks: Which auth?', origin: 'hook:claude:PreToolUse', prompt: question
    }
    const bash: AttentionPrompt = {
      type: 'permission', harness: 'claude', shape: 'permission', requestRef: null, toolUseId: null,
      tool: 'Bash', command: 'touch a.txt', cwd: '/work/one'
    }
    const permission = {
      sessionId: 's1', incarnationId: 'i1', requestKey: 'claude:permission', kind: 'permission' as const,
      title: 'Claude wants to use Bash', body: 'touch a.txt', origin: 'hook:claude:PermissionRequest', prompt: bash
    }
    const notice = {
      sessionId: 's1', incarnationId: 'i1', requestKey: 'claude:permission', kind: 'permission' as const,
      title: 'Claude needs your permission', origin: 'hook:claude:Notification'
    }

    it('stores the prompt and reads it back on the record', () => {
      expect(openAttention(database, asked, 'r1', now).prompt).toEqual(question)
      expect(getAttention(database, 'r1').prompt).toEqual(question)
    })

    it('keeps revision and unread state when Claude repeats the same permission without a prompt', () => {
      const opened = openAttention(database, permission, 'r1', now)
      markAttentionSeen(database, 'r1', now)
      // Claude's delayed notice names no tool; it is the same prompt, not a changed one to page again.
      const repeated = openAttention(database, { ...notice, origin: 'cli' }, 'r2', now)
      expect(repeated).toMatchObject({ requestId: 'r1', revision: opened.revision, changed: false, title: permission.title })
      expect(getAttention(database, 'r1')).toMatchObject({ seenAt: now, prompt: bash })
    })

    it('files the notice under an open question instead of opening a tool-less permission', () => {
      openAttention(database, asked, 'r1', now)
      const covered = openAttention(database, notice, 'r2', now)
      expect(covered).toMatchObject({ requestId: 'r1', changed: false })
      expect(listAttention(database).map((row) => row.requestId)).toEqual(['r1'])
    })

    it('still opens the notice when no structured prompt is open, or another run holds one', () => {
      openAttention(database, { ...asked, incarnationId: 'old' }, 'r1', now)
      expect(openAttention(database, notice, 'r2', now)).toMatchObject({ requestId: 'r2', changed: true, prompt: null })
    })

    it('merges the question PreToolUse and PermissionRequest report in either order without a new revision', () => {
      const withoutId = { ...asked, origin: 'hook:claude:PermissionRequest', prompt: { ...question, toolUseId: null } }
      openAttention(database, asked, 'r1', now)
      expect(openAttention(database, withoutId, 'r2', now)).toMatchObject({ revision: 1, changed: false, prompt: question })
      closeAttention(database, { requestId: 'r1' }, 'answered', 'x', now)

      openAttention(database, withoutId, 'r3', now)
      expect(openAttention(database, asked, 'r4', now)).toMatchObject({ requestId: 'r3', revision: 1, changed: false, prompt: question })
    })

    it('bumps the revision for a different dialog in the same slot', () => {
      openAttention(database, asked, 'r1', now)
      const next = { ...question, toolUseId: 'toolu_2', questions: [{ ...question.questions[0]!, text: 'Which database?' }] }
      expect(openAttention(database, { ...asked, title: 'Claude asks: Which database?', prompt: next }, 'r2', now))
        .toMatchObject({ requestId: 'r1', revision: 2, changed: true, prompt: next })
    })
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

  it('finds a plan-use period by its stored reset, in any state, for the watch\'s own notices only', () => {
    const notice = (requestId: string, requestKey: string, expiresAt: string, origin = 'watch:usage') =>
      openAttention(database, { sessionId: 's1', incarnationId: null, requestKey, kind: 'notice', title: 'Limit', expiresAt, origin }, requestId, now)
    notice('r1', 'usage:codex:300:29823300', '2026-09-14T16:10:00.000Z')
    closeAttention(database, { requestId: 'r1' }, 'answered', null, now)
    notice('r2', 'usage:codex:3000:29823300', '2026-09-20T09:00:00.000Z')
    notice('r3', 'usage:claude:300:29823300', '2026-09-22T09:00:00.000Z', 'cli')
    const exists = (prefix: string, from: string, to: string) => usageNoticeExists(database, prefix, from, to)

    // Closed by the owner, the period still counts; its ends are inclusive.
    expect(exists('usage:codex:300:', '2026-09-14T16:00:00.000Z', '2026-09-14T16:10:00.000Z')).toBe(true)
    expect(exists('usage:codex:300:', '2026-09-14T16:10:00.001Z', '2026-09-14T16:20:00.000Z')).toBe(false)
    // A longer window whose minutes start with the same digits is another window.
    expect(exists('usage:codex:300:', '2026-09-20T08:50:00.000Z', '2026-09-20T09:10:00.000Z')).toBe(false)
    expect(exists('usage:codex:3000:', '2026-09-20T08:50:00.000Z', '2026-09-20T09:10:00.000Z')).toBe(true)
    // A `usage:` request anything else opened says nothing about the period.
    expect(exists('usage:claude:300:', '2026-09-22T08:50:00.000Z', '2026-09-22T09:10:00.000Z')).toBe(false)
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

  it('keeps a handoff from before Story 75.5 stored and readable, out of the owner\'s drafts and never sent', () => {
    legacyHandoff('legacy', 'legacy-request')
    expect(getDraft(database, 'legacy')).toMatchObject({ origin: 'handoff', state: 'draft', text: 'A result for the other session' })
    expect(listDrafts(database)).toEqual([])
    expect(listAgentHandoffs(database, 's1', now)).toEqual([{ draftId: 'legacy', destinationSessionId: 's2', state: 'draft', updatedAt: now }])
    expect(listAgentHandoffs(database, 's2', now)).toEqual([])
    expect(() => claimInputDraft(database, 'legacy', now, 'incarnation-2', now)).toThrow('A handoff is never typed into a terminal')
    expect(() => discardDraft(database, 'legacy', now)).toThrow('A handoff is kept as it is; it cannot be discarded here')
  })

  it('lets the agent withdraw its old open petition, and expiry discards an old pending draft', () => {
    legacyHandoff('withdrawn', 'withdrawn-request')
    expect(withdrawAgentHandoff(database, 's1', 'withdrawn', '2026-09-14T12:00:01.000Z'))
      .toMatchObject({ state: 'withdrawn', resolution: 'withdrawn by agent', resolvedBy: 'cli' })
    expect(getDraft(database, 'withdrawn')).toMatchObject({ state: 'discarded', detail: 'Withdrawn by the agent' })

    legacyHandoff('expired', 'expired-request')
    expect(expireAttention(database, '2026-09-15T12:00:00.000Z')).toBe(1)
    expect(getDraft(database, 'expired')).toMatchObject({ state: 'discarded', detail: 'The handoff request expired' })
  })

  it('marks an old pending petition stale once its source runs another process', () => {
    legacyHandoff('stale', 'stale-request')
    expect(markStaleAgentHandoffs(database, { s1: 'incarnation-new' })).toBe(1)
    expect(getAttention(database, 'stale-request').body).toContain('prepared by an earlier process of this session')
    expect(markStaleAgentHandoffs(database, { s1: 'incarnation-new' })).toBe(0)
  })

  it('stores a queued handoff whole: one delivery record holding its stored file and attachments, and one message (Story 75.5)', () => {
    insertArtifact(database, published('attached'))
    expect(database.transaction(() => queuedHandoff('h1', ['attached']))()).toEqual({ accepted: true, messageId: 'message-h1', state: 'waiting' })
    expect(getDraft(database, 'h1')).toMatchObject({
      origin: 'handoff', sessionId: 's2', sourceSessionId: 's1', preparedBy: 'agent', requestId: 'message-h1',
      artifactId: 'stored-h1', artifactIds: ['attached'], state: 'submitted', text: 'A result for the other session'
    })
    expect(listAgentHandoffs(database, 's1', now)).toEqual([{ draftId: 'h1', destinationSessionId: 's2', state: 'queued', updatedAt: now }])
    expect(listDrafts(database)).toEqual([])
    expect(listAttention(database)).toEqual([])
    expect(() => withdrawAgentHandoff(database, 's1', 'h1', now)).toThrow(/delivers itself and cannot be withdrawn/)
    expect(() => discardDraft(database, 'h1', now)).toThrow(/kept as it is/)
    expect(() => claimInputDraft(database, 'h1', now, 'incarnation-2', now)).toThrow('A handoff is never typed into a terminal')
  })

  it('leaves no record, stored file or message when an attached file is not this session\'s ready output', () => {
    insertArtifact(database, { ...published('other'), sessionId: 's2' })
    expect(() => database.transaction(() => queuedHandoff('h2', ['other']))()).toThrow('Every handoff file must be a ready file this session published')
    expect(() => getDraft(database, 'h2')).toThrow(expect.objectContaining({ code: ERROR_CODES.notFound }))
    expect(listArtifacts(database, 's1').map((row) => row.artifactId)).toEqual([])
    expect((database.prepare('SELECT COUNT(*) AS count FROM session_message').get() as { count: number }).count).toBe(0)
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

  it('lets programs copy to the clipboard by default, and keeps the owner\'s choice (Story 42.1)', () => {
    expect(getSettings(database).terminal).toEqual({ programClipboard: true })
    putSettingsSection(database, 'terminal', { programClipboard: false }, now)
    expect(getSettings(database).terminal).toEqual({ programClipboard: false })
    expect(() => putSettingsSection(database, 'terminal', { programClipboard: 'no' }, now)).toThrow(/copy to the clipboard/)
    expect(() => putSettingsSection(database, 'terminal', {}, now)).toThrow(/copy to the clipboard/)
    expect(getSettings(database).terminal).toEqual({ programClipboard: false })
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

  it('reads a Telegram section saved before Epic 30 with permission answers off, and stores the choice', () => {
    const legacy = { enabled: false, allowedChatId: 7, allowedUserId: null, notifyOn: 'attention', autoSubmitReplies: true }
    database.prepare("INSERT OR REPLACE INTO app_setting(key, value_json, updated_at) VALUES ('telegram', ?, ?)")
      .run(JSON.stringify(legacy), now)
    expect(getSettings(database).telegram).toEqual({ ...legacy, answerPermissions: false, quietHours: DEFAULT_APP_SETTINGS.telegram.quietHours, morningDigest: DEFAULT_APP_SETTINGS.telegram.morningDigest, healthAlerts: { enabled: false, offAt: null } })
    expect(putSettingsSection(database, 'telegram', { ...legacy, answerPermissions: true }, now).telegram.answerPermissions).toBe(true)
    expect(() => putSettingsSection(database, 'telegram', { ...legacy, answerPermissions: 'yes' }, now)).toThrow(/permission prompts/)
  })

  it('shares quiet-hours validation with the form and prunes unavailable session exceptions on load', () => {
    const quiet = { enabled: true, start: '22:00', end: '07:00', allowKinds: ['question' as const], allowSessions: ['s1', 's2', 'deleted'] }
    expect(isTelegramQuietHours(quiet)).toBe(true)
    const value = { ...DEFAULT_APP_SETTINGS.telegram, quietHours: quiet }
    expect(putSettingsSection(database, 'telegram', value, now).telegram.quietHours?.allowSessions).toEqual(['s1', 's2'])
    database.prepare('UPDATE session SET archived_at = ? WHERE session_id = ?').run(now, 's2')
    expect(getSettings(database).telegram.quietHours?.allowSessions).toEqual(['s1'])
    for (const bad of [{ ...quiet, start: '7:00' }, { ...quiet, end: '22:00' },
      { ...quiet, allowSessions: Array.from({ length: 21 }, (_, i) => String(i)) }]) {
      expect(isTelegramQuietHours(bad)).toBe(false)
      expect(() => putSettingsSection(database, 'telegram', { ...value, quietHours: bad }, now)).toThrow(/Quiet hours/)
    }
    expect(getSettings(database).telegram.quietHours?.start).toBe('22:00')
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

describe('private quiet delivery markers', () => {
  const params = { sessionId: 's1', incarnationId: null, requestKey: 'quiet', kind: 'question' as const, title: 'Synthetic question' }
  const ledger = { version: 1, entries: [], window: null, summaryHighWater: 0 }

  it('spends membership with the exact attempt, preserves suppression on clear, and resets only a new hold', () => {
    const row = openAttention(database, params, 'held', now)
    const hold = { requestId: row.requestId, revision: row.revision, heldAt: 1 }
    commitQuietDelivery(database, ledger, { hold, release: true }, now)
    expect(commitQuietDelivery(database, ledger, { claim: row }, now)).toBe(true)
    expect(listQuietAttention(database)).toEqual([])
    expect(quietDelivered(database, row.requestId, row.revision)).toBe(true)
    expect(commitQuietDelivery(database, ledger, { hold }, now)).toBe(false)
    expect(commitQuietDelivery(database, ledger, { claim: row }, now)).toBe(false)
    commitQuietDelivery(database, ledger, { release: true, clear: [row] }, now)
    expect(quietDelivered(database, row.requestId, row.revision)).toBe(true)
    const revised = openAttention(database, { ...params, title: 'Next revision' }, 'unused', now)
    expect(quietDelivered(database, revised.requestId, revised.revision)).toBe(false)
    commitQuietDelivery(database, ledger, { hold: { requestId: revised.requestId, revision: revised.revision, heldAt: 2 } }, now)
    expect(listQuietAttention(database)).toMatchObject([{ heldAt: 2, eligible: false, record: { revision: revised.revision } }])
    expect(commitQuietDelivery(database, ledger, { claim: row }, now)).toBe(false)
    expect(commitQuietDelivery(database, ledger, { claim: revised }, now)).toBe(true)
    commitQuietDelivery(database, ledger, { unclaim: row }, now)
    expect(quietDelivered(database, revised.requestId, revised.revision)).toBe(true)
    commitQuietDelivery(database, ledger, { unclaim: revised }, now)
    expect(listQuietAttention(database)).toHaveLength(1)
  })

  it('keeps an unattempted eligible member across revisions and rolls back a failed claim ledger write', () => {
    const row = openAttention(database, params, 'held', now)
    commitQuietDelivery(database, ledger, { hold: { requestId: row.requestId, revision: row.revision, heldAt: 1 }, release: true }, now)
    const revised = openAttention(database, { ...params, title: 'New current revision' }, 'unused', now)
    commitQuietDelivery(database, ledger, { hold: { requestId: revised.requestId, revision: revised.revision, heldAt: 2 } }, now)
    expect(listQuietAttention(database)).toMatchObject([{ eligible: true, heldAt: 1 }])
    expect(() => commitQuietDelivery(database, { bad: BigInt(1) }, { claim: revised }, now)).toThrow()
    expect(quietDelivered(database, revised.requestId, revised.revision)).toBe(false)
    expect(listQuietAttention(database)).toHaveLength(1)
    expect(JSON.stringify(getAttention(database, row.requestId))).not.toContain('telegram_quiet')
    expect(JSON.stringify(listAttention(database))).not.toContain('telegram_quiet')
    putReceipt(database, { key: 'quiet-private-proof', paramsHash: 'synthetic', state: 'done', result: getAttention(database, row.requestId) }, now)
    expect(JSON.stringify(getReceipt(database, 'quiet-private-proof'))).not.toContain('telegram_quiet')
  })

  it('atomically records a hold without changing the public request, rejecting stale admissions', () => {
    const row = openAttention(database, params, 'held', now)
    const before = getAttention(database, row.requestId)
    expect(commitQuietDelivery(database, ledger, { hold: { requestId: row.requestId, revision: row.revision, heldAt: 1 } }, now)).toBe(true)
    expect(getAttention(database, row.requestId)).toEqual(before)
    expect(listQuietAttention(database)).toEqual([{ record: before, heldAt: 1, eligible: false }])
    expect(commitQuietDelivery(database, { invalid: true }, { hold: { requestId: row.requestId, revision: 999, heldAt: 2 } }, now)).toBe(false)
    expect(getRawSetting(database, 'telegram-quiet-delivery-v1')).toEqual(ledger)
    expect(() => commitQuietDelivery(database, { invalid: BigInt(1) }, { release: true }, now)).toThrow()
    expect(listQuietAttention(database)[0]!.eligible).toBe(false)
    expect(getRawSetting(database, 'telegram-quiet-delivery-v1')).toEqual(ledger)
  })

  it('does not clear a revised marker when an older revision finishes mapping', () => {
    const row = openAttention(database, params, 'held', now)
    commitQuietDelivery(database, ledger, { hold: { requestId: row.requestId, revision: row.revision, heldAt: 1 }, release: true }, now)
    const revised = openAttention(database, { ...params, title: 'Changed question' }, 'unused', now)
    expect(revised.revision).toBe(row.revision + 1)
    commitQuietDelivery(database, ledger, { clear: [row] }, now)
    expect(listQuietAttention(database)).toMatchObject([{ record: { revision: revised.revision }, eligible: true }])
    commitQuietDelivery(database, ledger, { clear: [revised] }, now)
    expect(listQuietAttention(database)).toEqual([])
    expect(getAttention(database, row.requestId).state).toBe('open')
  })

  it('recovers 201 exact marked requests after closing and reopening SQLite, excluding unrelated rows', () => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-quiet-store-'))
    const path = join(root, 'store.sqlite')
    let disk = new BetterSqlite3(path)
    try {
      initializeDatabase(disk, now)
      disk.prepare(`INSERT INTO session(session_id, workspace_id, name, cwd, executable, argv_json, revision, created_at, position)
        VALUES ('s1', ?, 'Synthetic', '/work', '/bin/bash', '[]', 1, ?, 0)`).run(DEFAULT_WORKSPACE_ID, now)
      for (let n = 0; n < 202; n += 1) {
        const row = openAttention(disk, { ...params, requestKey: `q${n}` }, `r${n}`, now)
        if (n < 201) commitQuietDelivery(disk, ledger, { hold: { requestId: row.requestId, revision: row.revision, heldAt: n } }, now)
      }
      disk.close(); disk = new BetterSqlite3(path); initializeDatabase(disk, now)
      const held = listQuietAttention(disk)
      expect(held).toHaveLength(201)
      expect(held.some(item => item.record.requestId === 'r201')).toBe(false)
      expect(held.every(item => !item.eligible)).toBe(true)
      commitQuietDelivery(disk, ledger, { release: true }, now)
      disk.close(); disk = new BetterSqlite3(path); initializeDatabase(disk, now)
      expect(listQuietAttention(disk).every(item => item.eligible)).toBe(true)
      expect(listAttention(disk)).toHaveLength(202)
    } finally { disk.close(); rmSync(root, { recursive: true, force: true }) }
  })
})


describe('health alerts stored settings (Story 62.2)', () => {
  it('loads a section saved before the watch existed with it off, stores a choice and refuses a bad one', () => {
    const before = { ...DEFAULT_APP_SETTINGS.telegram } as Record<string, unknown>
    delete before.healthAlerts
    database.prepare("INSERT OR REPLACE INTO app_setting(key, value_json, updated_at) VALUES ('telegram', ?, ?)").run(JSON.stringify(before), now)
    expect(getSettings(database).telegram.healthAlerts).toEqual({ enabled: false, offAt: null })
    const value = { ...DEFAULT_APP_SETTINGS.telegram, healthAlerts: { enabled: true, offAt: '20:00' } }
    expect(putSettingsSection(database, 'telegram', value, now).telegram.healthAlerts).toEqual(value.healthAlerts)
    expect(putSettingsSection(database, 'telegram', { ...value, healthAlerts: { enabled: true, offAt: null } }, now).telegram.healthAlerts)
      .toEqual({ enabled: true, offAt: null })
    for (const offAt of ['8:00', '24:00', '', 2000]) {
      expect(() => putSettingsSection(database, 'telegram', { ...value, healthAlerts: { enabled: true, offAt } }, now)).toThrow(/Health alerts/)
    }
    expect(() => putSettingsSection(database, 'telegram', { ...value, healthAlerts: { enabled: 'yes', offAt: null } }, now)).toThrow(/Health alerts/)
    expect(getSettings(database).telegram.healthAlerts).toEqual({ enabled: true, offAt: null })
    // A save that leaves the watch out (an older window) keeps the section valid and reads it as off.
    expect(putSettingsSection(database, 'telegram', before, now).telegram.healthAlerts).toEqual({ enabled: false, offAt: null })
  })

  it('switches the watch off in one step: every other stored field stays, and the watch\'s state is written with it', () => {
    // What the owner saved a moment ago is what is stored: the step works on that, never on a copy read earlier.
    const saved = { ...DEFAULT_APP_SETTINGS.telegram, allowedUserId: 4242, morningDigest: { enabled: true, time: '09:15' }, healthAlerts: { enabled: true, offAt: '20:00' } }
    putSettingsSection(database, 'telegram', saved, now)
    const stored = () => JSON.parse((database.prepare("SELECT value_json FROM app_setting WHERE key = 'telegram'").get() as { value_json: string }).value_json) as Record<string, unknown>
    const before = stored()
    const owed = { version: 1, sent: [], sentAt: null, cpuHotStreak: 0, batteryAtStart: null, offAt: null, offDeadline: null, offNoticeOwed: true }
    const settings = switchHealthAlertsOff(database, 'health-alerts-v1', owed, now)
    expect(settings.telegram.healthAlerts).toEqual({ enabled: false, offAt: null })
    expect(stored()).toEqual({ ...before, healthAlerts: { enabled: false, offAt: null } })
    expect(getRawSetting(database, 'health-alerts-v1')).toEqual(owed)
  })

  const owedNotice = { version: 1, sent: [], sentAt: null, cpuHotStreak: 0, batteryAtStart: null, offAt: null, offDeadline: null, offNoticeOwed: true }
  const settingRow = (key: string) => database.prepare('SELECT value_json, updated_at FROM app_setting WHERE key = ?').get(key) as { value_json: string; updated_at: string } | undefined
  /** As the database worker runs every operation: inside one transaction. */
  const switchOff = (at: string) => database.transaction(() => switchHealthAlertsOff(database, 'health-alerts-v1', owedNotice, at))()

  it.each([
    ['the settings write', 'telegram'],
    ['the state write', 'health-alerts-v1']
  ])('changes neither the switch nor the state when the database refuses %s', (_label, failing) => {
    const saved = { ...DEFAULT_APP_SETTINGS.telegram, allowedUserId: 4242, healthAlerts: { enabled: true, offAt: '20:00' } }
    putSettingsSection(database, 'telegram', saved, now)
    putRawSetting(database, 'health-alerts-v1', { version: 1, sent: ['drive-hot'], sentAt: now, cpuHotStreak: 0, batteryAtStart: true, offAt: '20:00', offDeadline: now }, now)
    const before = { settings: settingRow('telegram'), state: settingRow('health-alerts-v1') }
    database.exec(`CREATE TEMP TRIGGER refuse_write BEFORE UPDATE ON app_setting WHEN NEW.key = '${failing}'
      BEGIN SELECT RAISE(ABORT, 'synthetic refusal'); END`)
    expect(() => switchOff('2026-09-14T20:00:00.000Z')).toThrow(/synthetic refusal/)
    // Both rows as they were, their times included: the watch is still on and still owes nothing.
    expect({ settings: settingRow('telegram'), state: settingRow('health-alerts-v1') }).toEqual(before)
    expect(getSettings(database).telegram.healthAlerts).toEqual({ enabled: true, offAt: '20:00' })
    database.exec('DROP TRIGGER refuse_write')
    expect(switchOff('2026-09-14T20:00:30.000Z').telegram.healthAlerts).toEqual({ enabled: false, offAt: null })
    expect(JSON.parse(settingRow('health-alerts-v1')!.value_json)).toEqual(owedNotice)
  })

  it('stores the owed notice and no settings when there is no stored section', () => {
    expect(settingRow('telegram')).toBeUndefined()
    expect(switchOff(now).telegram.healthAlerts).toEqual({ enabled: false, offAt: null })
    expect(settingRow('telegram')).toBeUndefined()
    expect(getRawSetting(database, 'health-alerts-v1')).toEqual(owedNotice)
  })

  it.each([
    ['text that is not JSON', '{broken'],
    ['JSON that is not an object', '[1,2]'],
    ['settings that do not pass', JSON.stringify({ ...DEFAULT_APP_SETTINGS.telegram, enabled: true, allowedChatId: null })],
    // Replacing the watch's part would make this section pass and bring its other fields to life.
    ['a watch setting that does not pass', JSON.stringify({ ...DEFAULT_APP_SETTINGS.telegram, enabled: true, allowedChatId: 77, autoSubmitReplies: true, healthAlerts: { enabled: 'yes', offAt: '25:00' } })]
  ])('leaves a stored section holding %s as it is, and still stores the owed notice', (_label, bytes) => {
    database.prepare("INSERT INTO app_setting(key, value_json, updated_at) VALUES ('telegram', ?, ?)").run(bytes, now)
    const before = settingRow('telegram')
    expect(getSettings(database).telegram).toEqual(DEFAULT_APP_SETTINGS.telegram)
    const settings = switchOff('2026-09-14T20:00:00.000Z')
    // It loaded as the defaults before, the watch off, and does so after: nothing was made valid.
    expect(settings.telegram).toEqual(DEFAULT_APP_SETTINGS.telegram)
    expect(settingRow('telegram')).toEqual(before)
    expect(getRawSetting(database, 'health-alerts-v1')).toEqual(owedNotice)
  })
})

describe('morning digest stored settings', () => {
  it('defaults old sections off and applies the same strict local-time validation as the form', () => {
    expect(getSettings(database).telegram.morningDigest).toEqual({ enabled: false, time: '08:00' })
    const value = { ...DEFAULT_APP_SETTINGS.telegram, morningDigest: { enabled: true, time: '09:15' } }
    expect(putSettingsSection(database, 'telegram', value, now).telegram.morningDigest).toEqual(value.morningDigest)
    for (const time of ['9:15', '24:00', '', '12:60']) {
      expect(() => putSettingsSection(database, 'telegram', { ...value, morningDigest: { enabled: true, time } }, now)).toThrow(/Morning digest/)
    }
    expect(getSettings(database).telegram.morningDigest).toEqual(value.morningDigest)
  })
})
