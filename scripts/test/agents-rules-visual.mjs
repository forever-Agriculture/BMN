/* global document, window */
// MODULE: agents-rules-visual.mjs - Epic 60.5/60.6: Preferences → Agents and Rules on a synthetic roster and master in a temporary HOME
// HOME points at a scratch folder holding the synthetic roster (the unit-test fixture), a synthetic rules master and stub
// harness files; PATH holds only stub claude/codex binaries and the system folders, so no step reaches a provider or the
// owner's own rules. Screenshots land in .dev-auto/evidence/epic-60/shots/ (ignored).
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const evidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-60/shots')
const electronBinary = createRequire(join(appDirectory, 'package.json'))('electron')
const EXAMPLE = readFileSync(join(appDirectory, 'src/utility/test-fixtures/agents/roster-example.md'), 'utf8')
const MASTER = `# Global rules

Plain rule for everyone.

<!-- bmn:shareable -->
## How to talk
Answer first, plainly.
<!-- /bmn:shareable -->

## Team
<!-- bmn:team -->

<!-- bmn:harness claude codex -->
PRIVATE-SENTINEL: a rule only High routes may see.
<!-- /bmn:harness -->
`
const SIZES = [[800, 500], [1000, 700], [1280, 900]]
const phase = (label) => console.error(`[BMN agents/rules visual] ${label}`)
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms))
const sha = (text) => createHash('sha256').update(text).digest('hex')

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay = originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
  ? join(originalRuntime, originalWaylandDisplay)
  : originalWaylandDisplay

async function until(read, label, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (value) return value
    if (Date.now() > end) throw new Error(`never saw ${label}`)
    await sleep(100)
  }
}

