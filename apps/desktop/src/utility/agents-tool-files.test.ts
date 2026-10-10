// MODULE: agents-tool-files.test.ts - Story 60.12: one MCP entry read from and changed in an app's settings text, every other byte kept; synthetic texts only
import { describe, expect, it } from 'vitest'
import { ToolFileError, editJsonEntry, editTomlEntry, readJsonEntries, readTomlEntries, renderTomlEntry } from '../../bin/agents-tool-files.mjs'

/** A settings file as an app keeps it: much besides the tools, comments, a trailing comma, its own indent. */
const JSON_FILE = `{
    // SYNTHETIC-UNRELATED-TOP
    "numStartups": 18446744073709551615,
    "projects": { "/synthetic/work": { "mcpServers": { "inner": { "command": "never-read" } } } },
    "mcpServers": {
        "alpha": {
            "type": "stdio",
            "command": "alpha-tool",
            "args": ["--flag", "a }\\" tricky"],  /* SYNTHETIC-COMMENT-IN-ENTRY */
            "env": { "ALPHA_KEY": "\${ALPHA_KEY}" }
        },
        "beta": { "type": "http", "url": "https://beta.example.test/mcp" },
    },
    "tipsHistory": { "x": 1 }
}
`

const without = (text: string, part: string): string => {
  const at = text.indexOf(part)
  if (at === -1 || text.indexOf(part, at + 1) !== -1) throw new Error(`expected exactly one "${part.slice(0, 30)}"`)
  return `${text.slice(0, at)}${text.slice(at + part.length)}`
}

describe('a JSON settings file (Claude Code, Cursor, OpenCode)', () => {
  it('reads each entry with its value and its exact text, through comments and trailing commas, and only under the given key', () => {
    const entries = readJsonEntries(JSON_FILE, ['mcpServers'])
    expect([...entries.keys()]).toEqual(['alpha', 'beta'])
    expect(entries.get('alpha')!.value).toEqual({ type: 'stdio', command: 'alpha-tool', args: ['--flag', 'a }" tricky'], env: { ALPHA_KEY: '${ALPHA_KEY}' } })
    expect(entries.get('alpha')!.raw.startsWith('{')).toBe(true)
    expect(entries.get('alpha')!.raw).toContain('SYNTHETIC-COMMENT-IN-ENTRY')
    expect(entries.get('beta')!.raw).toBe('{ "type": "http", "url": "https://beta.example.test/mcp" }')
    expect(readJsonEntries(JSON_FILE, ['mcp']).size).toBe(0)
    expect(readJsonEntries('', ['mcpServers']).size).toBe(0)
    expect(readJsonEntries('  \n', ['mcpServers']).size).toBe(0)
    expect(readJsonEntries('{}', ['mcpServers']).size).toBe(0)
  })

  it('replaces one entry and leaves every other byte as it was', () => {
    const next = editJsonEntry(JSON_FILE, ['mcpServers'], 'beta', { type: 'http', url: 'https://beta.example.test/v2' })
    const before = JSON_FILE.indexOf('"beta"')
    const tail = JSON_FILE.indexOf(',\n    },\n    "tipsHistory"')
    expect(next.slice(0, before)).toBe(JSON_FILE.slice(0, before))
    expect(next.endsWith(JSON_FILE.slice(tail))).toBe(true)
    expect(readJsonEntries(next, ['mcpServers']).get('beta')!.value).toEqual({ type: 'http', url: 'https://beta.example.test/v2' })
    // The number the app wrote is still the digits it wrote, and the comment is still there.
    expect(next).toContain('18446744073709551615')
    expect(next).toContain('SYNTHETIC-UNRELATED-TOP')
    expect(readJsonEntries(next, ['mcpServers']).get('alpha')!.raw).toBe(readJsonEntries(JSON_FILE, ['mcpServers']).get('alpha')!.raw)
  })

  it('adds an entry in the file\'s own indent, and taking it out again gives the bytes back', () => {
    const plain = JSON_FILE.replace('"beta": { "type": "http", "url": "https://beta.example.test/mcp" },', '"beta": { "type": "http", "url": "https://beta.example.test/mcp" }')
    const added = editJsonEntry(plain, ['mcpServers'], 'gamma', { command: 'gamma-tool', args: [] })
    expect(added).toContain('\n        "gamma": {\n            "command": "gamma-tool",\n            "args": []\n        }\n    },')
    expect([...readJsonEntries(added, ['mcpServers']).keys()]).toEqual(['alpha', 'beta', 'gamma'])
    expect(editJsonEntry(added, ['mcpServers'], 'gamma', undefined)).toBe(plain)
  })

  it('removes the first, a middle and the only entry without touching the others', () => {
    const noAlpha = editJsonEntry(JSON_FILE, ['mcpServers'], 'alpha', undefined)
    expect([...readJsonEntries(noAlpha, ['mcpServers']).keys()]).toEqual(['beta'])
    expect(noAlpha).toContain('"tipsHistory": { "x": 1 }')
    expect(noAlpha).toContain('"inner": { "command": "never-read" }')
    const noBeta = editJsonEntry(JSON_FILE, ['mcpServers'], 'beta', undefined)
    expect(noBeta).toBe(without(JSON_FILE, '        "beta": { "type": "http", "url": "https://beta.example.test/mcp" },\n'))
    const none = editJsonEntry(noBeta, ['mcpServers'], 'alpha', undefined)
    expect(readJsonEntries(none, ['mcpServers']).size).toBe(0)
    expect(none).toContain('"mcpServers": {')
    // Removing what is not there changes nothing.
    expect(editJsonEntry(JSON_FILE, ['mcpServers'], 'nobody', undefined)).toBe(JSON_FILE)
    expect(editJsonEntry('', ['mcpServers'], 'nobody', undefined)).toBe('')
  })

  it('makes the key, or the file, when an entry is set where there is none', () => {
    const fresh = editJsonEntry('', ['mcpServers'], 'alpha', { command: 'alpha-tool' })
    expect(JSON.parse(fresh)).toEqual({ mcpServers: { alpha: { command: 'alpha-tool' } } })
    const keyed = editJsonEntry('{\n  "theme": "dark"\n}\n', ['mcp'], 'alpha', { type: 'local', command: ['alpha-tool'] })
    expect(JSON.parse(keyed)).toEqual({ theme: 'dark', mcp: { alpha: { type: 'local', command: ['alpha-tool'] } } })
    expect(keyed.startsWith('{\n  "theme": "dark",\n  "mcp": {')).toBe(true)
    const empty = editJsonEntry('{ "mcpServers": {} }', ['mcpServers'], 'alpha', { command: 'a' })
    expect(JSON.parse(empty)).toEqual({ mcpServers: { alpha: { command: 'a' } } })
  })

  it('puts an entry back as the exact text it had', () => {
    const raw = readJsonEntries(JSON_FILE, ['mcpServers']).get('alpha')!.raw
    const replaced = editJsonEntry(JSON_FILE, ['mcpServers'], 'alpha', { command: 'other' })
    expect(replaced).not.toContain('SYNTHETIC-COMMENT-IN-ENTRY')
    expect(editJsonEntry(replaced, ['mcpServers'], 'alpha', undefined, { raw })).toBe(JSON_FILE)
    // Where the entry is gone, it comes back as the same text at the end of the list.
    const gone = editJsonEntry(JSON_FILE, ['mcpServers'], 'alpha', undefined)
    expect(readJsonEntries(editJsonEntry(gone, ['mcpServers'], 'alpha', undefined, { raw }), ['mcpServers']).get('alpha')!.raw).toBe(raw)
  })

  it('refuses a file it cannot place with certainty', () => {
    for (const text of ['[1, 2]', '{ "mcpServers": [] }', '{ "mcpServers": { "a": {}, "a": {} } }', '{ "mcpServers": { "a": { ', '{} {}', '{ "mcpServers": { a: {} } }', '{ /* open']) {
      expect(() => readJsonEntries(text, ['mcpServers']), text).toThrow(ToolFileError)
    }
    expect(() => editJsonEntry('{ "mcpServers": 3 }', ['mcpServers'], 'a', {})).toThrow(ToolFileError)
  })
})

