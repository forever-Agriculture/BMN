// MODULE: message-wake-startup.test.mjs - onboarding is not a composer and partial inventory cannot skip cleanup
import { describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertMessageProfileSeal, assertMessageQualifications, classifyMessageStartup, cleanupMessageProbe, messageProfileSnapshot, messageStartupStep, messageActivityVerdict, messageChildFixture, messageActivityFixture, assertMessageSetupConfiguration, messageCodexConfiguration, recordMessageVerdict, messageNativeEscape, messageNowSampler, messageRecorderHealthy, messageActivityComposer, messageProfileSealMigration, messageSocketGuidance, messageProcessIdentity } from '../test/message-wake-startup.mjs'
import { processTree, stopTree } from '../test/away-skills-processes.mjs'
import { collectMessageHookQueries } from '../test/message-wake-startup.mjs'
import { approvalFrom } from '../../apps/desktop/bin/codex-hook-approval.mjs'
const theme = ['Choose the text style that looks best with your terminal', 'To change this later, run /theme', 'Auto (match terminal)', '❯ ✔ Dark mode', 'Light mode', 'Dark mode (colorblind-friendly)', 'Light mode (colorblind-friendly)', 'Dark mode (ANSI colors only)', 'Light mode (ANSI colors only)']
const capturedStartup = JSON.parse(readFileSync(new URL('./fixtures/away-skills-startup-captures.json', import.meta.url), 'utf8'))
const declaredCodex = Object.entries(messageCodexConfiguration).map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join('\n')+'\n'
// Verbatim synthetic native capture: method2 startup-56fd4bde.json, final observation, launch echo removed.
const security = `Welcome to Claude Code v2.1.319
..........................................................

     *                                       █████▓▓░
                                 *         ███▓░     ░░
            ░░░░░░                        ███▓░
    ░░░   ░░░░░░░░░░                      ███▓░
   ░░░░░░░░░░░░░░░░░░░    *                ██▓░░      ▓
                                             ░▓▓███▓▓░
 *                                 ░░░░
                                 ░░░░░░░░
                               ░░░░░░░░░░░░░░░░
       █████████                                        *
      ██▄█████▄██                        *
       █████████      *
.......█ █   █ █..........................................

 Security notes:

 1. Claude can make mistakes.
    You're responsible for Claude's actions and should always
    review them, especially when running code.

 2. Due to prompt injection risks, only use it with code you trust
    Learn more: https://code.claude.com/docs/en/security

 Press Enter to continue…`.split('\n')
describe('bounded startup transitions', () => {
  it.each(['claude', 'codex'])('replays authentic %s qualification and retained composer restart with at most two trust keys', app => {
    const capture = capturedStartup.qualifications[app]
    const sequence = capture.sequence.map(row => row.screen)
    const run = screens => {
      const history = [], used = { keys: 0 }, context = { appSeen: true }
      let action
      for (const [i, lines] of screens.entries()) {
        history.push({ ...classifyMessageStartup(app, lines, capture.fixture, context), at: i*2000, screen: lines.join('\n') })
        action = messageStartupStep(history, used)
        if (action.action === 'key') { used.keys++; used[action.mark] = true }
        if (action.action === 'fail' || action.action === 'ready') break
      }
      return { action: action.action, keys: used.keys }
    }
    expect(run([...sequence, sequence.at(-1)])).toEqual({ action: 'ready', keys: app === 'claude' ? 2 : 1 })
    expect(run([sequence.at(-1), sequence.at(-1)])).toEqual({ action: 'ready', keys: 0 })
  })
  it.each(['Hooks need review', 'Allow once?', 'Permission request', 'Update available', 'API key required'])('gives no key to a permission overlay on an authentic trust frame: %s', overlay => {
    const { screen, fixture } = capturedStartup.apps.claude
    const lines = [overlay, ...screen]
    const state = classifyMessageStartup('claude', lines, fixture, { appSeen: true })
    expect(state.state).toBe('dialog')
    expect(messageStartupStep([state], { keys: 0 }).action).toBe('fail')
  })
  it('leaves even the exact informational onboarding frame for the owner', () => {
    const launchEcho = 'bash-5.3$ claude --model haiku --permission-mode dontAsk'
    const state = classifyMessageStartup('claude', [launchEcho.slice(0, 30), launchEcho.slice(30), ...security, '', ''], '/synthetic', { launchEcho, appSeen: true })
    expect(state.state).toBe('dialog')
    expect(messageStartupStep([state], { keys: 0 }).action).toBe('fail')
    for (const used of [{ keys: 0 }, { keys: 2, theme: true, 'security-notice': true }, { keys: 4, theme: true }]) expect(messageStartupStep([state], used).action).toBe('fail')
  })
  it.each([security.slice(1), security.slice(0, -1), [...security, 'Allow once?'], [...security, 'Hooks need review'], security.map(line => line.replace('2.1.319', '2.1.320'))].map(lines => [lines]))('never acknowledges a truncated, overlaid or changed security frame', lines => {
    expect(classifyMessageStartup('claude', lines, '/synthetic').state).toBe('dialog')
  })
  it('waits only on the exact wrapped launch echo before its first app frame', () => {
    const launchEcho = 'bash-5.3$ claude --permission-mode dontAsk'
    const context = () => ({ launchEcho, appSeen: false })
    expect(classifyMessageStartup('claude', ['bash-5.3$ claude --permission-', 'mode dontAsk', ''], '/synthetic', context()).state).toBe('loading')
    for (const lines of [['bash-5.3$ claude --permission-mode dontAsk', 'Allow once?'], [launchEcho, 'Update available'], [launchEcho, 'unknown'], [launchEcho+' altered'], [launchEcho.slice(0,-2)]]) {
      expect(classifyMessageStartup('claude', lines, '/synthetic', context()).state).toBe('dialog')
    }
    expect(classifyMessageStartup('claude', [launchEcho], '/synthetic', { launchEcho, appSeen: true }).state).toBe('dialog')
  })
  it('leaves the complete captured theme choice for the owner', () => expect(classifyMessageStartup('claude', theme, '/synthetic').state).toBe('dialog'))
  it.each([theme.slice(0, -1), [...theme, 'Allow once?'], [...theme, 'Update available'], ['❯ ✔ Dark mode'], theme.map(line => line.replace('❯ ✔', ' '))].map(lines => [lines]))('answers no unknown, permission, update or truncated screen', lines => {
    const state = classifyMessageStartup('claude', lines, '/synthetic')
    expect(['theme', 'composer', 'trust']).not.toContain(state.state)
  })
  it('never confirms a persisted dialog or exhausted key budget', () => {
    const history = [{ state: 'theme' }]
    expect(messageStartupStep(history, { keys: 0 }).action).toBe('fail')
    expect(messageStartupStep(history, { keys: 1, theme: true }).action).toBe('fail')
    expect(messageStartupStep(history, { keys: 4 }).action).toBe('fail')
    expect(messageStartupStep([{ state: 'dialog', detail: 'permission' }], { keys: 0 }).action).toBe('fail')
  })
  it('allows only exact fixture trust, at most two keys, and stops after a persisted selection', () => {
    expect(messageStartupStep([{ state: 'trust-negative' }], { keys: 0 })).toEqual({ action: 'key', key: 'ArrowDown', mark: 'trustDown' })
    expect(messageStartupStep([{ state: 'trust' }], { keys: 1, trustDown: true })).toEqual({ action: 'key', key: 'Enter', mark: 'trust' })
    for (const state of ['trust', 'trust-negative']) {
      expect(messageStartupStep([{ state }], { keys: 2, trustDown: true, trust: true }).action).toBe('fail')
    }
    expect(messageStartupStep([{ state: 'loading' }], { keys: 1, trustDown: true }).action).toBe('fail')
    for (const state of ['theme', 'security-notice', 'permission', 'hook-review', 'unknown']) {
      expect(messageStartupStep([{ state }], { keys: 0 }).action).toBe('fail')
    }
  })
  it('requires two identical composer screens over the stated stable interval', () => {
    const one = { state: 'composer', at: 1000, screen: 'ready' }
    expect(messageStartupStep([one], { keys: 0 }).action).toBe('wait')
    expect(messageStartupStep([one, { ...one, at: 2000 }], { keys: 0 }).action).toBe('wait')
    expect(messageStartupStep([one, { ...one, at: 2600, screen: 'changed' }], { keys: 0 }).action).toBe('wait')
    expect(messageStartupStep([one, { ...one, at: 2600 }], { keys: 0 }).action).toBe('ready')
  })
})
describe('cleanup after partial inventory', () => {
  it.each(['inventory', 'save', 'sessions', 'application', 'fallback'])('preserves primary failure and attempts every stop after %s errors', async failed => {
    const calls = [], stage = name => async () => { calls.push(name); if (failed === name) throw new Error('injected exit 2'); return true }
    const result = await cleanupMessageProbe({ primary: 'startup failed', inventory: stage('inventory'), save: stage('save'), stopSessions: stage('sessions'), closeApplication: stage('application'), ensureStopped: stage('fallback') })
    expect(calls).toContain('sessions'); expect(calls).toContain('application'); expect(calls).toContain('fallback')
    expect(result.primary).toBe('startup failed'); expect(result.stopped).toBe(failed === 'fallback' ? null : true); expect(result.errors.length).toBeGreaterThan(0)
  })
})