mkdirSync(evidenceDirectory, { recursive: true })
await withTemporaryRoot(temporaryRootContracts.electronDevelopment, async ({ root, roots }) => {
  const home = join(root, 'home')
  const agentsDir = join(home, '.config/bmn/agents')
  const rosterFile = join(agentsDir, 'roster.md')
  const masterFile = join(agentsDir, 'global-rules.md')
  const stateDir = join(agentsDir, 'state')
  const stubs = join(root, 'stubs')
  mkdirSync(agentsDir, { recursive: true })
  mkdirSync(stubs)
  writeFileSync(rosterFile, EXAMPLE)
  writeFileSync(masterFile, MASTER)
  const stub = (name, body) => {
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(stubs, name), 0o755)
  }
  stub('codex', 'echo "codex-cli 0.161.0"')
  // A probe asks the agent which rules it read; this stub has read nothing, so the probe fails in words.
  stub('claude', 'case "$1" in --version) echo "2.1.295 (Claude Code)";; *) cat > /dev/null; echo "I cannot tell";; esac')
  // Claude's target is a link to a file kept elsewhere; Codex's is hand-written; OpenCode and Cursor have none.
  mkdirSync(join(home, '.claude'))
  mkdirSync(join(home, 'dotfiles'))
  writeFileSync(join(home, 'dotfiles/CLAUDE.md'), '# hand-kept rules\n')
  symlinkSync(join(home, 'dotfiles/CLAUDE.md'), join(home, '.claude/CLAUDE.md'))
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex/AGENTS.md'), '# written by hand\n')
  const work = join(root, 'projects')
  mkdirSync(join(work, 'app'), { recursive: true })

  const rosterHash = () => sha(readFileSync(rosterFile, 'utf8'))
  const current = () => (existsSync(join(stateDir, 'current')) ? JSON.parse(readFileSync(join(stateDir, 'current'), 'utf8')) : null)
  const generation = (number) => JSON.parse(readFileSync(join(stateDir, 'generations', `${String(number).padStart(6, '0')}.json`), 'utf8'))
  const stateHash = () => (existsSync(join(stateDir, 'current')) ? sha(readFileSync(join(stateDir, 'current'), 'utf8')) : null)

  const application = await electron.launch({
    executablePath: electronBinary,
    args: [appDirectory, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: home,
      PATH: `${stubs}:/usr/bin:/bin`,
      XDG_CONFIG_HOME: roots.config,
      XDG_DATA_HOME: roots.data,
      XDG_STATE_HOME: roots.state,
      XDG_CACHE_HOME: roots.cache,
      XDG_RUNTIME_DIR: roots.runtime,
      BMN_CONFIG_HOME: join(roots.config, 'bmn'),
      BMN_DATA_HOME: join(roots.data, 'bmn'),
      BMN_STATE_HOME: join(roots.state, 'bmn'),
      BMN_RUNTIME_HOME: join(roots.runtime, 'bmn'),
      BMN_LAUNCH_CWD: root,
      ...(waylandDisplay ? { WAYLAND_DISPLAY: waylandDisplay } : {})
    }
  })
  const result = { checks: [] }
  const passed = (check) => { result.checks.push(check); phase(`PASS ${check}`) }
  try {
    const page = await application.firstWindow()
    page.setDefaultTimeout(20_000)
    await page.waitForSelector('.session-row')
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show())
    await page.evaluate(async (cwd) => window.aiTerminal.createWorkspace({ name: 'Synthetic app', defaultCwd: cwd }), join(work, 'app'))
    const resize = (width, height) => application.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height])
    await resize(1280, 900)
    const shot = async (name) => {
      const png = await application.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64'))
      writeFileSync(join(evidenceDirectory, name), Buffer.from(png, 'base64'))
    }
    const openPreferences = async () => {
      if (await page.locator('.preferences-dialog').count()) return
      await page.locator('.preferences-button').click()
      await page.waitForSelector('.preferences-dialog')
    }
    await openPreferences()
    const agents = page.locator('.agents-section')
    const rules = page.locator('.rules-section')
    const band = agents.locator('.roster-confirm')
    const saveAndApprove = async (label = 'Save & approve') => {
      const button = band.getByRole('button', { name: label })
      await until(() => button.isEnabled(), `${label} enabled`)
      await button.click()
      await band.waitFor({ state: 'detached' })
    }
    const agentRow = (name) => agents.locator('.agent-row', { has: page.locator('.agent-name', { hasText: new RegExp(`^${name}$`) }) })

    phase('60.5 AC4: nothing approved yet; the section says so and offers the first approval')
    await agents.getByText('Not approved yet').waitFor()
    await agents.getByText('Nothing takes effect until the first approval').waitFor()
    assert.equal(current(), null)
    await agents.getByRole('heading', { name: 'Agents' }).scrollIntoViewIfNeeded()
    await shot('agents-unapproved-1280.png')

    phase('first approval with one proposed agent activated')
    const sonnet = agentRow('Sonnet')
    assert.equal(await sonnet.locator('xpath=ancestor::ul').getAttribute('aria-label'), 'Agents awaiting approval')
    await sonnet.getByRole('button', { name: 'Activate' }).click()
    await band.getByText(/^First approval: 6 active agents and 9 roles take effect\.$/).waitFor()
    await band.getByText('Sonnet could be dispatched.').waitFor()
    await shot('agents-first-approval-1280.png')
    await saveAndApprove()
    assert.equal(current()?.generation, 1)
    assert.equal(generation(1).data.agents.find((agent) => agent.id === 'sonnet').status, 'active')
    await agents.getByText(/^Generation 1 · approved/).waitFor()
    passed('first approval with one agent activated (60.5 AC4, AC2)')

    phase('switch an agent off')
    await agentRow('Opus').getByRole('switch', { name: 'Opus enabled' }).click()
    await band.getByText('Opus could no longer be dispatched.').waitFor()
    await saveAndApprove()
    assert.equal(current()?.generation, 2)
    await agents.locator('ul[aria-label="Disabled agents"] .agent-name', { hasText: 'Opus' }).waitFor()
    passed('switching an agent off moves it to Disabled and approves generation 2')

    phase('change security and see the consequence; Escape discards and leaves file and state unchanged')
    const before = { roster: rosterHash(), state: stateHash() }
    await agentRow('Astra').locator('.agent-open').click()
    const astraEditor = agents.locator('#agent-astra-editor')
    await astraEditor.locator('[role="radiogroup"][aria-labelledby="agent-astra-security"] [role="radio"]', { hasText: 'Low' }).click()
    await band.getByText('Astra could no longer receive private work.').waitFor()
    await band.locator('.diff-lines', { hasText: 'security' }).waitFor()
    await shot('agents-consequence-1280.png')
    await astraEditor.locator('[role="radiogroup"][aria-labelledby="agent-astra-security"] [role="radio"][aria-checked="true"]').focus()
    await page.keyboard.press('Escape')
    await band.waitFor({ state: 'detached' })
    assert.ok(await page.locator('.preferences-dialog').isVisible(), 'Escape closed Preferences instead of discarding the staged edit')
    assert.deepEqual({ roster: rosterHash(), state: stateHash() }, before)
    await agentRow('Astra').locator('.agent-open').click()
    passed('a security change says "Astra could no longer receive private work"; Escape discards it with file and state hashes unchanged')

    phase('reorder a chain')
    const reviewer = agents.locator('.chain', { has: page.locator('#role-epic-reviewer-name') })
    await reviewer.getByRole('button', { name: 'Move Fable up in epic-reviewer' }).click()
    await band.getByText('Epic-reviewer would start with Fable instead of Astra.').waitFor()
    await saveAndApprove()
    assert.deepEqual(generation(current().generation).data.roles.find((role) => role.id === 'epic-reviewer').candidates, ['fable@medium', 'astra@medium'])
    passed('moving Fable up the epic-reviewer chain is approved with its consequence')

    phase('label a workspace folder and see inheritance')
    await agents.getByLabel('Label a folder').fill(work)
    await agents.getByRole('button', { name: 'Label public' }).click()
    await band.getByText(`${work} becomes public: Low routes could receive its tracked files in packets.`).waitFor()
    const appRow = agents.locator('.label-row', { has: page.locator(`[title="${join(work, 'app')}"]`) })
    await appRow.getByText('inherited from a parent folder').waitFor()
    assert.equal(await appRow.locator('[role="radio"][aria-checked="true"]').textContent(), 'Public')
    await saveAndApprove()
    assert.deepEqual(generation(current().generation).data.data_labels.paths, [{ path: work, label: 'public' }])
    passed('labelling a folder public shows its child workspace inheriting it')

    phase('accept an untested harness version only when it resolves the tested route')
    const codexRoute = agents.locator('.route-row', { has: page.locator('#route-codex') })
    await codexRoute.getByRole('button', { name: 'Inspect' }).click()
    await codexRoute.getByText(/^0\.161\.0 is tested by BMN; recorded its route/).waitFor()
    stub('codex', 'echo "codex-cli 0.170.0"')
    await codexRoute.getByRole('button', { name: 'Inspect' }).click()
    await codexRoute.getByText('BMN has not tested how this version picks its destination.').waitFor()
    await codexRoute.getByText(/^Same route and sources as 0\.161\.0/).waitFor()
    await codexRoute.getByRole('button', { name: 'Accept 0.170.0' }).click()
    await band.getByText('Codex 0.170.0 could carry private work (owner-accepted, untested by BMN).').waitFor()
    await saveAndApprove()
    assert.deepEqual(generation(current().generation).data.harness_routes.find((route) => route.harness === 'codex').accepted_versions, ['0.170.0'])
    stub('codex', 'echo "codex-cli 0.171.0"')
    writeFileSync(join(home, '.codex/config.toml'), 'model_provider = "proxy"\n[model_providers.proxy]\nbase_url = "https://proxy.example.com/v1"\n')
    await codexRoute.getByRole('button', { name: 'Inspect' }).click()
    await codexRoute.getByText(/not offered\.$/).waitFor()
    assert.equal(await codexRoute.getByRole('button', { name: 'Accept 0.171.0' }).count(), 0)
    rmSync(join(home, '.codex/config.toml'))
    stub('codex', 'echo "codex-cli 0.161.0"')
    passed('an untested version is offered only with the tested route; a changed route withholds it')

    phase('an outside role-chain edit: approve it, then revert another')
    const approveOutside = async (edit, action) => {
      writeFileSync(rosterFile, edit(readFileSync(rosterFile, 'utf8')))
      await agents.getByRole('button', { name: 'Reload' }).click()
      const row = agents.locator('.roster-outside', { hasText: 'Roles · changed outside BMN' })
      await row.waitFor()
      await shot(`agents-outside-${action}-1280.png`)
      await row.getByRole('button', { name: action, exact: true }).click()
      await row.waitFor({ state: 'detached' })
    }
    await approveOutside((text) => text.replace('focused-reviewer: {candidates: [luna@max, astra@low], then: lead}', 'focused-reviewer: {candidates: [astra@low, luna@max], then: lead}'), 'Approve')
    assert.deepEqual(generation(current().generation).data.roles.find((role) => role.id === 'focused-reviewer').candidates, ['astra@low', 'luna@max'])
    const approvedText = readFileSync(rosterFile, 'utf8')
    await approveOutside((text) => text.replace('helper: {candidates: [luna@max], then: lead}', 'helper: {candidates: [luna@max], then: skip}'), 'Revert file to approved')
    assert.equal(readFileSync(rosterFile, 'utf8'), approvedText)
    passed('an outside role-chain edit is approved from its row; another is reverted to the approved bytes')

    phase('restore an earlier generation')
    const generationsBefore = readdirSync(join(stateDir, 'generations')).length
    await agents.locator('details.advanced > summary', { hasText: 'Advanced' }).last().click()
    const first = agents.locator('.generation', { hasText: /^Generation 1 ·/ })
    await first.getByRole('button', { name: 'Open' }).click()
    await first.locator('.diff-groups').waitFor()
    await first.getByRole('button', { name: 'Restore…' }).click()
    await band.getByText(/^Restore generation 1 as a new approval/).waitFor()
    await saveAndApprove('Restore generation 1')
    const restored = generation(current().generation)
    assert.equal(restored.kind, 'restore')
    assert.equal(restored.restored_from, 1)
    assert.equal(readdirSync(join(stateDir, 'generations')).length, generationsBefore + 1)
    passed('generation 1 is opened and restored as a new generation')

    phase('a conflicting outside save while a diff is open reloads without writing')
    await agents.locator('.roster-outside').first().waitFor()
    await agents.getByRole('button', { name: 'Approve all outside changes' }).click()
    await agents.locator('.roster-outside').first().waitFor({ state: 'detached' })
    const stableGeneration = current().generation
    await agentRow('Luna').getByRole('switch', { name: 'Luna enabled' }).click()
    await until(() => band.getByRole('button', { name: 'Save & approve' }).isEnabled(), 'the staged preview')
    writeFileSync(rosterFile, readFileSync(rosterFile, 'utf8').replace('Owner\'s opinion: PROSE-SENTINEL-SOL.', 'Owner\'s opinion: changed meanwhile.'))
    const conflictHash = rosterHash()
    await band.getByRole('button', { name: 'Save & approve' }).click()
    await agents.getByText('The roster changed on disk; reloaded without saving.').waitFor()
    assert.equal(current().generation, stableGeneration)
    assert.equal(rosterHash(), conflictHash)
    passed('a save after an outside change is refused and reloads; no generation and no write')

    phase('the opinion is edited here and saved into the prose')
    await agentRow('Sol').locator('.agent-open').click()
    await agents.locator('#agent-sol-opinion-input').fill('Opinion written in the panel.')
    await agents.getByRole('button', { name: 'Save opinion' }).click()
    await agents.getByText(/^Opinion saved/).waitFor()
    assert.match(readFileSync(rosterFile, 'utf8'), /Opinion written in the panel\./)
    passed('the opinion saves into the roster prose without a new generation')
    await agentRow('Sol').locator('.agent-open').click()

    phase('60.6: health reads link, unmanaged and missing targets')
    await rules.getByRole('heading', { name: 'Rules' }).scrollIntoViewIfNeeded()
    const health = rules.locator('.rules-health')
    await health.waitFor()
    const stateOf = (harness) => health.locator(`.rules-target:has(dt:text-is("${harness}"))`).getAttribute('data-state')
    assert.equal(await stateOf('Claude'), 'link')
    assert.equal(await stateOf('Codex'), 'unmanaged')
    assert.equal(await stateOf('Opencode'), 'missing')
    assert.equal(await health.getByRole('button', { name: 'Probe opencode' }).isDisabled(), true)
    passed('health shows link, unmanaged and missing; Probe is disabled on the Low opencode route')

    phase('edit and save the master')
    const editor = rules.locator('textarea.rules-master')
    await editor.fill(`${MASTER}\nA rule added in the panel.\n`)
    await rules.getByText(/· unsaved$/).waitFor()
    await rules.getByRole('button', { name: 'Save…' }).click()
    const rulesBand = rules.locator('.rules-confirm')
    await rulesBand.getByText(/^Save the master \(\+2 −0\)/).waitFor()
    await rulesBand.getByRole('button', { name: 'Save master' }).click()
    await rules.getByText(/^Master saved/).waitFor()
    assert.match(readFileSync(masterFile, 'utf8'), /A rule added in the panel\./)
    await editor.fill(`${MASTER}\nA rule added in the panel.\nA second rule.\n`)
    await rules.getByRole('button', { name: 'Save…' }).click()
    await rulesBand.getByText(/^Save the master \(\+1 −0\)/).waitFor()
    await rulesBand.getByRole('button', { name: 'Save master' }).click()
    await rulesBand.waitFor({ state: 'detached' })
    assert.match(readFileSync(masterFile, 'utf8'), /A second rule\./)
    passed('the master saves with a diff and keeps a source snapshot of each save')

    phase('a master that would not render is not saved')
    await editor.fill(`${MASTER}\n<!-- bmn:secret -->\n`)
    await rules.getByText('This master would not render:').waitFor()
    assert.equal(await rules.getByRole('button', { name: 'Save…' }).isDisabled(), true)
    await rules.getByRole('button', { name: 'Discard' }).click()
    passed('an unrenderable master shows its line and cannot be saved')

    phase('preview: full for claude, restricted for opencode')
    const preview = rules.locator('pre.rules-preview')
    assert.match(await preview.textContent(), /PRIVATE-SENTINEL/)
    assert.match(await preview.textContent(), /Generated by BMN/)
    await rules.locator('[role="radiogroup"][aria-labelledby="rules-preview-head"] [role="radio"]', { hasText: 'Opencode' }).click()
    await rules.getByText(/^Restricted/).waitFor()
    assert.doesNotMatch(await preview.textContent(), /PRIVATE-SENTINEL/)
    assert.match(await preview.textContent(), /Answer first, plainly\./)
    passed('the preview shows a full claude rendering and a restricted opencode one with sizes')

    phase('install over a link and an outside edit')
    await rules.getByRole('button', { name: 'Install…' }).click()
    await rulesBand.getByText(/^Install into 4 targets in one transaction; 1 replaces a link; 1 replaces an outside edit\./).waitFor()
    await rulesBand.locator('summary', { hasText: 'replaces a symbolic link' }).waitFor()
    await rulesBand.locator('summary', { hasText: 'replaces a file BMN did not write (unmanaged)' }).waitFor()
    await shot('rules-install-1280.png')
    await rulesBand.getByRole('button', { name: 'Install' }).click()
    await rules.getByText(/^Wrote 4 file\(s\) in transaction/).waitFor()
    assert.equal(lstatSync(join(home, '.claude/CLAUDE.md')).isSymbolicLink(), false)
    assert.equal(readFileSync(join(home, 'dotfiles/CLAUDE.md'), 'utf8'), '# hand-kept rules\n')
    assert.equal(await stateOf('Claude'), 'current')
    passed('one install transaction replaces the link and the hand-written file; the link target is untouched')

    phase('restore the transaction')
    await rules.getByRole('button', { name: 'Restore…' }).click()
    await rulesBand.locator('.choice-list [role="radio"]').first().click()
    await rulesBand.locator('summary', { hasText: `becomes link to ${join(home, 'dotfiles/CLAUDE.md')}` }).waitFor()
    await rulesBand.getByRole('button', { name: 'Restore', exact: true }).click()
    await rules.getByText(/^Restored /).waitFor()
    assert.equal(lstatSync(join(home, '.claude/CLAUDE.md')).isSymbolicLink(), true)
    assert.equal(readFileSync(join(home, '.codex/AGENTS.md'), 'utf8'), '# written by hand\n')
    passed('restoring the transaction puts the link and the hand-written file back')

    phase('revert the master from a source snapshot')
    await rules.locator('details.advanced > summary').click()
    await rules.getByRole('button', { name: 'Revert master…' }).click()
    await rulesBand.locator('.choice-list [role="radio"]').nth(1).click()
    await rulesBand.locator('summary', { hasText: /^Master · \+0 −1$/ }).waitFor()
    await rulesBand.getByRole('button', { name: 'Revert master' }).click()
    await rules.getByText(/^Master saved/).waitFor()
    assert.equal(readFileSync(masterFile, 'utf8'), `${MASTER}\nA rule added in the panel.\n`)
    passed('reverting the master restores the earlier source snapshot')

    phase('probe on a High route states what it sends and answers in words')
    await health.getByRole('button', { name: 'Probe claude' }).click()
    await rulesBand.getByText(/^Sends the rendered rules to claude's provider/).waitFor()
    await rulesBand.getByRole('button', { name: 'Send probe' }).click()
    await rules.getByText(/^claude probe (failed|was inconclusive): /).waitFor({ timeout: 60_000 })
    await health.getByText(/^(Failed|Inconclusive)/).first().waitFor()
    passed('a claude probe states it sends the rules, runs on the stub, and reports in words')

    phase('three sizes: no horizontal scrollbar, every control named')
    for (const [width, height] of SIZES) {
      await resize(width, height)
      await sleep(300)
      const overflow = await page.evaluate(() => {
        const body = document.querySelector('.preferences-dialog .app-dialog-body')
        const wide = [...document.querySelectorAll('.agents-section *, .rules-section *')]
          .filter((element) => element.getBoundingClientRect().right > body.getBoundingClientRect().right + 1 && element.getClientRects().length > 0)
          .filter((element) => !element.closest('pre, .preferences-path, details:not([open])'))
          .slice(0, 5).map((element) => `${element.tagName}.${element.className}`)
        return { scroll: body.scrollWidth > body.clientWidth, wide }
      })
      assert.equal(overflow.scroll, false, `horizontal scroll at ${width}x${height}: ${overflow.wide.join(', ')}`)
      assert.deepEqual(overflow.wide, [], `content past the dialog at ${width}x${height}`)
      const subhead = (text) => `[...document.querySelectorAll('.preferences-subhead')].find((h) => h.textContent === '${text}')`
      for (const [name, find] of [['agents', "document.getElementById('agents-head')"], ['roles', subhead('Roles')], ['labels', subhead('Workspace labels')],
        ['rules', "document.getElementById('rules-head')"], ['rules-preview', subhead('Master')]]) {
        await page.evaluate((expression) => (0, eval)(expression)?.scrollIntoView({ block: 'start' }), find)
        await sleep(150)
        await shot(`${name}-${width}.png`)
      }
    }
    const unnamed = await page.evaluate(() => [...document.querySelectorAll('.agents-section :is(button, input, textarea, [role="radio"], [role="switch"]), .rules-section :is(button, input, textarea, [role="radio"])')]
      .filter((element) => {
        const labelledBy = element.getAttribute('aria-labelledby')
        const name = element.getAttribute('aria-label') || (labelledBy && document.getElementById(labelledBy)?.textContent)
          || (element.id && document.querySelector(`label[for="${element.id}"]`)?.textContent) || element.textContent
        return !name || name.trim() === ''
      }).map((element) => element.outerHTML.slice(0, 120)))
    assert.deepEqual(unnamed, [])
    passed('no horizontal scroll at 800x500, 1000x700 and 1280x900; every control has a name')

    phase('keyboard: the jump list reaches both sections')
    const jump = page.locator('.preferences-jump select')
    for (const name of ['Agents', 'Rules']) {
      await jump.selectOption(name)
      assert.equal(await page.evaluate(() => document.activeElement?.textContent), name)
    }
    passed('the jump list focuses Agents and Rules')
    console.log(JSON.stringify({ agentsRulesVisual: 'PASS', directory: evidenceDirectory, ...result }))
  } finally {
    await Promise.race([application.close(), sleep(10_000)])
    try { application.process().kill('SIGKILL') } catch { /* already gone */ }
  }
})
