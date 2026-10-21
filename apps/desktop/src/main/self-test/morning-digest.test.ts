// MODULE: morning-digest.test.ts - passive digest fixtures never watch an earlier phase's requests
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_APP_SETTINGS, METHOD_REGISTRY, type AttentionRecord } from '@bmn/protocol'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SelfTestHost } from '../index'
import type { PtyHostClient } from '../pty-host-client'
import { createAppEventForwarder } from '../companion-ipc'
import { runMorningDigestSelfTest } from './morning-digest'
import type { SelfTestRecorder } from './taps'

vi.mock('electron', () => ({}))

afterEach(() => vi.unstubAllEnvs())

describe('morning digest fixture observation', () => {
  it.each([false, true])('preserves earlier requests and restores unwatched=%s after failed setup', async (priorUnwatched) => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-digest-observation-'))
    vi.stubEnv('BMN_STATE_HOME', root)
    const rows: AttentionRecord[] = ['question', 'permission'].map((kind, index) => ({
      requestId: `earlier-${index}`, sessionId: 'selected-quiet-session', incarnationId: null,
      requestKey: `quiet-${index}`, kind: kind as AttentionRecord['kind'], title: `Synthetic ${kind}`,
      body: null, state: 'open', resolution: null, openedAt: '2001-01-03T05:00:00.000Z',
      expiresAt: null, resolvedAt: null, seenAt: null, revision: 1,
      openedBy: null, resolvedBy: null, prompt: null
    }))
    const before = structuredClone(rows), seen: string[] = []
    const taps = { windowUnwatched: priorUnwatched, telegram: async () => ({ calls: [] }) } as unknown as SelfTestRecorder
    const forwarder = createAppEventForwarder({
      client: () => ({ request: async <Result,>(method: string, params: object) => {
        if (method === METHOD_REGISTRY.attentionSeen) {
          const id = (params as { requestId: string }).requestId
          const row = rows.find(row => row.requestId === id)!
          row.seenAt = '2001-01-04T06:00:00.000Z'; seen.push(id)
          return row as Result
        }
        return rows as Result
      } }),
      targets: () => [], watching: id => !taps.windowUnwatched && id === 'selected-quiet-session',
      notify: () => undefined, notificationsEnabled: () => false
    })
    const client = { request: async (method: string, params: object) => {
      if (method === METHOD_REGISTRY.settingsGet) return structuredClone(DEFAULT_APP_SETTINGS)
      if (method === METHOD_REGISTRY.healthGet) {
        if ('selfTestQuietClock' in params) {
          forwarder.watchChanged()
          await new Promise(resolve => setTimeout(resolve, 0))
        }
        return { away: false }
      }
      return undefined
    } } as unknown as PtyHostClient
    const failure = new Error('synthetic renderer setup failure')
    const host = { applicationWindow: { webContents: { executeJavaScript: async () => { throw failure } } } } as unknown as SelfTestHost
    try {
      await expect(runMorningDigestSelfTest(host, client, taps)).rejects.toBe(failure)
      expect(seen).toEqual([])
      expect(rows).toEqual(before)
      expect(taps.windowUnwatched).toBe(priorUnwatched)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