describe('retained bundle identity and nonsecret projection', () => {
  const bundle = action => {
    const root = mkdtempSync(join(tmpdir(), 'bmn-message-bundle-test-'))
    const profiles = join(root, 'profiles'), fixture = join(root, 'fixture'), other = join(root, 'other')
    for (const path of [profiles, join(profiles, 'claude'), join(profiles, 'codex'), fixture, other]) mkdirSync(path, { mode: 0o700 })
    for (const name of ['claude/settings.json', 'codex/hooks.json']) writeFileSync(join(profiles, name), '{}', { mode: 0o600 })
    writeFileSync(join(profiles, 'codex/config.toml'), declaredCodex, { mode: 0o600 })
    const onboarding = join(profiles, 'claude/.claude.json')
    writeFileSync(onboarding, JSON.stringify({ hasCompletedOnboarding: true, unrelatedPersonalField: 'never-retain-this', projects: { [fixture]: { hasTrustDialogAccepted: true } } }), { mode: 0o600 })
    // Unreadable/dangling sign-in links must have no influence on a nonsecret snapshot.
    symlinkSync(join(root, 'not-readable-or-present'), join(profiles, 'codex/auth.json'))
    try { return action({ profiles, fixture, other, onboarding, root }) } finally { rmSync(root, { recursive: true, force: true }) }
  }
  it('retains only declared onboarding fields and permits native volatile-state changes', () => bundle(({ profiles, fixture, onboarding }) => {
    const before = messageProfileSnapshot(profiles, [fixture])
    expect(JSON.stringify(before)).not.toContain('never-retain-this')
    writeFileSync(onboarding, JSON.stringify({ hasCompletedOnboarding: true, nativeCounter: 99 }), { mode: 0o600 })
    const after = messageProfileSnapshot(profiles, [fixture])
    expect(after.onboarding.fixtures[0].hasTrustDialogAccepted).toBe(false)
    expect(() => assertMessageProfileSeal(before, after)).not.toThrow()
  }))
  it('seals owner-written Codex configuration after setup while keeping hooks and directories bound', () => bundle(({ profiles, fixture }) => {
    const prepared = messageProfileSnapshot(profiles, [fixture])
    writeFileSync(join(profiles, 'codex/config.toml'), declaredCodex+'[tui]\nscreen_reader_detection_done = true\n', { mode: 0o600 })
    const completed = messageProfileSnapshot(profiles, [fixture])
    expect(() => assertMessageProfileSeal(prepared, completed, { ownerSetup: true })).not.toThrow()
    expect(() => assertMessageProfileSeal(prepared, completed)).toThrow(/drifted/)
    expect(() => assertMessageProfileSeal(completed, completed)).not.toThrow()
    writeFileSync(join(profiles, 'codex/hooks.json'), '{"changed":true}', { mode: 0o600 })
    expect(() => assertMessageProfileSeal(prepared, messageProfileSnapshot(profiles, [fixture]), { ownerSetup: true })).toThrow(/drifted/)
  }))
  it('accepts the owner theme and object-key ordering only against the exact prepared preimage', () => bundle(({ profiles, fixture }) => {
    const file = join(profiles, 'claude/settings.json')
    const initial = { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'synthetic-hook', timeout: 5 }] }] }, permissions: { deny: ['synthetic-deny'] } }
    const text = JSON.stringify(initial, null, 2)+'\n'
    writeFileSync(file, text, { mode: 0o600 })
    const prepared = messageProfileSnapshot(profiles, [fixture])
    const changed = { theme: 'dark', permissions: initial.permissions, hooks: { Stop: [{ hooks: [{ timeout: 5, command: 'synthetic-hook', type: 'command' }] }] } }
    writeFileSync(file, JSON.stringify(changed, null, 2)+'\n', { mode: 0o600 })
    const current = messageProfileSnapshot(profiles, [fixture])
    expect(() => assertMessageProfileSeal(prepared, current, { ownerSetup: true, preparedClaudeSettings: text })).not.toThrow()
    expect(() => assertMessageProfileSeal(prepared, current, { ownerSetup: true })).toThrow(/drifted/)
    expect(() => assertMessageProfileSeal(prepared, current, { ownerSetup: true, preparedClaudeSettings: text+' ' })).toThrow(/drifted/)
    expect(() => assertMessageProfileSeal(prepared, current)).toThrow(/drifted/)
    changed.permissions.deny = []
    writeFileSync(file, JSON.stringify(changed)+'\n', { mode: 0o600 })
    expect(() => assertMessageProfileSeal(prepared, messageProfileSnapshot(profiles, [fixture]), { ownerSetup: true, preparedClaudeSettings: text })).toThrow(/drifted/)
  }))
  it.each(['claude/settings.json', 'codex/hooks.json', 'codex/config.toml'])('stops before launch when sealed %s changes', name => bundle(({ profiles, fixture }) => {
    const seal = messageProfileSnapshot(profiles, [fixture])
    writeFileSync(join(profiles, name), 'changed', { mode: 0o600 })
    expect(() => assertMessageProfileSeal(seal, messageProfileSnapshot(profiles, [fixture]))).toThrow(/drifted/)
  }))
  it('rejects recreated fixture identity even at the same path', () => bundle(({ profiles, fixture }) => {
    const seal = messageProfileSnapshot(profiles, [fixture])
    renameSync(fixture, fixture+'-old'); mkdirSync(fixture, { mode: 0o700 })
    expect(() => assertMessageProfileSeal(seal, messageProfileSnapshot(profiles, [fixture]))).toThrow(/drifted/)
  }))
  it('rejects foreign symlinks and nonprivate static configuration', () => bundle(({ profiles, fixture, root }) => {
    const path = join(profiles, 'codex/hooks.json')
    chmodSync(path, 0o644)
    expect(() => messageProfileSnapshot(profiles, [fixture])).toThrow(/Unsafe/)
    rmSync(path); symlinkSync(join(root, 'not-readable-or-present'), path)
    expect(() => messageProfileSnapshot(profiles, [fixture])).toThrow(/Unsafe/)
  }))
  it('requires owner-completed onboarding even when static configuration matches', () => bundle(({ profiles, fixture, onboarding }) => {
    const seal = messageProfileSnapshot(profiles, [fixture])
    writeFileSync(onboarding, '{}', { mode: 0o600 })
    expect(() => assertMessageProfileSeal(seal, messageProfileSnapshot(profiles, [fixture]))).toThrow(/Owner onboarding/)
  }))
  const retainedCodex = (fixture, counter = '1') => declaredCodex+`[tui]\nscreen_reader_detection_done = true\n[tui.model_availability_nux]\n"gpt-6.1-sol" = ${counter}\n[projects.${JSON.stringify(fixture)}]\ntrust_level = "trusted"\n[hooks.state.synthetic]\ntrusted_hash = "sha256:original"\n[notice]\nacknowledged = true\n`
  it('admits only the captured native counter and exact other-fixture trust changes, retaining raw hashes', () => bundle(({ profiles, fixture, other }) => {
    const file = join(profiles, 'codex/config.toml'), before = retainedCodex(fixture)
    writeFileSync(file, before)
    const seal = messageProfileSnapshot(profiles, [fixture, other])
    writeFileSync(file, retainedCodex(fixture, '2')+`[projects.${JSON.stringify(other)}]\ntrust_level = "trusted"\n`)
    const after = messageProfileSnapshot(profiles, [fixture, other])
    expect(() => assertMessageProfileSeal(seal, after)).not.toThrow()
    expect(after.static.files['codex/config.toml']).toEqual({ encoding: 'codex-config-semantic-v1', sha256: expect.any(String), mode: 0o600 })
    expect(after.codexConfigRawSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(after.codexConfigRawSha256).not.toBe(seal.codexConfigRawSha256)
    writeFileSync(file, retainedCodex(fixture, '3'))
    expect(() => assertMessageProfileSeal(seal, messageProfileSnapshot(profiles, [fixture, other]))).not.toThrow()
    for (const value of ['0', '4294967295']) {
      writeFileSync(file, retainedCodex(fixture, value))
      expect(() => assertMessageProfileSeal(seal, messageProfileSnapshot(profiles, [fixture, other]))).not.toThrow()
    }
  }))
  it('qualifies restarts with distinct raw counters while rejecting protected restart drift', () => bundle(({ profiles, fixture, other }) => {
    const file = join(profiles, 'codex/config.toml')
    const cycle = (app, number) => {
      writeFileSync(file, retainedCodex(fixture, String(number)))
      const snapshot = messageProfileSnapshot(profiles, [fixture, other])
      return { version: 2, app, pass: true, startedAt: number*100, shutdownAt: number*100+50, applicationIdentity: { pid: number, start_ticks: String(number) },
        cleanup: { primary: null, errors: [], stopped: { stopped: true, remaining: [] } },
        evidence: Array.from({ length: 5 }, (_, i) => ({ pass: true, rootStop: 'root-stop', executionMarker: 'marker', session: `${number}-${i}` })),
        binding: { app, profiles: snapshot, qualifiedInputs: { candidateBuildSha256: 'candidate', configs: { codex: snapshot.static.files['codex/config.toml'] } } }, profilesAfter: snapshot }
    }
    const receipts = { claude: [cycle('claude', 1), cycle('claude', 2)], codex: [cycle('codex', 3), cycle('codex', 4)] }
    expect(receipts.claude[0].binding.profiles.codexConfigRawSha256).not.toBe(receipts.claude[1].binding.profiles.codexConfigRawSha256)
    expect(() => assertMessageQualifications(receipts, 'claude', receipts.claude[0].binding)).not.toThrow()
    writeFileSync(file, retainedCodex(fixture, '4').replace('acknowledged = true', 'acknowledged = false'))
    const changed = messageProfileSnapshot(profiles, [fixture, other])
    receipts.codex[1].binding.profiles = changed; receipts.codex[1].profilesAfter = changed
    receipts.codex[1].binding.qualifiedInputs.configs.codex = changed.static.files['codex/config.toml']
    expect(() => assertMessageQualifications(receipts, 'claude', receipts.claude[0].binding)).toThrow(/binding changed/)
  }))
  it.each(['-1', '1.5', '1.0', '4294967296', '"2"', 'true', '{ count = 2 }'])('rejects invalid NUX counter %s', value => bundle(({ profiles, fixture }) => {
    const file = join(profiles, 'codex/config.toml')
    writeFileSync(file, retainedCodex(fixture))
    const seal = messageProfileSnapshot(profiles, [fixture])
    writeFileSync(file, retainedCodex(fixture, value))
    expect(() => assertMessageProfileSeal(seal, messageProfileSnapshot(profiles, [fixture]))).toThrow(/drifted/)
  }))
  it.each(['new-key', 'not-table', 'missing-key'])('binds the NUX key set: %s', defect => bundle(({ profiles, fixture }) => {
    const file = join(profiles, 'codex/config.toml'), before = retainedCodex(fixture)
    writeFileSync(file, before); const seal = messageProfileSnapshot(profiles, [fixture])
    const after = defect === 'new-key' ? before.replace('"gpt-6.1-sol" = 1', '"gpt-6.1-sol" = 1\nnew = 2') : defect === 'not-table' ? before.replace('[tui.model_availability_nux]\n"gpt-6.1-sol" = 1', 'model_availability_nux = 2') : before.replace('"gpt-6.1-sol" = 1\n', '')
    writeFileSync(file, after)
    expect(() => assertMessageProfileSeal(seal, messageProfileSnapshot(profiles, [fixture]))).toThrow(/drifted/)
  }))
  it.each(['third', 'root', 'parent', 'slash', 'alias', 'untrusted', 'extra-key'])('rejects an unapproved project trust change: %s', defect => bundle(({ profiles, fixture, other, root }) => {
    const file = join(profiles, 'codex/config.toml'), before = retainedCodex(fixture)
    writeFileSync(file, before); const seal = messageProfileSnapshot(profiles, [fixture, other])
    const alias = join(root, 'alias'); symlinkSync(other, alias)
    const path = { third: join(root, 'third'), root: '/', parent: root, slash: other+'/', alias, untrusted: other, 'extra-key': other }[defect]
    writeFileSync(file, before+`[projects.${JSON.stringify(path)}]\ntrust_level = ${JSON.stringify(defect === 'untrusted' ? 'untrusted' : 'trusted')}\n`+(defect === 'extra-key' ? 'unexpected = true\n' : ''))
    expect(() => assertMessageProfileSeal(seal, messageProfileSnapshot(profiles, [fixture, other]))).toThrow(/drifted/)
  }))
  it.each([
    ...Object.keys(messageCodexConfiguration).map(key => [`declared ${key}`, text => text.replace(`${key} = ${JSON.stringify(messageCodexConfiguration[key])}`, `${key} = "changed"`)]),
    ...['profile', 'model_provider'].map(key => [key, text => `${key} = "changed"\n`+text]),
    ...['model_providers', 'mcp_servers', 'sandbox_workspace_write', 'features'].map(key => [key, text => text+`[${key}.unexpected]\nenabled = true\n`]),
    ['notice', text => text.replace('acknowledged = true', 'acknowledged = false')],
    ['screen reader state', text => text.replace('screen_reader_detection_done = true', 'screen_reader_detection_done = false')],
    ['hook trust hash', text => text.replace('sha256:original', 'sha256:changed')],
    ['extra hook entry', text => text+'[hooks.state.extra]\ntrusted_hash = "sha256:new"\n'],
    ['top level', text => 'unexpected = true\n'+text],
    ['array order', text => text.replace('ordered = [1, 2]', 'ordered = [2, 1]')],
    ...['2026-11-09', 'nan', 'inf', '9007199254740992'].map(value => [value, text => text.replace('[synthetic]\n', `[synthetic]\nvalue = ${value}\n`)]),
    ['parse error', text => text+'invalid = [\n'],
    ['duplicate key', text => text.replace('acknowledged = true', 'acknowledged = true\nacknowledged = true')]
  ])('binds protected Codex configuration: %s', (_name, change) => bundle(({ profiles, fixture }) => {
    const file = join(profiles, 'codex/config.toml'), before = retainedCodex(fixture)+'[synthetic]\nordered = [1, 2]\n'
    writeFileSync(file, before); const seal = messageProfileSnapshot(profiles, [fixture])
    writeFileSync(file, change(before))
    expect(() => assertMessageProfileSeal(seal, messageProfileSnapshot(profiles, [fixture]))).toThrow(/drifted/)
  }))
  it('fails closed on a legacy raw config entry', () => bundle(({ profiles, fixture }) => {
    const current = messageProfileSnapshot(profiles, [fixture]), legacy = structuredClone(current)
    legacy.static.files['codex/config.toml'] = { sha256: current.codexConfigRawSha256, mode: 0o600 }
    expect(() => assertMessageProfileSeal(legacy, current)).toThrow(/drifted/)
  }))
  const migration = (context, mutate = () => {}) => {
    const { profiles, fixture, other } = context, file = join(profiles, 'codex/config.toml')
    const preimage = retainedCodex(fixture)
    writeFileSync(file, preimage)
    const seal = messageProfileSnapshot(profiles, [fixture, other])
    seal.static.files['codex/config.toml'] = { sha256: seal.codexConfigRawSha256, mode: 0o600 }
    const currentConfig = retainedCodex(fixture, '2')+`[projects.${JSON.stringify(other)}]\ntrust_level = "trusted"\n`
    writeFileSync(file, currentConfig)
    const current = messageProfileSnapshot(profiles, [fixture, other])
    const proof = { preimage, currentConfig, expectedRawSha256: current.codexConfigRawSha256, expectedChanges: [
      { path: ['projects', other], before: null, after: ['table', [['trust_level', ['string', 'trusted']]]] },
      { path: ['tui', 'model_availability_nux', 'gpt-6.1-sol'], before: ['integer', '1'], after: ['integer', '2'] }
    ] }
    mutate({ seal, current, proof, file })
    return { seal, current, proof, file }
  }
  it('migrates only the proven legacy raw seal and preserves the native profile bytes', () => bundle(context => {
    const { seal, current, proof, file } = migration(context), bytes = readFileSync(file)
    const result = messageProfileSealMigration(seal, current, proof)
    expect(() => assertMessageProfileSeal(result.seal, current)).not.toThrow()
    expect(() => assertMessageProfileSeal(seal, current)).toThrow(/drifted/)
    expect(result.receipt.changes).toEqual(proof.expectedChanges)
    expect(readFileSync(file)).toEqual(bytes)
  }))
  it('migrates an unchanged Codex bundle with an empty typed diff', () => bundle(({ profiles, fixture }) => {
    const current = messageProfileSnapshot(profiles, [fixture]), seal = structuredClone(current), text = readFileSync(join(profiles, 'codex/config.toml'), 'utf8')
    seal.static.files['codex/config.toml'] = { sha256: current.codexConfigRawSha256, mode: 0o600 }
    expect(messageProfileSealMigration(seal, current, { preimage: text, currentConfig: text, expectedRawSha256: current.codexConfigRawSha256, expectedChanges: [] }).receipt.changes).toEqual([])
  }))
  it.each(['preimage', 'raw-sha', 'current-bytes', 'protected-digest', 'extra-change', 'missing-change', 'directory', 'other-file', 'optional-file', 'mode', 'legacy-mode', 'onboarding', 'legacy-onboarding', 'already-migrated'])('refuses migration when %s evidence differs', defect => bundle(context => {
    const { seal, current, proof } = migration(context, ({ seal, current, proof }) => {
      if (defect === 'preimage') proof.preimage += ' '
      if (defect === 'raw-sha') proof.expectedRawSha256 = 'wrong'
      if (defect === 'current-bytes') proof.currentConfig += ' '
      if (defect === 'protected-digest') current.static.files['codex/config.toml'].sha256 = 'wrong'
      if (defect === 'extra-change') proof.expectedChanges.push({ path: ['unexpected'] })
      if (defect === 'missing-change') proof.expectedChanges.pop()
      if (defect === 'directory') current.static.homes[0].inode = 'different'
      if (defect === 'other-file') current.static.files['codex/hooks.json'].sha256 = 'different'
      if (defect === 'optional-file') current.static.files['codex/AGENTS.md'] = { sha256: 'new', mode: 0o600 }
      if (defect === 'mode') current.static.files['codex/config.toml'].mode = 0o400
      if (defect === 'legacy-mode') seal.static.files['codex/config.toml'].mode = 0o400
      if (defect === 'onboarding') current.onboarding.hasCompletedOnboarding = false
      if (defect === 'legacy-onboarding') seal.onboarding.hasCompletedOnboarding = false
      if (defect === 'already-migrated') seal.static.files['codex/config.toml'].encoding = 'codex-config-semantic-v1'
    })
    expect(() => messageProfileSealMigration(seal, current, proof)).toThrow(/drifted/)
  }))
})

