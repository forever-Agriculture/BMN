// MODULE: tools-view.test.ts - Story 60.12: the Tools page's words, its plain rows and the team it stages, over a synthetic team
import { describe, expect, it } from 'vitest'
import type { RosterAgentShape, RosterDataShape, RosterToolShape, ToolProposalView } from '@bmn/protocol'
import {
  EMPTY_DRAFT, addable, draftFrom, idFromName, removeTool, scopeWords, setTool, setToolPublic, toggleToolAgent, toggleToolApp, toolForApp, toolFrom, toolScope,
  toolStateHint, toolStateWords, toolsTestLine, transportWords, withProposals, type ToolDraft
} from './tools-view'

const agent = (id: string): RosterAgentShape => ({
  id, name: id.charAt(0).toUpperCase() + id.slice(1), class: 'pawn', harness: 'codex', model: `model-${id}`, provider: 'openai', host: 'default', enabled: true, status: 'active', efforts: ['low'], roles: []
})

const DOCS: RosterToolShape = { id: 'docs', name: 'Docs', url: 'https://docs.example.test/mcp', headers: { Authorization: 'DOCS_TOKEN' }, public: true }
const FILES: RosterToolShape = { id: 'files', name: 'Files', command: 'files-tool', args: ['--root', '/srv/files', { env: 'FILES_ROOT' }], env: { FILES_KEY: 'FILES_KEY', REGION: 'OWNER_REGION' }, apps: ['claude', 'codex'] }
const BROWSER: RosterToolShape = { id: 'browser', name: 'Browser', command: 'npx', args: ['--offline', '@synthetic/browser-mcp@1.0.0'], agents: ['luna'] }

const DATA = {
  schema_version: 2, providers: [], roles: [], exceptions: [], harness_routes: [], agents: [agent('luna'), agent('astra')], tools: [BROWSER, DOCS, FILES]
} as unknown as RosterDataShape
const NONE = Object.fromEntries(Object.entries(DATA).filter(([key]) => key !== 'tools')) as RosterDataShape

describe('who a tool is for', () => {
  it('is every app, some apps, or the runs of some agents and then no app', () => {
    expect([toolScope(DOCS), toolScope(FILES), toolScope(BROWSER)]).toEqual(['all', 'apps', 'agents'])
    expect(toolForApp(DOCS, 'opencode')).toBe(true)
    expect([toolForApp(FILES, 'codex'), toolForApp(FILES, 'opencode')]).toEqual([true, false])
    expect(toolForApp(BROWSER, 'codex')).toBe(false)
    const name = (id: string): string => DATA.agents.find((entry) => entry.id === id)?.name ?? id
    expect([scopeWords(DOCS, name), scopeWords(FILES, name), scopeWords(BROWSER, name)]).toEqual(['every app', 'Claude Code, Codex', 'the runs of Luna'])
    expect([transportWords(DOCS), transportWords(FILES), transportWords(BROWSER)]).toEqual(['docs.example.test', 'files-tool /srv/files', 'npx @synthetic/browser-mcp@1.0.0'])
  })

  it('stages a scope or Public change and nothing else', () => {
    const narrowed = toggleToolApp(DATA, 'files', 'claude')
    expect(narrowed.tools!.find((tool) => tool.id === 'files')).toEqual({ ...FILES, apps: ['codex'] })
    expect(narrowed.tools!.filter((tool) => tool.id !== 'files')).toEqual([BROWSER, DOCS])
    // The last app stays; all three apps is every app again.
    expect(toggleToolApp(narrowed, 'files', 'codex')).toBe(narrowed)
    const all = (['opencode', 'claude'] as const).reduce((data, harness) => toggleToolApp(data, 'files', harness), narrowed)
    expect(all.tools!.find((tool) => tool.id === 'files')).not.toHaveProperty('apps')
    expect(toggleToolApp(DATA, 'docs', 'opencode').tools!.find((tool) => tool.id === 'docs')!.apps).toEqual(['claude', 'codex'])
    // A tool kept to agents has no app to toggle; its agents toggle, and the last one stays.
    expect(toggleToolApp(DATA, 'browser', 'codex')).toBe(DATA)
    expect(toggleToolAgent(DATA, 'browser', 'astra').tools!.find((tool) => tool.id === 'browser')!.agents).toEqual(['astra', 'luna'])
    expect(toggleToolAgent(DATA, 'browser', 'luna')).toBe(DATA)
    expect(toggleToolAgent(DATA, 'docs', 'luna')).toBe(DATA)
    expect(setToolPublic(DATA, 'docs', false).tools!.find((tool) => tool.id === 'docs')).not.toHaveProperty('public')
    expect(setToolPublic(DATA, 'files', true).tools!.find((tool) => tool.id === 'files')!.public).toBe(true)
  })

  it('keeps the list in id order, and a team with no tool has no list', () => {
    const added = setTool(NONE, FILES)
    expect(added.tools).toEqual([FILES])
    expect(setTool(setTool(added, DOCS), BROWSER).tools!.map((tool) => tool.id)).toEqual(['browser', 'docs', 'files'])
    expect(setTool(DATA, { ...DOCS, name: 'Documents' }).tools!.find((tool) => tool.id === 'docs')!.name).toBe('Documents')
    expect(removeTool(added, 'files')).toEqual(NONE)
    expect(removeTool(added, 'files')).not.toHaveProperty('tools')
    expect(removeTool(DATA, 'docs').tools!.map((tool) => tool.id)).toEqual(['browser', 'files'])
  })

  it('reads a tool saved for Cursor too: Cursor is named but never offered, and saving the tool leaves it out (Epic 71)', () => {
    const saved: RosterToolShape = { ...FILES, apps: ['claude', 'cursor'] }
    const name = (id: string): string => id
    expect(scopeWords(saved, name)).toBe('Claude Code, Cursor')
    expect(draftFrom(saved).apps).toEqual(['claude'])
    expect(toolFrom(draftFrom(saved), DATA)).toEqual({ tool: { ...FILES, apps: ['claude'] } })
    expect(toggleToolApp({ ...DATA, tools: [saved] }, 'files', 'codex').tools![0]!.apps).toEqual(['claude', 'codex'])
  })
})

