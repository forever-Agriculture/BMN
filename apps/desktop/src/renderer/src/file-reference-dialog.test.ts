// MODULE: file-reference-dialog.test.ts - Send to session as BMN's select (Story 80.4): every row sends to the session it names, and a busy dialog cannot open it
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SendTargetChooser, sendTargetOf, sendTargetOptions, type FileReferenceSendTarget } from './file-reference-dialog'

const TARGETS: FileReferenceSendTarget[] = [
  { sessionId: 'session-a', sessionName: 'bash', workspaceName: 'Personal', harness: 'Shell', path: '/tmp/work', incarnationId: 'run-1' },
  { sessionId: 'session-b', sessionName: 'Reviewer', workspaceName: 'Self-test archived workspace', harness: 'Codex', path: '/tmp/other/very/long/path', incarnationId: null }
]
const chooser = (value: string, busy: boolean): string => renderToStaticMarkup(createElement(SendTargetChooser, {
  targets: TARGETS, value, busy, onChoose: () => undefined
}))

describe('Send to session (Story 80.4)', () => {
  it('offers "Choose a session…" and then each session, with its harness and path on a second line', () => {
    expect(sendTargetOptions(TARGETS)).toEqual([
      { value: '', label: 'Choose a session…' },
      { value: 'session-a', label: 'Personal › bash', description: 'Shell · /tmp/work' },
      { value: 'session-b', label: 'Self-test archived workspace › Reviewer', description: 'Codex · /tmp/other/very/long/path' }
    ])
  })

  it('sets, for every row, the target the native select set before: the session it names, or none', () => {
    for (const option of sendTargetOptions(TARGETS)) {
      expect(sendTargetOf(TARGETS, option.value)).toBe(TARGETS.find((target) => target.sessionId === option.value) ?? null)
    }
    expect(sendTargetOf(TARGETS, '')).toBeNull()
  })

  it('shows the chosen session in the opener, and "Choose a session…" muted when none is chosen', () => {
    expect(chooser('session-b', false)).toContain('data-value="session-b"><span id=')
    expect(chooser('session-b', false)).toContain('class="select-value">Self-test archived workspace › Reviewer</span>')
    expect(chooser('', false)).toContain('data-value="" data-empty="true"')
    expect(chooser('', false)).toContain('class="select-value">Choose a session…</span>')
    expect(chooser('', false)).toMatch(/^<label>Send to session<button type="button" class="select-opener" aria-haspopup="menu"/)
    expect(chooser('', false)).not.toContain('<select')
  })

  it('cannot be opened while the dialog is busy (AC3)', () => {
    expect(chooser('session-a', true)).toMatch(/<button [^>]*aria-expanded="false"[^>]*disabled=""/)
    expect(chooser('session-a', false)).not.toContain('disabled')
  })
})