describe('native startup/restart receipts', () => {
  const fixture = () => {
    const binding = app => ({ app, profiles: { static: { fixture: app }, onboarding: { hasCompletedOnboarding: true } }, qualifiedInputs: { candidateBuildSha256: 'actual-build', driverSha256: 'fixed-driver' } })
    const cycle = (app, number) => ({ version: 2, app, pass: true, startedAt: number*100, shutdownAt: number*100+50,
      applicationIdentity: { pid: number, start_ticks: String(number) }, cleanup: { primary: null, errors: [], stopped: { stopped: true, remaining: [] } },
      evidence: Array.from({ length: 5 }, (_, i) => ({ pass: true, rootStop: 'actual-root-stop', executionMarker: `executed-${i}`, session: `${number}-${i}` })),
      binding: binding(app), profilesAfter: { static: { fixture: app } } })
    return { claude: [cycle('claude', 1), cycle('claude', 2)], codex: [cycle('codex', 3), cycle('codex', 4)] }
  }
  it('admits two independent shutdown/restart cycles bound to the same loaded candidate', () => {
    const receipts = fixture()
    expect(() => assertMessageQualifications(receipts, 'claude', receipts.claude[0].binding)).not.toThrow()
  })
  it('requires fresh qualification after a native update without replacing the retained profile', () => {
    const receipts = fixture(), current = structuredClone(receipts.claude[0].binding)
    current.observedNative = [{ name: 'claude', version: 'updated', fileSha256: 'new-native' }]
    expect(() => assertMessageQualifications(receipts, 'claude', current)).toThrow(/invalidated/)
    for (const cycles of Object.values(receipts)) for (const cycle of cycles) cycle.binding.observedNative = structuredClone(current.observedNative)
    expect(() => assertMessageQualifications(receipts, 'claude', current)).not.toThrow()
  })
  it.each(['single', 'reused', 'overlap', 'cleanup', 'survivor', 'partial', 'execution', 'root-stop', 'static-drift', 'build-drift', 'restart-drift'])('rejects %s proof before any dependent launch', defect => {
    const receipts = fixture(), current = structuredClone(receipts.claude[0].binding)
    if (defect === 'single') receipts.codex.pop()
    if (defect === 'reused') receipts.claude[1] = receipts.claude[0]
    if (defect === 'overlap') receipts.claude[1].startedAt = receipts.claude[0].shutdownAt-1
    if (defect === 'cleanup') receipts.codex[1].cleanup.errors.push({ stage: 'sessions' })
    if (defect === 'survivor') receipts.codex[1].cleanup.stopped.remaining.push({ pid: 99 })
    if (defect === 'partial') receipts.claude[0].evidence.pop()
    if (defect === 'execution') delete receipts.claude[1].evidence[2].executionMarker
    if (defect === 'root-stop') delete receipts.codex[1].evidence[2].rootStop
    if (defect === 'static-drift') receipts.claude[1].profilesAfter.static.fixture = 'changed'
    if (defect === 'build-drift') current.qualifiedInputs.candidateBuildSha256 = 'installed-other-build'
    if (defect === 'restart-drift') receipts.codex[1].binding.qualifiedInputs.driverSha256 = 'changed'
    expect(() => assertMessageQualifications(receipts, 'claude', current)).toThrow()
  })
})

