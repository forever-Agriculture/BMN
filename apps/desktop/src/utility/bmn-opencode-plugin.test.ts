// MODULE: bmn-opencode-plugin.test.ts - Story 96.3: the fixed list of BMN's earlier OpenCode plugin texts is what main shipped, and the October 14 text reports the owner's stop as a finished turn while the current one marks it
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { EARLIER_OPENCODE_PLUGINS, OPENCODE_PLUGIN } from '../../bin/bmn-opencode-plugin.mjs'
import { replayTerminalPlugin, shippedPluginText } from './test-fixtures/earlier-opencode-plugins'

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')
/** The text OpenCode still loaded on the owner's computer on 2026-10-26 (evidence 96.3: its installed bmn/tui.ts hashed to it). */
const OCTOBER_14 = '4cebff68da6edb803b706447ca3ce2de3f5976f6c0db466d1b6cee8db0d99fde'
/** The owner's stop of a root run, then a run of it that finished by itself, as OpenCode 2.0.29 sends them (Story 93.1). */
const STOP_THEN_FINISH = [
  { type: 'session.execution.interrupted', data: { sessionID: 'ses_synthetic', reason: 'user' } },
  { type: 'session.execution.succeeded', data: { sessionID: 'ses_synthetic' } }
]

describe('BMN\'s earlier OpenCode plugin texts (Story 96.3)', () => {
  it.each(Object.entries(EARLIER_OPENCODE_PLUGINS))('%s is the text its commit shipped', (hash, { kind, commit, file }) => {
    const text = shippedPluginText(commit, file)
    expect(sha256(text)).toBe(hash)
    expect(text).toContain('// Shipped by BMN')
    expect(kind).toBe(text.includes('import type { Plugin } from "@opencode-ai/plugin"') ? 'server' : 'terminal')
  })

  it('holds the text this one replaced and the October 14 one, never the current one', () => {
    expect(EARLIER_OPENCODE_PLUGINS[sha256(OPENCODE_PLUGIN)]).toBeUndefined()
    expect(EARLIER_OPENCODE_PLUGINS[sha256(shippedPluginText('84111c456a', 'apps/desktop/bin/bmn-opencode-plugin.mjs'))]).toMatchObject({ kind: 'terminal' })
    expect(EARLIER_OPENCODE_PLUGINS[OCTOBER_14]).toMatchObject({ kind: 'terminal', commit: '033eb7d88f' })
  })

  it('replays the October 14 text: the owner\'s stop reaches BMN as a finished turn, unmarked, and quitting says nothing', async () => {
    const { told, written } = await replayTerminalPlugin(shippedPluginText('033eb7d88f', 'apps/desktop/bin/bmn'), STOP_THEN_FINISH)
    const turns = told.filter((body) => body.hook_event_name === 'session.idle')
    // The stop and the finish are the same event: nothing tells them apart.
    expect(turns).toEqual([{ hook_event_name: 'session.idle', sessionID: 'ses_synthetic' }, { hook_event_name: 'session.idle', sessionID: 'ses_synthetic' }])
    expect(told.some((body) => 'bmn_plugin' in body)).toBe(false)
    expect(told.some((body) => body.hook_event_name === 'tui.exit')).toBe(false)
    expect(written).toEqual([])
  })

  it('replays the current text: the stop is marked the owner\'s, every event carries the plugin\'s promise, and quitting is told', async () => {
    const { told, written } = await replayTerminalPlugin(OPENCODE_PLUGIN, STOP_THEN_FINISH)
    expect(told.filter((body) => body.hook_event_name === 'session.idle')).toEqual([
      { hook_event_name: 'session.idle', sessionID: 'ses_synthetic', source: 'interrupted', bmn_plugin: 1 },
      { hook_event_name: 'session.idle', sessionID: 'ses_synthetic', bmn_plugin: 1 }
    ])
    expect(told.every((body) => body.bmn_plugin === 1)).toBe(true)
    expect(told.at(-1)).toMatchObject({ hook_event_name: 'tui.exit', bmn_plugin: 1 })
    expect(written).toEqual(['\x1b]7501;state=starting:app=opencode\x07'])
  })
})