describe('a tool\'s state in words', () => {
  const on = { supported: true }
  it('says what the owner can do about it', () => {
    expect(toolStateWords('current', on, true)).toBe('Set up')
    expect(toolStateWords('missing', on, true)).toBe('Missing')
    expect(toolStateWords('stale', on, true)).toBe('Differs')
    expect(toolStateWords('unmanaged', on, true)).toBe('Differs')
    expect(toolStateWords('blocked', on, true)).toBe('Blocked')
    expect(toolStateWords('excluded', on, true)).toBe('Not public')
    expect(toolStateWords('excluded', on, false)).toBe('Off')
    expect(toolStateWords('exposed', on, false)).toBe('Exposed')
    expect(toolStateWords('missing', { supported: false }, true)).toBe('Not yet')
    expect(toolStateWords(undefined, on, true)).toBe('Not yet')
    expect(toolStateHint('missing', on, true, 'Codex')).toBe('Not in Codex yet: BMN adds it at its next start or approval')
    // Story 75.9: what BMN installs by itself never takes over an entry it did not write.
    expect(toolStateHint('unmanaged', on, true, 'Codex')).toBe('Codex holds something else under this name, which BMN leaves as it is: remove it there and BMN adds the tool')
    expect(toolStateHint('blocked', on, true, 'Codex', 'Codex has no way to pass an environment variable as an argument')).toBe('Codex has no way to pass an environment variable as an argument')
    expect(toolStateHint('exposed', on, false, 'OpenCode')).toBe('OpenCode holds this tool but may not have it')
    expect(toolStateHint('missing', { supported: false }, true, 'OpenCode')).toBe('Tools are not supported yet in OpenCode: Health says how BMN\'s test of it stands')
    expect(toolStateHint('current', on, false, 'OpenCode')).toBe('Not for OpenCode')
  })

  it('says when an app was tested and what the test saw', () => {
    const day = (iso: string): string => `<${iso.slice(0, 10)}>`
    const test = { at: '2026-10-10T12:00:00.000Z', version: '0.161.0', outcome: 'pass' as const, detail: '' }
    // The tools test sends no prompt: it reads as a check (Story 75.8 AC2).
    expect(toolsTestLine({ supported: true, version: '0.161.0', test, variable: true, isolation: true }, day)).toBe('Checked <2026-10-10> · passes variables · a run keeps to its own tools')
    expect(toolsTestLine({ supported: true, version: '0.161.0', test: { ...test, by: 'bmn' }, variable: false, isolation: false }, day)).toBe('Checked <2026-10-10> by BMN · variables not seen · no run seen kept to its tools')
    expect(toolsTestLine({ supported: false, version: '0.162.0', test, variable: false, isolation: false }, day)).toBe('BMN tests 0.162.0 by itself')
    expect(toolsTestLine({ supported: false, version: '0.161.0', test: { ...test, outcome: 'fail' }, variable: false, isolation: false }, day)).toBe('The test failed on 0.161.0')
    expect(toolsTestLine({ supported: false, version: '0.161.0', test: { ...test, outcome: 'inconclusive' }, variable: false, isolation: false }, day)).toBe('The test was inconclusive on 0.161.0')
    expect(toolsTestLine({ supported: false, version: null, test: null, variable: false, isolation: false }, day)).toBe('The app is not found')
  })
})