describe('owner setup and independent native evidence', () => {
  it('retains the declared access and model after native setup', () => {
    expect(() => assertMessageSetupConfiguration({ ...messageCodexConfiguration, projects: { synthetic: { trust_level: 'trusted' } }, notice: { acknowledged: true } })).not.toThrow()
  })
  it.each(Object.keys(messageCodexConfiguration))('rejects a changed %s during owner setup', key => {
    expect(() => assertMessageSetupConfiguration({ ...messageCodexConfiguration, [key]: 'changed' })).toThrow(/access or model/)
  })
  it.each(['profile', 'model_provider', 'model_providers', 'mcp_servers'])('rejects an undeclared %s override', key => {
    expect(() => assertMessageSetupConfiguration({ ...messageCodexConfiguration, [key]: { unexpected: true } })).toThrow()
  })
  it('retains the failed child proof while collecting independent cases without making acceptance pass', () => {
    const verdicts = {}
    recordMessageVerdict(verdicts, 'child route', { pass: false, status: 'UNVERIFIED' }, { independentMayContinue: true })
    recordMessageVerdict(verdicts, 'depth', { pass: true })
    expect(Object.keys(verdicts)).toEqual(['child route', 'depth'])
    expect(Object.values(verdicts).every(value => value.pass)).toBe(false)
    expect(() => recordMessageVerdict(verdicts, 'depth control', { pass: false })).toThrow(/dependent scenarios/)
  })
})

