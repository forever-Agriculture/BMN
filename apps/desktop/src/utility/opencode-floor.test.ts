// MODULE: opencode-floor.test.ts - Story 102.15: OpenCode's refusal rows go in with every other byte of his file kept, and come out exactly
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseJsonc } from '../../bin/agents-check-routes.mjs'
import { openCodeConfigFile, openCodeFloorPlan, openCodeFloorRows, withOpenCodeFloor, withoutOpenCodeFloor } from '../../bin/opencode-floor.mjs'

const HIS = `{
  "$schema": "https://opencode.ai/config.json",

  // his note, with a brace { and "quotes"
  "model": "opencode-go/gpt-6-luna",

  "permission": {
    "external_directory": {
      "/home/someone/.claude/**": "allow"
    }
  },

  "agent": {
    "digest": { "permission": { "bash": "deny", "read": "deny" } }
  }
}
`
let home = ''
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'bmn-oc-floor-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })
type Config = { permission: { bash: Record<string, string>; read: Record<string, string>; external_directory?: unknown }; model?: string; agent?: { digest: { permission: { bash: string } } } }

describe('OpenCode\'s rows (102.15 AC1)', () => {
  it('go inside the permission he has, with no duplicate key, his bytes kept, and a second run changes nothing', () => {
    const next = withOpenCodeFloor(HIS, home)!
    const config = parseJsonc(next) as Config
    expect(config.permission.external_directory).toEqual({ '/home/someone/.claude/**': 'allow' })
    expect(config.permission.bash['docker system prune *']).toBe('deny')
    expect(config.permission.bash['sudo prime-select nvidia']).toBe('deny')
    expect(config.permission.bash['*~/.codex/auth.json*']).toBe('deny')
    expect(config.permission.read[`${home}/.codex/auth.json`]).toBe('deny')
    expect(config.agent?.digest.permission.bash).toBe('deny')
    expect(next.match(/"permission": \{\n {4}"external_directory"/gu)).toHaveLength(1)
    expect(withOpenCodeFloor(next, home)).toBe(next)
    // Every byte of his, in order: the file with BMN's region taken out is his file.
    expect(withoutOpenCodeFloor(next)).toBe(HIS)
  })

  it('go last in a map he already has, where the last match wins, and keep his own rows', () => {
    const his = '{\n  "permission": {\n    "bash": {\n      "*": "allow",\n      "git push *": "ask",\n    },\n    "read": { "*.env": "deny" }\n  }\n}\n'
    const next = withOpenCodeFloor(his, home)!
    const config = parseJsonc(next) as Config
    const keys = Object.keys(config.permission.bash)
    expect(keys.slice(0, 2)).toEqual(['*', 'git push *'])
    expect(config.permission.bash['*']).toBe('allow')
    expect(keys.at(-1)).toBe(openCodeFloorRows(home).bash.at(-1))
    expect(Object.keys(config.permission.read)[0]).toBe('*.env')
    expect(withoutOpenCodeFloor(next)).toBe(his)
    expect(withOpenCodeFloor(next, home)).toBe(next)
  })

  it('start a permission when he has none, and handle a last member with no comma and an empty object', () => {
    for (const his of ['{\n  "model": "x"\n}\n', '{\n  "model": "x",\n}\n', '{}\n', '{\n}\n']) {
      const next = withOpenCodeFloor(his, home)!
      expect((parseJsonc(next) as Config).permission.bash['docker system prune']).toBe('deny')
      expect(withoutOpenCodeFloor(next)).toBe(his)
    }
  })

  it('names a private key by name, so a public key and config stay readable, and a new key joins at the next run', () => {
    mkdirSync(join(home, '.ssh'))
    writeFileSync(join(home, '.ssh/id_ed25519'), 'synthetic')
    writeFileSync(join(home, '.ssh/id_ed25519.pub'), 'synthetic')
    writeFileSync(join(home, '.ssh/config'), 'synthetic')
    const first = withOpenCodeFloor(HIS, home)!
    expect((parseJsonc(first) as Config).permission.read['~/.ssh/id_ed25519']).toBe('deny')
    expect(first).not.toContain('id_ed25519.pub')
    expect(first).not.toContain('.ssh/config')
    writeFileSync(join(home, '.ssh/id_rsa'), 'synthetic')
    const second = withOpenCodeFloor(first, home)!
    expect((parseJsonc(second) as Config).permission.read['~/.ssh/id_rsa']).toBe('deny')
    expect(withoutOpenCodeFloor(second)).toBe(HIS)
  })

  it('leaves a file it cannot merge into, and says so', () => {
    expect(withOpenCodeFloor('{ "permission": "allow" }\n', home)).toBeNull()
    expect(withOpenCodeFloor('{ "permission": { "bash": "allow" } }\n', home)).toBeNull()
    writeFileSync(join(home, 'opencode.jsonc'), '{ "permission": "allow" }\n')
    expect(openCodeFloorPlan(home, home)).toMatchObject({ state: 'unusable', next: null })
    writeFileSync(join(home, 'opencode.jsonc'), '{ not json')
    expect(openCodeFloorPlan(home, home).state).toBe('unusable')
    writeFileSync(join(home, 'opencode.json'), '{}')
    expect(openCodeConfigFile(home)).toBeNull()
    expect(openCodeFloorPlan(home, home).state).toBe('unusable')
  })

  it('reads present and missing from the file', () => {
    expect(openCodeFloorPlan(home, home)).toMatchObject({ file: join(home, 'opencode.json'), text: null, state: 'missing' })
    writeFileSync(join(home, 'opencode.jsonc'), HIS)
    const plan = openCodeFloorPlan(home, home)
    expect(plan).toMatchObject({ file: join(home, 'opencode.jsonc'), state: 'missing' })
    writeFileSync(join(home, 'opencode.jsonc'), plan.next!)
    expect(openCodeFloorPlan(home, home).state).toBe('present')
  })
})