describe('Add tool and Edit: plain rows', () => {
  it('opens a tool as the rows that wrote it, and gives the same tool back', () => {
    for (const tool of [DOCS, FILES, BROWSER]) {
      const draft = draftFrom(tool)
      expect(draft.editing).toBe(tool.id)
      expect(toolFrom(draft, DATA)).toEqual({ tool })
    }
    expect(draftFrom(FILES)).toMatchObject({ kind: 'program', command: 'files-tool', args: '--root\n/srv/files\n$FILES_ROOT', env: 'FILES_KEY\nREGION=OWNER_REGION', scope: 'apps', apps: ['claude', 'codex'] })
    expect(draftFrom(DOCS)).toMatchObject({ kind: 'address', url: 'https://docs.example.test/mcp', headers: 'Authorization=DOCS_TOKEN', scope: 'all', public: true })
  })

  it('builds a new tool from the rows, taking a variable only by its name', () => {
    const draft: ToolDraft = { ...EMPTY_DRAFT, id: 'search', name: ' Search ', command: ' search-tool ', args: '--region\n\n  eu  \n$SEARCH_REGION', env: 'SEARCH_KEY\nTOKEN = OWNER_TOKEN', scope: 'agents', agents: ['luna', 'nobody', 'luna'] }
    expect(toolFrom(draft, DATA)).toEqual({ tool: { id: 'search', name: 'Search', command: 'search-tool', args: ['--region', 'eu', { env: 'SEARCH_REGION' }], env: { SEARCH_KEY: 'SEARCH_KEY', TOKEN: 'OWNER_TOKEN' }, agents: ['luna'] } })
    expect(toolFrom({ ...EMPTY_DRAFT, id: 'web', name: 'Web', kind: 'address', url: 'http://localhost:8931/mcp', scope: 'apps', apps: ['opencode', 'claude'], public: true }, DATA))
      .toEqual({ tool: { id: 'web', name: 'Web', url: 'http://localhost:8931/mcp', public: true, apps: ['claude', 'opencode'] } })
    expect(idFromName('  My Browser (v2)! ')).toBe('my-browser-v2')
  })

  it('says what is wrong with a row in plain words, and never accepts a value where a variable is named', () => {
    const errors = (draft: Partial<ToolDraft>) => toolFrom({ ...EMPTY_DRAFT, id: 'x', name: 'X', command: 'x', ...draft }, DATA).errors
    expect(errors({})).toBeUndefined()
    expect(errors({ id: 'Bad Id' })).toEqual({ id: 'Lowercase letters, digits, - and _, at most 40' })
    expect(errors({ id: 'docs' })).toEqual({ id: 'Another tool has this id' })
    expect(errors({ name: ' ' })).toEqual({ name: 'A name of 1 to 40 characters' })
    expect(errors({ command: '' })).toEqual({ command: 'The program to start, by name or path' })
    expect(errors({ env: 'X_KEY=sk-SYNTHETIC-SECRET-9f8e' })).toEqual({ env: '"X_KEY=sk-SYNTHETIC-SECRET-9f8e" is not a variable name. Name the variable, never its value.' })
    expect(errors({ env: 'A\nA' })).toEqual({ env: 'A is there twice' })
    expect(errors({ kind: 'address', url: 'docs.example.test' })).toEqual({ url: 'An address that starts with https://' })
    expect(errors({ kind: 'address', url: 'http://docs.example.test' })).toEqual({ url: 'An address that starts with https:// (http:// only for this machine)' })
    expect(errors({ kind: 'address', url: 'https://me:pw@docs.example.test' })).toEqual({ url: 'No name or password in the address: name a variable under Headers' })
    expect(errors({ kind: 'address', url: 'https://docs.example.test', headers: 'Authorization' })).toEqual({ headers: '"Authorization" needs the variable it comes from: Authorization=VARIABLE' })
    expect(errors({ kind: 'address', url: 'https://docs.example.test', headers: 'Authorization=Bearer abc' })).toEqual({ headers: '"Authorization=Bearer abc" is not Header=VARIABLE. Name the variable, never its value.' })
    expect(errors({ scope: 'apps', apps: [] })).toEqual({ scope: 'Choose at least one app' })
    expect(errors({ scope: 'agents', agents: ['nobody'] })).toEqual({ scope: 'Choose at least one agent' })
    // Editing keeps its own id free.
    expect(toolFrom({ ...draftFrom(DOCS), name: 'Documents' }, DATA).tool).toEqual({ ...DOCS, name: 'Documents' })
  })
})

describe('tools the apps already hold', () => {
  const proposals: ToolProposalView[] = [
    { id: 'playwright', state: 'ready', apps: ['codex'], tool: { id: 'playwright', name: 'Playwright', command: 'npx', apps: ['codex'] }, notes: [] },
    { id: 'canva', state: 'secret', apps: ['claude'], tool: { id: 'canva', name: 'Canva', url: 'https://canva.example.test/mcp', apps: ['claude'] }, notes: ['holds a value inline'] },
    { id: 'docs', state: 'known', apps: ['claude'], notes: ['already on your list'] },
    { id: 'differs', state: 'conflict', apps: ['claude'], tool: { id: 'differs', name: 'Differs', command: 'a', apps: ['claude'] }, notes: [] },
    { id: 'odd', state: 'unreadable', apps: ['codex'], notes: [] }
  ]
  it('adds only what is readable, new and defined one way', () => {
    const tools = addable(proposals, DATA)
    expect(tools.map((tool) => tool.id)).toEqual(['playwright', 'canva'])
    expect(withProposals(DATA, tools).tools!.map((tool) => tool.id)).toEqual(['browser', 'canva', 'docs', 'files', 'playwright'])
    expect(addable(proposals, withProposals(DATA, tools))).toEqual([])
  })
})