// Captured synthetic native interruption, 20261109T141012; only the account banner is omitted.
const activityCapture = {
  "beforeEscape": [
    "",
    " ▐▛███▛█   Claude Code v2.1.319",
    "<native account banner omitted>",
    " ▝▝   ▝▝   /…/code/BMN/.claude/worktrees/epic-113/.dev-auto/evidence/113.7/method4/claude-bundle/fixtures/project",
    "",
    "  Get to finished work sooner with Opus 5.5. Switch anytime with /model.",
    "  1 more notice hidden",
    "",
    "❯ This is a check of a terminal tool with made-up text. Use your Bash tool, one command per tool call, in this order.",
    "  Run: echo step-one. Then answer with the single word done.",
    "",
    "  Ran 1 shell command",
    "",
    "● done",
    "",
    "✻ Cogitated for 3s · done 4:10 PM",
    "",
    "❯ This is a synthetic terminal check. Run exactly this command in one foreground shell tool call and wait for completion,",
    "  then answer done: python3 '/home/oleksandr/code/BMN/.claude/worktrees/epic-113/.dev-auto/evidence/113.7/method4/claude",
    "  -bundle/fixtures/project/activity-20261109T141012-method4-early-corrected/foreground.py'. Do not use Plan mode or run",
    "  it in background.",
    "",
    "● Running foreground.py script in foreground and waiting",
    "  ⎿  $ python3 '/home/oleksandr/code/BMN/.claude/worktrees/epic-113/.dev-auto/evidence/113.7/method4/claude-bundle/fixture",
    "     s/project/activity-20261109T141012-method4-early-corrected/foreground.py'",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "✻ Pouncing… (3s · ↓ 171 tokens)",
    "  ⎿  Tip: Use Plan Mode to prepare for a complex request before making changes. Press shift+tab twice to enable.",
    "",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "❯",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  ⏵⏵ don't ask on (shift+tab to cycle) · esc to interrupt"
  ],
  "returnedComposer": [
    "",
    " ▐▛███▛█   Claude Code v2.1.319",
    "<native account banner omitted>",
    " ▝▝   ▝▝   /…/code/BMN/.claude/worktrees/epic-113/.dev-auto/evidence/113.7/method4/claude-bundle/fixtures/project",
    "",
    "  Get to finished work sooner with Opus 5.5. Switch anytime with /model.",
    "  1 more notice hidden",
    "",
    "❯ This is a check of a terminal tool with made-up text. Use your Bash tool, one command per tool call, in this order.",
    "  Run: echo step-one. Then answer with the single word done.",
    "",
    "  Ran 1 shell command",
    "",
    "● done",
    "",
    "✻ Cogitated for 3s · done 4:10 PM",
    "",
    "❯ This is a synthetic terminal check. Run exactly this command in one foreground shell tool call and wait for completion,",
    "  then answer done: python3 '/home/oleksandr/code/BMN/.claude/worktrees/epic-113/.dev-auto/evidence/113.7/method4/claude",
    "  -bundle/fixtures/project/activity-20261109T141012-method4-early-corrected/foreground.py'. Do not use Plan mode or run",
    "  it in background.",
    "",
    "  Ran 1 shell command",
    "  ⎿  Interrupted · What should Claude do instead?",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "❯",
    "──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────",
    "  ⏵⏵ don't ask on (shift+tab to cycle)"
  ]
}

describe('activity composer replay', () => {
  const returned = activityCapture.returnedComposer
  it('recognizes the real returned composer despite earlier prompt lines in history', () => expect(messageActivityComposer('claude', returned)).toBe(true))
  it.each(['claude', 'codex'])('retains the qualified %s composer form', app => {
    expect(messageActivityComposer(app, capturedStartup.qualifications[app].sequence.at(-1).screen)).toBe(true)
  })
  it.each(['claude', 'codex'])('rejects the captured %s trust dialog', app => {
    expect(messageActivityComposer(app, capturedStartup.apps[app].screen)).toBe(false)
  })
  it('leaves strict startup classification unchanged on a mid-conversation screen', () => {
    expect(classifyMessageStartup('claude', returned, '/synthetic', { appSeen: true })).toEqual({ state: 'loading', detail: 'more than one prompt line' })
  })
  it.each(['working', 'no-footer', 'no-lower-rule', 'permission', 'numbered', 'theme', 'security', 'codex-working'])('rejects %s as a returned composer', defect => {
    let lines = [...returned], app = 'claude'
    if (defect === 'working') lines = activityCapture.beforeEscape
    if (defect === 'no-footer') lines = returned.slice(0, -1)
    if (defect === 'no-lower-rule') lines.splice(lines.findLastIndex(line => /^─{20,}$/u.test(line)), 1)
    if (defect === 'permission') lines.push('  Allow once?')
    if (defect === 'numbered') lines.push('❯ 1. Yes')
    if (defect === 'theme') lines = theme
    if (defect === 'security') lines = security
    if (defect === 'codex-working') { app = 'codex'; lines = ['• Working (3s • esc to interrupt)', ...capturedStartup.qualifications.codex.sequence.at(-1).screen] }
    expect(messageActivityComposer(app, lines)).toBe(false)
  })
})