const TOML_FILE = `# SYNTHETIC-TOP-COMMENT
model = "gpt-synthetic"
model_context_window = 272000

[mcp_servers.alpha]
command = "alpha-tool"   # SYNTHETIC-LINE-COMMENT
args = [
  "--flag",
  "two words",
]
env_vars = ["ALPHA_KEY"]

[mcp_servers.alpha.env]
PLAIN = "x"

[profiles.deep]
model = "gpt-synthetic-deep"

[mcp_servers."be ta"]
url = 'https://beta.example.test/mcp'
env_http_headers = { Authorization = "BETA_TOKEN" }
enabled = true
startup_timeout_sec = 20
`

describe('Codex\'s settings file', () => {
  it('reads each entry with its tables as one value, its exact text and nothing of the rest', () => {
    const entries = readTomlEntries(TOML_FILE)
    expect([...entries.keys()]).toEqual(['alpha', 'be ta'])
    expect(entries.get('alpha')!.value).toEqual({ command: 'alpha-tool', args: ['--flag', 'two words'], env_vars: ['ALPHA_KEY'], env: { PLAIN: 'x' } })
    expect(entries.get('alpha')!.raw.startsWith('[mcp_servers.alpha]\n')).toBe(true)
    expect(entries.get('alpha')!.raw.endsWith('PLAIN = "x"')).toBe(true)
    expect(entries.get('be ta')!.value).toEqual({ url: 'https://beta.example.test/mcp', env_http_headers: { Authorization: 'BETA_TOKEN' }, enabled: true, startup_timeout_sec: 20 })
    expect(readTomlEntries('').size).toBe(0)
    expect(readTomlEntries('model = "x"\n').size).toBe(0)
  })

  it('marks the forms it does not edit as unreadable, and never changes them', () => {
    const reason = (text: string, id = 'alpha'): string | undefined => readTomlEntries(text).get(id)?.unreadable
    expect(reason('[mcp_servers]\nalpha = { command = "a" }\n')).toBe('it is written inline under [mcp_servers]')
    expect(reason('mcp_servers.alpha.command = "a"\n')).toBe('it is written with dotted keys')
    expect(reason('[mcp_servers.alpha]\ncommand = "a"\n\n[other]\nx = 1\n\n[mcp_servers.alpha.env]\nK = "v"\n')).toBe('its tables stand apart from each other')
    expect(reason('[mcp_servers.alpha]\ncommand = """\nlong\n"""\n')).toBe('a multi-line text is not read')
    expect(reason('[mcp_servers.alpha]\nargs = [\n  "a",\n')).toBe('a list is not closed')
    expect(reason('[mcp_servers.alpha]\nwhen = 2026-10-10\n')).toBe('a value cannot be read')
    const inline = '[mcp_servers]\nalpha = { command = "a" }\n'
    expect(() => editTomlEntry(inline, 'alpha', { command: 'b' })).toThrow(ToolFileError)
    expect(() => editTomlEntry(inline, 'alpha', undefined)).toThrow(ToolFileError)
    // Another entry in the same file is still BMN's to add.
    expect(readTomlEntries(editTomlEntry(inline, 'beta', { command: 'b' })).get('beta')!.value).toEqual({ command: 'b' })
  })

  it('writes an entry as Codex\'s own tables', () => {
    expect(renderTomlEntry('alpha', { command: 'alpha-tool', args: ['-y', 'pkg@1'], env_vars: ['ALPHA_KEY'] }))
      .toBe('[mcp_servers.alpha]\ncommand = "alpha-tool"\nargs = ["-y", "pkg@1"]\nenv_vars = ["ALPHA_KEY"]')
    expect(renderTomlEntry('be ta', { url: 'https://b.example.test', env_http_headers: { 'X-Key': 'B_KEY' } }))
      .toBe('[mcp_servers."be ta"]\nurl = "https://b.example.test"\nenv_http_headers = { X-Key = "B_KEY" }')
    const text = renderTomlEntry('q', { command: 'say "hi"\\now' })
    expect(readTomlEntries(`${text}\n`).get('q')!.value).toEqual({ command: 'say "hi"\\now' })
  })

  it('replaces an entry where it stands and leaves every other byte as it was', () => {
    const next = editTomlEntry(TOML_FILE, 'alpha', { command: 'alpha-tool', args: ['--other'] })
    const start = TOML_FILE.indexOf('[mcp_servers.alpha]')
    const end = TOML_FILE.indexOf('\n\n[profiles.deep]')
    expect(next.slice(0, start)).toBe(TOML_FILE.slice(0, start))
    expect(next.endsWith(TOML_FILE.slice(end))).toBe(true)
    expect(readTomlEntries(next).get('alpha')!.value).toEqual({ command: 'alpha-tool', args: ['--other'] })
    expect(readTomlEntries(next).get('be ta')!.raw).toBe(readTomlEntries(TOML_FILE).get('be ta')!.raw)
  })

  it('adds an entry at the end, and taking it out again gives the bytes back', () => {
    const added = editTomlEntry(TOML_FILE, 'gamma', { command: 'gamma-tool' })
    expect(added).toBe(`${TOML_FILE}\n[mcp_servers.gamma]\ncommand = "gamma-tool"\n`)
    expect(editTomlEntry(added, 'gamma', undefined)).toBe(TOML_FILE)
    expect(editTomlEntry('', 'gamma', { command: 'gamma-tool' })).toBe('[mcp_servers.gamma]\ncommand = "gamma-tool"\n')
    expect(editTomlEntry('model = "x"', 'gamma', { command: 'g' })).toBe('model = "x"\n\n[mcp_servers.gamma]\ncommand = "g"\n')
    expect(editTomlEntry(TOML_FILE, 'nobody', undefined)).toBe(TOML_FILE)
  })

  it('removes an entry with its sub-tables and nothing else', () => {
    const next = editTomlEntry(TOML_FILE, 'alpha', undefined)
    expect([...readTomlEntries(next).keys()]).toEqual(['be ta'])
    expect(next).toContain('model_context_window = 272000\n\n[profiles.deep]\nmodel = "gpt-synthetic-deep"\n')
    expect(next).not.toContain('PLAIN')
  })

  it('puts an entry back as the exact text it had', () => {
    const raw = readTomlEntries(TOML_FILE).get('alpha')!.raw
    const replaced = editTomlEntry(TOML_FILE, 'alpha', { command: 'other' })
    expect(replaced).not.toContain('SYNTHETIC-LINE-COMMENT')
    expect(editTomlEntry(replaced, 'alpha', undefined, 'mcp_servers', { raw })).toBe(TOML_FILE)
  })
})
