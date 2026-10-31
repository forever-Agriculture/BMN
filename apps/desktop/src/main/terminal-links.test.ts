// MODULE: terminal-links.test.ts - a clicked terminal link opens once in the owner's browser; nothing else opens and no window does
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({}))
const { terminalLinkUrl } = await import('./companion-ipc')

describe('terminal links (owner, 2026-10-31: "Open in default browser")', () => {
  it('accepts only a whole http or https address', () => {
    expect(terminalLinkUrl('https://claude.ai/artifact/synthetic-id')).toBe('https://claude.ai/artifact/synthetic-id')
    expect(terminalLinkUrl('http://127.0.0.1:41901/cart?x=1')).toBe('http://127.0.0.1:41901/cart?x=1')
    for (const refused of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,hi', 'mailto:someone@example.com', 'ssh://host',
      'https://example.com/a b', 'https://example.com/\nx', '', 'not a url', 'https://' + 'a'.repeat(4100), 42, null]) {
      expect(() => terminalLinkUrl(refused), String(refused).slice(0, 40)).toThrow()
    }
  })

  it('the terminal hands clicked links to BMN, which opens them in the browser, and the window opens nothing itself', () => {
    const source = (path: string): string => readFileSync(join(__dirname, '..', path), 'utf8')
    // xterm's default asks "could potentially be dangerous" and opens a bare app window; BMN replaces it.
    expect(source('renderer/src/session-terminal.tsx')).toMatch(/linkHandler: \{[^}]*openTerminalLink\(/su)
    expect(source('preload/index.ts')).toMatch(/openTerminalLink\(address: string\)[\s\S]{0,120}'aiterm:link:open'/u)
    expect(source('main/companion-ipc.ts')).toMatch(/handle\('aiterm:link:open'[^}]*shell\.openExternal\(terminalLinkUrl\(/su)
    expect(source('main/index.ts')).toMatch(/setWindowOpenHandler\(\(\) => \(\{ action: 'deny' \}\)\)/u)
  })
})