describe('native interruption evidence', () => {
  it('uses the real terminal byte channel for Escape, without bracketed paste', async () => {
    const sent = [], startup = { liveSessions: [{ sessionId: 'other', incarnationId: 'same', attachmentId: 'other-view' }, { sessionId: 'receiver', incarnationId: 'same', attachmentId: 'receiver-view' }] }
    let unsubscribed = false
    const bridge = { onStartup: callback => { queueMicrotask(() => callback(startup)); return () => { unsubscribed = true } }, sendTerminalInput: (attachment, bytes) => sent.push({ attachment, bytes: [...bytes] }) }
    expect(await messageNativeEscape({ bridge, sessionId: 'receiver', incarnationId: 'same' })).toMatchObject({ attachmentId: 'receiver-view', bytes: [27] })
    expect(sent).toEqual([{ attachment: 'receiver-view', bytes: [27] }]); expect(unsubscribed).toBe(true)
    await expect(messageNativeEscape({ bridge, sessionId: 'receiver', incarnationId: 'replaced' })).rejects.toThrow(/incarnation/)
    expect(sent).toHaveLength(1)
  })
  it('checks supported product recorder events instead of Claude Bash PreToolUse', () => {
    const options = { incarnationId: 'same', since: 1000 }
    const events = [{ incarnationId: 'same', event: 'PostToolUse', observedAt: new Date(1100).toISOString() }, { incarnationId: 'same', event: 'Stop', observedAt: new Date(1200).toISOString() }]
    expect(messageRecorderHealthy(events, options)).toBe(true)
    expect(messageRecorderHealthy(events, { ...options, incarnationId: 'replaced' })).toBe(false)
    expect(messageRecorderHealthy(events, { ...options, since: 1300 })).toBe(false)
    expect(messageRecorderHealthy(events.slice(0, 1), options)).toBe(false)
    expect(messageRecorderHealthy([{ incarnationId: 'same', event: 'PreToolUse', observedAt: new Date(1100).toISOString() }], options)).toBe(false)
  })
  const fixture = () => ({ app: 'claude', escapeAt: 1000, completedAt: 61500, lastOutputAt: 2000, incarnationId: 'same-native-run', executionProved: true,
    working: [true, true, true, true], recorder: { before: true, after: true }, probeEventsAfter: [], productEventsAfter: [],
    firstResting: { sidebar: 3600, now: 3600, owner: 3650, agent: 3900 },
    samples: Array.from({ length: 62 }, (_, i) => ({ at: 500+i*1000, nativeAlive: true, incarnationId: 'same-native-run', composer: i > 1, lastOutputAt: 2000 })) })
  it('admits the actual no-event interruption with all four views inside the same bound', () => expect(messageActivityVerdict(fixture()).pass).toBe(true))
  it.each(['no-execution', 'not-working', 'missing-first-eight', 'short', 'sampling-gap', 'dead', 'replaced', 'no-composer', 'output-after-eight', 'recorder', 'late-agent', 'native-event', 'product-event'])('rejects %s evidence', defect => {
    const evidence = fixture()
    if (defect === 'no-execution') evidence.executionProved = false
    if (defect === 'not-working') evidence.working[3] = false
    if (defect === 'missing-first-eight') evidence.samples = evidence.samples.slice(9)
    if (defect === 'short') evidence.completedAt = 10000
    if (defect === 'sampling-gap') evidence.samples.splice(1, 5)
    if (defect === 'dead') evidence.samples[3].nativeAlive = false
    if (defect === 'replaced') evidence.samples[3].incarnationId = 'other'
    if (defect === 'no-composer') evidence.samples[50].composer = false
    if (defect === 'output-after-eight') evidence.lastOutputAt = 30000
    if (defect === 'recorder') evidence.recorder.after = false
    if (defect === 'late-agent') evidence.firstResting.agent = 4001
    if (defect === 'native-event') evidence.probeEventsAfter.push({ eventName: 'Stop' })
    if (defect === 'product-event') evidence.productEventsAfter.push({ event: 'Interrupt' })
    expect(messageActivityVerdict(evidence).pass).toBe(false)
  })
  it('records Codex Interrupt as its actual route without claiming a Codex no-event proof', () => {
    const evidence = fixture(); evidence.app = 'codex'; evidence.probeEventsAfter.push({ eventName: 'Interrupt' })
    expect(messageActivityVerdict(evidence)).toMatchObject({ pass: true, noEventCondition: false, route: ['Interrupt'] })
  })
})

describe('command-scoped socket guidance', () => {
  it.each(['sender', 'receiver'])('requests no escalation for echo or Python commands in a %s prompt', audience => {
    expect(messageSocketGuidance('codex', ['echo startup-qualified', 'python3 -c "print(1)"'], audience)).toBe('')
    expect(messageSocketGuidance('codex', ['echo bmn tell status'], audience)).toBe('')
  })
  it('preserves the exact sender and receiver socket instructions', () => {
    const commands = ['echo before', 'bmn tell status', 'bmn tell receiver --text-file synthetic']
    expect(messageSocketGuidance('codex', commands, 'sender')).toBe('For each bmn socket call request sandbox_permissions=require_escalated on the first attempt, justification: synthetic BMN socket check. Keep auto_review and honor any refusal. ')
    expect(messageSocketGuidance('codex', commands, 'receiver')).toBe(' For every bmn command request sandbox_permissions=require_escalated on its first attempt, justification: synthetic BMN socket check. Keep the approval reviewer; if refused, report refusal and stop.')
    expect(messageSocketGuidance('claude', commands, 'sender')).toBe('')
    expect(messageSocketGuidance('claude', commands, 'receiver')).toBe('')
  })
})

describe('root-bounded process identities across PID namespaces', () => {
  const fixture = () => {
    const proc = mkdtempSync(join(tmpdir(), 'bmn-process-identity-'))
    const root = { pid: 100, start_ticks: '10' }, marker = { pid: 2, start_ticks: '20' }, argv = ['python3', '-c', 'synthetic program']
    const row = (pid, { ppid = 100, ticks = '20', state = 'S', comm = 'python3', ns = [pid, 2], uid = 1000, args = argv } = {}) => {
      const directory = join(proc, String(pid)); mkdirSync(directory, { recursive: true })
      const fields = Array(22).fill('0'); fields[0] = state; fields[1] = String(ppid); fields[19] = ticks
      writeFileSync(join(directory, 'stat'), `${pid} (${comm}) ${fields.join(' ')}\n`)
      writeFileSync(join(directory, 'status'), `NSpid:\t${ns.join('\t')}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`)
      writeFileSync(join(directory, 'cmdline'), args.join('\0')+'\0')
    }
    row(100, { ppid: 1, ticks: '10', comm: 'electron', args: ['electron'] }); row(200)
    return { proc, root, marker, argv, uid: 1000, row }
  }
  it.each(['namespace', 'host'])('resolves one exact %s identity inside the pinned root', mode => {
    const f = fixture()
    try {
      if (mode === 'host') { f.marker.pid = 200; f.row(200, { ns: [200] }) }
      expect(messageProcessIdentity(f, f.proc)).toMatchObject({ identity: { pid: 200, start_ticks: '20' }, reason: null })
    } finally { rmSync(f.proc, { recursive: true, force: true }) }
  })
  it.each(['foreign-root', 'wrong-inner-pid', 'same-ticks-other-pid', 'reused-ticks-other-argv', 'wrong-program', 'missing-nspid', 'missing-status', 'missing-cmdline', 'zombie', 'uid-mismatch', 'effective-uid-mismatch', 'wrong-host-nspid', 'ambiguous', 'root-changed', 'root-gone'])('fails closed for %s', defect => {
    const f = fixture(), directory = join(f.proc, '200')
    try {
      if (defect === 'foreign-root') f.row(200, { ppid: 999 })
      if (defect === 'wrong-inner-pid') f.marker.pid = 3
      if (defect === 'same-ticks-other-pid') f.row(200, { ns: [200, 3] })
      if (defect === 'reused-ticks-other-argv') f.row(200, { args: ['python3', '-c', 'other program'] })
      if (defect === 'wrong-program') f.row(200, { comm: 'other' })
      if (defect === 'missing-nspid') writeFileSync(join(directory, 'status'), 'Uid:\t1000\t1000\t1000\t1000\n')
      if (defect === 'missing-status') rmSync(join(directory, 'status'))
      if (defect === 'missing-cmdline') rmSync(join(directory, 'cmdline'))
      if (defect === 'zombie') f.row(200, { state: 'Z' })
      if (defect === 'uid-mismatch') f.row(200, { uid: 1001 })
      if (defect === 'effective-uid-mismatch') writeFileSync(join(directory, 'status'), 'NSpid:\t200\t2\nUid:\t1000\t1001\t1000\t1000\n')
      if (defect === 'wrong-host-nspid') f.row(200, { ns: [201, 2] })
      if (defect === 'ambiguous') f.row(201)
      if (defect === 'root-changed') f.row(100, { ticks: '11', ppid: 1 })
      if (defect === 'root-gone') rmSync(join(f.proc, '100'), { recursive: true })
      const result = messageProcessIdentity(f, f.proc)
      expect(result.identity).toBe(null); expect(result.reason).toBeTruthy()
    } finally { rmSync(f.proc, { recursive: true, force: true }) }
  })
  it('rechecks the root after candidate reads rather than trusting its initial identity', () => {
    const f = fixture(); let reads = 0
    Object.defineProperty(f.marker, 'start_ticks', { get: () => {
      if (++reads === 2) f.row(100, { ticks: '11', ppid: 1 })
      return '20'
    } })
    try { expect(messageProcessIdentity(f, f.proc)).toEqual({ identity: null, reason: 'Owned root changed during resolution' }) }
    finally { rmSync(f.proc, { recursive: true, force: true }) }
  })
})

describe('actual bounded native fixture commands', () => {
  const sleep = ms => new Promise(done => setTimeout(done, ms))
  const wait = async predicate => { const end = Date.now()+3000; do { const result = predicate(); if (result) return result; await sleep(40) } while (Date.now()<end); throw new Error('Fixture command did not execute') }
  const start = (command, args) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const identities = processTree(child.pid), result = { child, identities, stdout: '', stderr: '' }
    child.stdout.on('data', data => { result.stdout += data }); child.stderr.on('data', data => { result.stderr += data })
    result.closed = new Promise(done => child.once('close', (code, signal) => done({ code, signal })))
    return result
  }
  const run = code => start('python3', ['-c', code])
  const stop = async actor => {
    if (!actor) return
    const result = await stopTree(actor.identities, { graceMs: 100, afterKillMs: 1000, wait: sleep })
    expect(result.remaining).toEqual([])
    await actor.closed
  }
  it('executes ordered independent now reads and stops the bounded sampler on its stop file', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bmn-now-sampler-')), output = join(directory, "quoted ' output"), stopFile = join(directory, 'stop'), stub = join(directory, 'now-stub.mjs')
    writeFileSync(stub, 'process.stdout.write(JSON.stringify({at: new Date().toISOString(), audience: "agent"})+"\\n")')
    let actor
    try {
      actor = start('/bin/bash', ['-c', messageNowSampler({ argv: [process.execPath, stub], directory: output, stop: stopFile, seconds: 3 })])
      await wait(() => existsSync(output) && readdirSync(output).filter(name => /^\d+\.json$/u.test(name)).length >= 2)
      writeFileSync(stopFile, 'stop')
      expect(await actor.closed).toEqual({ code: 0, signal: null })
      const names = readdirSync(output).filter(name => /^\d+\.json$/u.test(name)).sort((a, b) => parseInt(a)-parseInt(b))
      const reports = names.map(name => JSON.parse(readFileSync(join(output, name), 'utf8')))
      expect(names.length).toBeGreaterThanOrEqual(2)
      expect(names.map(name => parseInt(name))).toEqual(Array.from({ length: names.length }, (_, i) => i+1))
      expect(reports.every((row, i) => row.audience === 'agent' && (!i || Date.parse(row.at) >= Date.parse(reports[i-1].at)))).toBe(true)
      expect(readFileSync(join(output, 'exit'), 'utf8').trim()).toBe('0')
      expect(actor.stderr).toBe('')
    } finally { await stop(actor); rmSync(directory, { recursive: true, force: true }) }
  })
  it('waits for the real parent boundary, then executes and releases the actual foreground child latch', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bmn-child-command-')), fixture = messageChildFixture(directory)
    let bootstrap, foreground
    try {
      bootstrap = run(fixture.bootstrap)
      await sleep(100)
      expect(bootstrap.child.exitCode).toBe(null); expect(existsSync(fixture.pulse)).toBe(false)
      writeFileSync(fixture.parentReady, 'actual parent boundary')
      expect(await bootstrap.closed).toEqual({ code: 0, signal: null })
      foreground = run(fixture.foreground)
      const pulse = await wait(() => existsSync(fixture.pulse) && JSON.parse(readFileSync(fixture.pulse, 'utf8')))
      expect(pulse.pid).toBe(foreground.child.pid); expect(Date.now()-pulse.at).toBeLessThan(1000)
      expect(pulse.start_ticks).toBe(processTree(foreground.child.pid)[0].start_ticks)
      expect(foreground.child.exitCode).toBe(null)
      writeFileSync(fixture.release, 'release')
      expect(await foreground.closed).toEqual({ code: 0, signal: null })
      expect(foreground.stdout.trim()).toBe('child-latch-released'); expect(foreground.stderr).toBe('')
    } finally { await stop(bootstrap); await stop(foreground); rmSync(directory, { recursive: true, force: true }) }
  })
  it('resolves the actual bwrap child while the original inner-PID lookup fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bmn-namespace-command-')), fixture = messageChildFixture(directory)
    const root = processTree(process.pid)[0], argv = ['python3', '-c', fixture.foreground]
    let actor
    try {
      actor = start('bwrap', ['--unshare-user', '--unshare-pid', '--unshare-net', '--die-with-parent', '--ro-bind', '/', '/', '--bind', directory, directory, '--proc', '/proc', '--chdir', directory, ...argv])
      const marker = await wait(() => existsSync(fixture.pulse) && JSON.parse(readFileSync(fixture.pulse, 'utf8')))
      expect(marker.pid).toBe(2)
      expect(processTree(marker.pid).some(row => row.start_ticks === marker.start_ticks)).toBe(false)
      const resolved = messageProcessIdentity({ root, marker, argv })
      expect(resolved.reason).toBe(null); expect(resolved.identity.pid).not.toBe(marker.pid)
      expect(processTree(marker.pid)[0]?.pid).not.toBe(resolved.identity.pid)
      expect(resolved.identity.start_ticks).toBe(marker.start_ticks)
      writeFileSync(fixture.release, 'release')
      expect(await actor.closed).toEqual({ code: 0, signal: null }); expect(actor.stderr).toBe('')
    } finally { await stop(actor); rmSync(directory, { recursive: true, force: true }) }
  })
  it('executes the night driver marker before interruption with its real process identity', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bmn-night-command-')), marker = join(directory, 'execution.json')
    const driver = readFileSync(new URL('../test/away-wake-live.mjs', import.meta.url), 'utf8')
    const template = driver.match(/writeFileSync\(program, (`import json,os,time\\n[^`]+`), \{ mode: 0o600 \}\)/u)
    expect(template).not.toBe(null)
    const source = runInNewContext(template[1], { marker })
    let actor
    try {
      actor = run(source)
      const execution = await wait(() => existsSync(marker) && JSON.parse(readFileSync(marker, 'utf8')))
      expect(execution.pid).toBe(actor.child.pid)
      expect(processTree(execution.pid)[0].start_ticks).toBe(execution.start_ticks)
      expect(Date.now()-execution.at).toBeLessThan(1000)
      expect(actor.child.exitCode).toBe(null); expect(actor.stderr).toBe('')
    } finally { await stop(actor); rmSync(directory, { recursive: true, force: true }) }
  })
  it('proves execution with real foreground pulses, independent of a PreToolUse record', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'bmn-activity-command-')), fixture = messageActivityFixture(directory)
    let actor
    try {
      actor = run(fixture.source)
      const pulse = await wait(() => {
        if (!existsSync(fixture.execution)) return null
        const row = JSON.parse(readFileSync(fixture.execution, 'utf8')); return row.pulse >= 2 && row
      })
      expect(pulse.pid).toBe(actor.child.pid); expect(actor.child.exitCode).toBe(null)
      expect(actor.stdout).toContain('NATIVE_ACTIVITY_PULSE_2'); expect(actor.stderr).toBe('')
    } finally { await stop(actor); rmSync(directory, { recursive: true, force: true }) }
  })
})

describe('retained hook queries keep closed evidence before the approval guard (113.7 method 6)', () => {
  const SECRET = 'node /private/owner/path/probe-hook.mjs --token leak-me'
  const entries = ['SessionStart', 'Stop'].map((event, index) => ({ event, key: `/h/hooks.json:${event}:0:${index}`, command: `${SECRET} ${event}` }))
  const hook = (entry, change = {}) => ({ key: entry.key, command: entry.command, enabled: true, trustStatus: 'trusted', ...change })
  const read = (hooks, extra = {}) => ({ state: 'read', hooks, warnings: 0, errors: 0, ...extra })
  const run = async ({ answers, finishActor = async actor => { actor.exited = true; actor.stop = { killed: [], remaining: [] } }, save, ask }) => {
    const saved = [], order = [], asked = []
    let sequence = 0, clock = 1000
    const promise = collectMessageHookQueries({ folders: ['/fixture/a', '/fixture/b'].slice(0, answers.length), entries, phase: 'bind:claude', nextInvocation: () => ++sequence, approvalFrom, now: () => clock += 5,
      ask: ask ?? (async options => { asked.push({ cwd: options.cwd, limitMs: options.limitMs }); options.start('codex', ['app-server'], {}); order.push('ask'); return answers[asked.length - 1] }),
      startActor: () => ({ child: { pid: 41, exitCode: null, signalCode: 'SIGKILL' }, identities: [{ pid: 41, start_ticks: '77' }], row: { id: 'row' }, exited: false }),
      finishActor: async actor => { order.push('cleanup'); await finishActor(actor) },
      save: save ?? (projection => { order.push('save'); saved.push(projection) }) })
    return { promise, saved, order, asked }
  }
  it('keeps the approved control unchanged: one ordered query per folder at the fixed deadline', async () => {
    const { promise, saved, order, asked } = await run({ answers: [read(entries.map(entry => hook(entry))), read(entries.map(entry => hook(entry)))] })
    const results = await promise
    expect(results.map(row => row.approval.state)).toEqual(['approved', 'approved'])
    expect(results[0].statuses.map(row => [row.enabled, row.trustStatus])).toEqual([[true, 'trusted'], [true, 'trusted']])
    expect(asked).toEqual([{ cwd: '/fixture/a', limitMs: 10000 }, { cwd: '/fixture/b', limitMs: 10000 }])
    expect(order).toEqual(['ask', 'cleanup', 'save', 'ask', 'cleanup', 'save'])
    expect(saved.map(row => [row.invocation, row.phase, row.fixture.index, row.answerState, row.approvalState, row.reason])).toEqual([[1, 'bind:claude', 0, 'read', 'approved', null], [2, 'bind:claude', 1, 'read', 'approved', null]])
    expect(saved[0].actors).toEqual([{ pid: 41, startTicks: '77', exited: true, exitCode: null, signal: 'SIGKILL', killed: 0, remaining: 0 }])
    expect(saved[0].timing.startedAt < saved[0].timing.answeredAt && saved[0].timing.answeredAt < saved[0].timing.cleanedAt).toBe(true)
  })
  it.each([
    ['timeout', { state: 'unread', reason: 'no answer in 10 s' }, 'unverified', 'timeout'],
    ['ended', { state: 'unread', reason: 'Codex ended without answering' }, 'unverified', 'ended'],
    ['unreadable', { state: 'unread', reason: 'an answer BMN cannot read' }, 'unverified', 'unreadable'],
    ['initialize', { state: 'unread', reason: 'Codex refused the question' }, 'unverified', 'initialize-rejected'],
    ['spawn', { state: 'unread', reason: 'ENOENT' }, 'unverified', 'spawn-error'],
    ['free text', { state: 'unread', reason: `failed at ${SECRET}` }, 'unverified', 'unknown'],
    ['settings', read(entries.map(entry => hook(entry)), { errors: 2 }), 'unverified', 'settings-errors'],
    ['missing', read([hook(entries[0])], { warnings: 1 }), 'unverified', 'entry-missing'],
    ['mismatch', read([hook(entries[0]), hook(entries[1], { command: 'other' })]), 'unverified', 'command-mismatch'],
    ['strange trust', read([hook(entries[0]), hook(entries[1], { trustStatus: `odd ${SECRET}` })]), 'unverified', 'entry-unknown'],
    ['untrusted', read([hook(entries[0]), hook(entries[1], { trustStatus: 'untrusted' })]), 'not-approved', 'entries-off'],
    ['modified', read([hook(entries[0], { trustStatus: 'modified' }), hook(entries[1])]), 'not-approved', 'entries-off'],
    ['disabled', read([hook(entries[0], { enabled: false }), hook(entries[1])]), 'not-approved', 'entries-off']
  ])('tells %s apart and keeps no raw text', async (_name, answer, state, reason) => {
    const { promise, saved } = await run({ answers: [answer] })
    const results = await promise
    expect(results[0].approval.state).toBe(state)
    expect([saved[0].approvalState, saved[0].reason]).toEqual([state, reason])
    expect(saved[0].entries).toHaveLength(2)
    for (const row of saved[0].entries) expect(Object.keys(row)).toEqual(['event', 'present', 'enabled', 'trustStatus', 'commandMatches'])
    expect(JSON.stringify(saved)).not.toMatch(/leak-me|private\/owner|probe-hook/)
  })
  it('keeps the query outcome through a cleanup failure, then fails on the cleanup', async () => {
    const { promise, saved, order } = await run({ answers: [{ state: 'unread', reason: 'no answer in 10 s' }, read([])],
      finishActor: async actor => { actor.stop = { killed: [], remaining: [{ pid: 41 }] }; throw new Error('Local hook query process exit is unverified') } })
    await expect(promise).rejects.toThrow('Local hook query process exit is unverified')
    expect(order).toEqual(['ask', 'cleanup', 'save'])
    expect([saved[0].reason, saved[0].actors[0].remaining, saved[0].actors[0].exited]).toEqual(['timeout', 1, false])
  })
  it('stops before the next query when the evidence cannot be written, after cleanup ran', async () => {
    const order = []
    const { promise, asked } = await run({ answers: [read(entries.map(entry => hook(entry))), read([])], save: () => { order.push('save'); throw new Error('disk full') },
      finishActor: async actor => { order.push('cleanup'); actor.exited = true; actor.stop = { killed: [], remaining: [] } } })
    await expect(promise).rejects.toThrow('disk full')
    expect(order).toEqual(['cleanup', 'save'])
    expect(asked).toHaveLength(1)
  })
  it.each([
    ['handoff-bound', new Error('Handoff inventory would exceed recovery bound')],
    ['handoff-heading', new Error('Missing handoff Started inventory')],
    ['handoff-check', Object.assign(new Error(`Command failed: python3 ${SECRET}`), { status: 1 })],
    ['unknown', new Error(`other ${SECRET}`)]
  ])('reports a failed inventory registration (%s) as the harness error, never as an approval answer', async (code, error) => {
    const cleaned = []
    const saved = [], good = read(entries.map(entry => hook(entry)))
    const promise = collectMessageHookQueries({ folders: ['/fixture/a', '/fixture/b'], entries, phase: 'bind:claude', nextInvocation: () => 3, approvalFrom,
      ask: async options => { options.start('codex', ['app-server'], {}); return good },
      startActor: () => ({ child: { pid: 41, exitCode: null, signalCode: null }, identities: [{ pid: 41, start_ticks: '77' }], row: null, exited: false, registrationError: error }),
      finishActor: async actor => { cleaned.push(actor.child.pid); actor.exited = true; actor.stop = { killed: [{ pid: 41 }], remaining: [] } },
      save: projection => saved.push(projection) })
    await expect(promise).rejects.toThrow(`Hook query inventory registration failed (${code}); no approval answer is implied`)
    expect(cleaned).toEqual([41])
    expect(saved).toHaveLength(1)
    expect([saved[0].registration, saved[0].approvalState, saved[0].actors[0].killed]).toEqual([code, 'approved', 1])
    expect(JSON.stringify(saved)).not.toMatch(/leak-me|private\/owner/)
  })
  it('names a start callback that throws, the 2026-11-09 shape, apart from an unread answer', async () => {
    const saved = []
    const promise = collectMessageHookQueries({ folders: ['/fixture/a'], entries, phase: 'bind:claude', nextInvocation: () => 3, approvalFrom,
      // askCodexHooks catches a throwing start and answers unread with the error text (codex-hook-approval.mjs).
      ask: async options => { try { options.start('codex', ['app-server'], {}) } catch (error) { return { state: 'unread', reason: error.message } } return read([]) },
      startActor: () => { throw new Error('Handoff inventory would exceed recovery bound') }, finishActor: async () => {}, save: projection => saved.push(projection) })
    await expect(promise).rejects.toThrow('Hook query process could not be started by the harness')
    expect([saved[0].registration, saved[0].answerState, saved[0].reason]).toEqual(['start-failed', 'unread', 'unknown'])
  })
  it('records an unknown outcome when the query itself throws, and rethrows it', async () => {
    const { promise, saved } = await run({ answers: [null], ask: async () => { throw new Error(`spawn broke ${SECRET}`) } })
    await expect(promise).rejects.toThrow('spawn broke')
    expect([saved[0].answerState, saved[0].approvalState, saved[0].reason, saved[0].actors]).toEqual(['unknown', 'unverified', 'unknown', []])
    expect(JSON.stringify(saved)).not.toMatch(/leak-me/)
  })
})
