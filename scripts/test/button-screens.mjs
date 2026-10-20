// MODULE: button-screens.mjs - the button-screens pass of `pnpm run test:visual` (Stories 80.12, 80.13): every screen
// state with a button, menu or panel, in colour modes Black and Brown (identity Knight), at 1280x800 and 800x800.
//
// The states are Story 80.1's (plan/references/reference-80-slop-cleanup/screens/capture.mjs, 63 states), then the file
// reference dialog with a file read (its Send to session area), and Epic 84's departure: the head's "leaving" and
// "2 cards", Before you go and one of its grant choices changed. Story 80.13 adds the boxes 80.1 did not reach: progress
// and its evidence, Quick Look's tasks, find, menu, peek, a shown value and its two editors, a refused amount, a turn's
// difference, a message, and a stopped session with its notice, saved output and Resume. Each of the four variants
// starts the app afresh on the runner's fixture (headless window, fixed environment, the made-up project folder, the
// page clock) and walks the states in order; each state is saved as <directory>/<mode>-<width>/<state>.png, and the
// computed look of every visible button in it goes into buttons.json beside them. states.json lists the states in
// order, with how each is reached.
//
// The data folders sit at one fixed path inside the runner's fixture folder, so a path the screens print is the same on
// every run. HOME holds Story 80.1's synthetic team (the unit tests' roster-example.md), a rules master and stand-in
// `claude` and `codex` programs that only print a version; the project folder is a fresh repository with one README.
// The main process stamps real times, which would differ between runs, so every date and time the window shows is
// drawn as the fixture's moment (2026-01-01 00:00 UTC); time values, and so every age and duration, stay real.
/* global window, document, getComputedStyle */
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const buttonVariants = Object.freeze([
  Object.freeze({ colorMode: 'black', width: 1280 }),
  Object.freeze({ colorMode: 'black', width: 800 }),
  Object.freeze({ colorMode: 'brown', width: 1280 }),
  Object.freeze({ colorMode: 'brown', width: 800 })
])
const windowHeight = 800

// B1 and B3 (docs/design.md): a button draws no line, as a border side or as a ring shadow. A selected sidebar row's
// left border is its F2 bar, the one exception the rules name.
const clearColor = /^transparent$|rgba\([^)]*,\s*0\)$/
function drawsLine(button) {
  const side = button.border.split(' | ').some((part) => {
    const [width, style, ...color] = part.split(' ')
    return Number.parseFloat(width) > 0 && style !== 'none' && !clearColor.test(color.join(' '))
  })
  return side || /(^|\s)0px 0px 0px [1-9]/.test(button.shadow)
}

const stateSlug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')

// Epic 84's cards, as its live test asks them (scripts/test/away-grant-live.mjs): made-up repositories and reasons.
const grantTerms = [
  { kind: 'rounds', proposed: 3, reason: '80.3\'s review took two rounds last night; two boundaries are ahead.' },
  { kind: 'merge', id: 'merge-12', repository: 'octo-probe/widgets', pr: 12, headSha: '3f2a9c1', upTo: 2, proposed: 'pr', reason: 'Its required checks were green at 22:20.' },
  { kind: 'push-default', id: 'push-81', repository: 'octo-probe/tools', branch: 'dev-auto/epic-81', proposed: 'yes', reason: '81.1 changes the tools\' SKILL.md, and tools takes no PRs.' }
]

// Runs in the window before the app's scripts: every calendar field and date text of a valid Date (and every
// Intl.DateTimeFormat result) is that of `fixed`; getTime, toISOString and arithmetic stay real.
function freezeCalendar(fixed) {
  const prototype = Object.getPrototypeOf(new Date(0))
  const moment = new Date(fixed)
  const timeOf = prototype.getTime
  for (const name of [
    'getFullYear', 'getMonth', 'getDate', 'getDay', 'getHours', 'getMinutes', 'getSeconds', 'getMilliseconds',
    'getUTCFullYear', 'getUTCMonth', 'getUTCDate', 'getUTCDay', 'getUTCHours', 'getUTCMinutes', 'getUTCSeconds',
    'getUTCMilliseconds', 'toString', 'toDateString', 'toTimeString', 'toLocaleString', 'toLocaleDateString',
    'toLocaleTimeString'
  ]) {
    const original = prototype[name]
    prototype[name] = function (...args) {
      return original.apply(Number.isNaN(timeOf.call(this)) ? this : moment, args)
    }
  }
  let formats = Intl.DateTimeFormat.prototype
  while (formats && !Object.getOwnPropertyDescriptor(formats, 'formatToParts')) formats = Object.getPrototypeOf(formats)
  if (!formats) return
  const pick = (date) => (date === undefined || !Number.isNaN(Number(date)) ? fixed : date)
  const format = Object.getOwnPropertyDescriptor(formats, 'format').get
  const formatToParts = formats.formatToParts
  Object.defineProperty(formats, 'format', {
    configurable: true,
    get() {
      const bound = format.call(this)
      return (date) => bound(pick(date))
    }
  })
  formats.formatToParts = function (date) {
    return formatToParts.call(this, pick(date))
  }
}

// A fresh fixture for one variant: the data folders, HOME with the synthetic team, and the project folder.
function prepareFixture({ base, appDirectory, fixtureFolder }) {
  rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  const roots = Object.fromEntries(['config', 'data', 'state', 'cache', 'runtime', 'home', 'stubs'].map((name) => {
    const path = join(base, name)
    mkdirSync(path, { recursive: true, mode: 0o700 })
    return [name, path]
  }))
  const home = roots.home
  const agentsDirectory = join(home, '.config/bmn/agents')
  mkdirSync(join(agentsDirectory, 'state'), { recursive: true, mode: 0o700 })
  // The team file comes after the first Team capture (no team yet), as a link to a file kept elsewhere.
  const roster = readFileSync(join(appDirectory, 'src/utility/test-fixtures/agents/roster-example.md'), 'utf8')
    .replace('opencode: {provider: opencode-go, basis: observed-default}', 'opencode: {provider: opencode-go, basis: owner-declared}')
  writeFileSync(join(agentsDirectory, 'global-rules.md'), '# Global rules\n\nPlain rule for everyone.\n\n## Team\nThe team: <!-- bmn:team -->.\n')
  const stub = (name, body) => {
    writeFileSync(join(roots.stubs, name), `#!/bin/sh\n${body}\n`)
    chmodSync(join(roots.stubs, name), 0o755)
  }
  stub('codex', 'echo "codex-cli 0.161.0"')
  stub('claude', 'case "$1" in --version) echo "2.1.295 (Claude Code)";; *) cat > /dev/null; echo "I cannot tell";; esac')
  writeFileSync(join(home, '.bashrc'), `export PATH="${roots.stubs}:$PATH"\n`)
  mkdirSync(join(home, '.claude'))
  mkdirSync(join(home, 'dotfiles'))
  writeFileSync(join(home, 'dotfiles/CLAUDE.md'), '# hand-kept rules\n')
  symlinkSync(join(home, 'dotfiles/CLAUDE.md'), join(home, '.claude/CLAUDE.md'))
  mkdirSync(join(home, '.codex'))
  writeFileSync(join(home, '.codex/AGENTS.md'), '# written by hand\n')
  // The project folder is a fresh repository (no commit), so checkout-aware screens have a checkout to name.
  rmSync(fixtureFolder, { recursive: true, force: true })
  mkdirSync(fixtureFolder, { mode: 0o700 })
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', fixtureFolder], {
    env: { PATH: '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1' }
  })
  writeFileSync(join(fixtureFolder, 'README.md'), '# synthetic project\n\nA file for Quick Look and the Files panel.\n')
  return { roots, home, agentsDirectory, roster }
}

/**
 * Captures every button state in each variant and returns what it saved. `context` carries the runner's fixture:
 * launch(roots, environment), close(application, roots), fixPageClock, setContentSize, setAppearance, screenshot(page,
 * name, directory), phase(label), plus directory, appDirectory, fixtureParent, fixtureFolder and fixtureTime.
 */
export async function captureButtonScreens(context) {
  const base = join(context.fixtureParent, 'button-pass')
  const variants = []
  let index = null
  for (const variant of buttonVariants) {
    const label = `${variant.colorMode}-${variant.width}`
    const directory = join(context.directory, label)
    mkdirSync(directory, { recursive: true })
    context.phase(`button screens ${label}`)
    const fixture = prepareFixture({ base, appDirectory: context.appDirectory, fixtureFolder: context.fixtureFolder })
    const application = await context.launch(fixture.roots, { BMN_START_INSTALLS: 'hooks' })
    let walked
    try {
      walked = await walkStates(application, { ...context, ...fixture, variant, directory })
    } finally {
      await context.close(application, fixture.roots)
      rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
    await writeFile(join(directory, 'buttons.json'), `${JSON.stringify({ variant, states: walked.facts }, null, 1)}\n`)
    const outlined = Object.entries(walked.facts).flatMap(([slug, buttons]) => buttons
      .filter((button) => drawsLine(button) && !/\bdiv\.session-row\.selected > button$/.test(button.where))
      .map((button) => `${slug}: ${button.where} "${button.text}" border ${button.border}, shadow ${button.shadow}`))
    if (outlined.length > 0) throw new Error(`${label}: a button draws a line (B1, B3):\n${outlined.join('\n')}`)
    const order = walked.states.map((state) => state.slug).join('\n')
    if (index === null) index = { order, states: walked.states }
    else if (order !== index.order) throw new Error(`${label} reached other states than ${buttonVariants[0].colorMode}-${buttonVariants[0].width}`)
    variants.push({ ...variant, directory, screenshots: walked.states.length })
  }
  await writeFile(join(context.directory, 'states.json'), `${JSON.stringify(index.states, null, 1)}\n`)
  return { states: index.states.length, variants }
}

async function walkStates(application, context) {
  const { roots, home, agentsDirectory, roster, variant, directory } = context
  const page = await application.firstWindow()
  page.setDefaultTimeout(15_000)
  await page.waitForSelector('.session-row')
  await application.context().addInitScript(freezeCalendar, context.fixtureTime.getTime())
  await context.fixPageClock(application, page)
  await page.waitForSelector('.session-row')
  // That reload reads to BMN as a lost renderer, and its notice is not what a start shows the owner, so it is dismissed.
  const dismiss = page.getByRole('button', { name: 'Dismiss notice' })
  await dismiss.waitFor({ timeout: 10_000 }).then(() => dismiss.click(), () => undefined)
  await context.setContentSize(application, page, variant.width, windowHeight)
  await context.setAppearance(page, 'knight', variant.colorMode)

  const socket = join(roots.runtime, 'bmn/control/control.sock')
  const environment = {
    PATH: '/usr/bin:/bin', HOME: home, LANG: 'C.UTF-8', TZ: 'UTC',
    XDG_CONFIG_HOME: roots.config, XDG_DATA_HOME: roots.data, XDG_STATE_HOME: roots.state, XDG_CACHE_HOME: roots.cache,
    XDG_RUNTIME_DIR: roots.runtime,
    BMN_CONFIG_HOME: join(roots.config, 'bmn'), BMN_DATA_HOME: join(roots.data, 'bmn'),
    BMN_STATE_HOME: join(roots.state, 'bmn'), BMN_RUNTIME_HOME: join(roots.runtime, 'bmn')
  }
  // The owner's CLI over the app's own socket; `bmn grant`, like `bmn policy`, takes its credentials after the command.
  const ownerCli = (args, input) => execFileSync(process.execPath, [
    join(context.appDirectory, 'bin/bmn'),
    ...(args[0] === 'grant' ? [...args, '--owner', '--socket', socket] : ['--owner', '--socket', socket, ...args])
  ], { encoding: 'utf8', env: environment, cwd: home, ...(input === undefined ? {} : { input }) })

  const pause = (ms) => page.waitForTimeout(ms)
  const escapeAll = async () => {
    for (let i = 0; i < 4; i += 1) {
      if (!(await page.locator('dialog[open]').count())) break
      await page.keyboard.press('Escape')
      await pause(250)
    }
  }
  const palette = async (label) => {
    await escapeAll()
    await page.getByRole('button', { name: 'Command palette' }).click()
    await page.locator('dialog[open] input').first().fill(label)
    const option = page.locator('.palette-results [role="option"]', { hasText: label }).first()
    await option.waitFor()
    await option.click()
  }
  const openAllDetails = () => page.evaluate(() => {
    let opened = 0
    for (const details of document.querySelectorAll('details:not([open])')) {
      if (details.getClientRects().length) {
        details.open = true
        opened += 1
      }
    }
    return opened
  })
  // What the window shows, as text and element count: a capture is kept only when it did not change across the shot.
  const signature = () => page.evaluate(() => `${document.querySelectorAll('*').length}|${document.body.innerText}`)
  const settleText = async () => {
    const deadline = Date.now() + 30_000
    let last = await signature()
    let since = Date.now()
    while (Date.now() - since < 500) {
      if (Date.now() > deadline) throw new Error('the screen never held still for 500 ms')
      await pause(100)
      const now = await signature()
      if (now !== last) {
        last = now
        since = Date.now()
      }
    }
  }
  const buttonFacts = () => page.evaluate(() => {
    const where = (element) => {
      const parts = []
      for (let node = element; node && node !== document.body && parts.length < 3; node = node.parentElement) {
        const classes = typeof node.className === 'string' ? node.className.trim().split(/\s+/).filter(Boolean) : []
        parts.unshift(`${node.tagName.toLowerCase()}${classes.map((name) => `.${name}`).join('')}`)
      }
      return parts.join(' > ')
    }
    return [...document.querySelectorAll('button')].filter((button) => button.getClientRects().length > 0).map((button) => {
      const style = getComputedStyle(button)
      const sides = ['Top', 'Right', 'Bottom', 'Left']
        .map((side) => `${style[`border${side}Width`]} ${style[`border${side}Style`]} ${style[`border${side}Color`]}`)
      return {
        where: where(button),
        text: (button.getAttribute('aria-label') ?? button.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 48),
        background: style.backgroundColor,
        border: [...new Set(sides)].join(' | '),
        radius: style.borderTopLeftRadius,
        weight: style.fontWeight,
        shadow: style.boxShadow,
        opacity: style.opacity
      }
    })
  })

  const states = []
  const facts = {}
  const capture = async (name, how, mask) => {
    const slug = stateSlug(name)
    if (facts[slug]) throw new Error(`two states share the name ${slug}`)
    await page.mouse.move(0, 0)
    await settleText()
    for (let attempt = 0; ; attempt += 1) {
      const before = await signature()
      await context.screenshot(page, `${slug}.png`, directory, mask ? { mask } : {})
      if (before === await signature()) break
      if (attempt >= 4) throw new Error(`${name}: the screen kept changing across the capture`)
    }
    facts[slug] = await buttonFacts()
    states.push({ slug, name, how, ...(mask ? { masked: mask.map(String) } : {}) })
  }
  // `mask` names what is random on every run (a process id); the capture paints it over.
  const step = async (name, how, run, disclosures = false, mask = null) => {
    try {
      await run()
    } catch (error) {
      throw new Error(`button screens ${variant.colorMode}-${variant.width}: ${name} not reached (${how})`, { cause: error })
    }
    await capture(name, how, mask)
    if (disclosures && (await openAllDetails()) > 0) {
      await capture(`${name} + disclosures opened`, `${how}; every closed <details> on screen opened`, mask)
    }
  }

  // ---- the shell (Story 80.1) ----
  await step('Main window, one shell session', 'start: one /bin/bash session in the made-up project folder', async () => {})
  await step('Command palette', 'header button "Command palette"', async () => {
    await page.getByRole('button', { name: 'Command palette' }).click()
    await page.locator('.command-palette[open]').waitFor()
  })
  await step('Session row menu', 'the ⋯ button on the session row (a popup menu); at 800 px, where the rail hides it, the pane\'s ⋯', async () => {
    await escapeAll()
    const rowMenu = page.locator('.session-row .row-menu-button').first()
    if (await rowMenu.isVisible()) await rowMenu.click({ force: true })
    else await page.locator('.session-terminal.selected .pane-actions [data-action="more"]').click()
    await page.locator('.popup-menu').waitFor()
  })
  await step('Terminal search bar', 'palette: Search terminal output', async () => {
    await page.keyboard.press('Escape')
    await palette('Search terminal output')
    // Search opens with the caret in its field; the closing palette's focus return can land after that, so it is put back.
    const field = page.locator('.session-terminal.selected .terminal-search input')
    await field.waitFor()
    await field.focus()
  })
  await step('New session panel', 'palette: New session…', () => palette('New session…'), true)
  await step('Edit launch settings', 'palette: Edit launch settings', () => palette('Edit launch settings'), true)
  await step('Session details panel', 'palette: Session details', () => palette('Session details'), true)
  await step('Files side panel', 'palette: Show files', () => palette('Show files'), true)
  await step('Hook events dialog', 'palette: Hook events…', () => palette('Hook events…'), true)
  await step('Plan use dialog', 'palette: Plan use…', () => palette('Plan use…'), true)
  await step('dev-auto runs dialog', 'palette: dev-auto runs…', () => palette('dev-auto runs…'), true)
  await step('Review results dialog', 'palette: Review results…', () => palette('Review results…'), true)
  await step('Messages dialog', 'palette: Messages…', () => palette('Messages…'), true)
  await step('Quick Look', 'palette: Project files…', () => palette('Project files…'), true)
  await step('File reference dialog', 'palette: Open file reference…', () => palette('Open file reference…'), true)

  // ---- the file reference's Send to session area (Story 80.12) ----
  const referenceDialog = page.locator('dialog.file-reference-dialog')
  await step('File reference dialog, a file read', 'the dialog: README.md, Open', async () => {
    await referenceDialog.locator('input[aria-label="File reference"]').fill('README.md')
    await referenceDialog.getByRole('button', { name: 'Open', exact: true }).click()
    await referenceDialog.locator('.file-reference-send').waitFor()
  })
  await step('File reference dialog, a session chosen', 'Send to session: the shell session', async () => {
    const chooser = referenceDialog.locator('select[aria-label="Send to session"]')
    await chooser.selectOption({ index: 1 })
    await referenceDialog.getByRole('button', { name: 'Review send…' }).waitFor()
  })
  await step('File reference dialog, send reviewed', 'Review send…', async () => {
    await referenceDialog.getByRole('button', { name: 'Review send…' }).click()
    await referenceDialog.locator('.file-reference-send-preview').waitFor()
  }, false, [referenceDialog.locator('.file-reference-send-preview .mono')])

  // ---- Preferences (Story 80.1) ----
  const preferencesDialog = page.locator('.preferences-dialog')
  const main = preferencesDialog.locator('.preferences-page:not([hidden])')
  const preferences = async (pageLabel, view) => {
    if (!(await preferencesDialog.count())) {
      await escapeAll()
      await page.locator('.preferences-button').click()
      await preferencesDialog.waitFor()
    }
    await preferencesDialog.locator('.preferences-nav .nav-item', { hasText: new RegExp(`^${pageLabel}`) }).click()
    await pause(400)
    if (view) {
      await main.locator('.page-views [role="radio"]', { hasText: new RegExp(`^${view}$`) }).click()
      await pause(1200)
    }
  }
  const card = (name) => main.locator('.agent-card', { has: page.locator('.agent-open', { hasText: new RegExp(`^${name}$`) }) })
  const outsideFocus = async () => {
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')) })
    await pause(1500)
  }
  await step('Preferences › Agents › Team, no team file', 'Preferences, Agents, Team, before any team file exists',
    () => preferences('Agents', 'Team'))
  writeFileSync(join(home, 'dotfiles/roster.md'), roster)
  symlinkSync(join(home, 'dotfiles/roster.md'), join(agentsDirectory, 'roster.md'))
  await outsideFocus()
  await step('Preferences › Agents › Team, nothing approved yet', 'Preferences, Agents, Team; the synthetic team file, never approved',
    () => preferences('Agents', 'Team'), true)
  await step('Preferences › Agents › Team, after the first approval', 'Team: Activate Sonnet, Approve, Approve in the sheet', async () => {
    await preferences('Agents', 'Team')
    await card('Sonnet').getByRole('button', { name: 'Activate' }).click()
    const ledger = preferencesDialog.locator('.ledger')
    await ledger.getByRole('button', { name: 'Approve', exact: true }).click()
    await ledger.locator('.ledger-sheet[role="group"]').getByRole('button', { name: 'Approve', exact: true }).click()
    await pause(2500)
  }, true)
  await step('Preferences › Integrations › Health, before BMN\'s proposal is approved', 'Preferences, Integrations, Health, after the first approval',
    () => preferences('Integrations', 'Health'), true)
  await step('Preferences › Agents › Team, Jev approved as judge', 'Team: Approve… on BMN\'s proposal card, Approve in its sheet', async () => {
    await preferences('Agents', 'Team')
    await main.getByRole('button', { name: /^Approve…/ }).first().click()
    await pause(800)
    await preferencesDialog.locator('.ledger-sheet[role="group"], .preferences-main [role="group"]')
      .getByRole('button', { name: 'Approve', exact: true }).first().click()
    await pause(2500)
  }, true)
  for (const agent of ['Jev', 'Sol', 'Opus', 'Astra', 'Fable', 'Luna', 'Sonnet', 'Haiku', 'GLM-5\\.3']) {
    const shown = agent.replace('\\', '')
    await step(`Preferences › Agents › Team › ${shown}`, `Team, open the ${shown} card`, async () => {
      await preferences('Agents', 'Team')
      await card(agent).locator('.agent-open').click()
      await pause(900)
    }, true)
  }
  await step('Preferences › Agents › Team › New agent', 'Team, New agent', async () => {
    await preferences('Agents', 'Team')
    await main.getByRole('button', { name: 'New agent' }).click()
    await pause(900)
  }, true)
  for (const view of ['Roles', 'Models', 'Changes', 'Asks']) {
    await step(`Preferences › Agents › ${view}`, `Preferences, Agents, ${view}`, () => preferences('Agents', view), true)
  }
  for (const view of ['Health', 'Rules', 'Skills', 'Tools']) {
    await step(`Preferences › Integrations › ${view}`, `Preferences, Integrations, ${view}`, () => preferences('Integrations', view), true)
  }
  await step('Preferences › Integrations › Health › Update Codex sheet', 'Health, the Codex block, Update…', async () => {
    await preferences('Integrations', 'Health')
    await main.getByRole('button', { name: 'Update Codex' }).click()
    await pause(1000)
  })
  await step('Preferences › Agents › Team, team file edited outside', 'the synthetic team file changed on disk, then the window gets the focus', async () => {
    await page.keyboard.press('Escape')
    // The first approval replaced the link with a regular file, so the edit goes to the team file itself.
    const file = join(agentsDirectory, 'roster.md')
    writeFileSync(file, readFileSync(file, 'utf8').replace('PROSE-SENTINEL-SOL', 'PROSE-SENTINEL-SOL, edited outside'))
    await preferences('Agents', 'Team')
    await outsideFocus()
  }, true)
  for (const pageLabel of ['General', 'Notifications', 'Voice', 'Data']) {
    await step(`Preferences › ${pageLabel}`, `Preferences, ${pageLabel}`, () => preferences(pageLabel, null), true)
  }

  // ---- Away (Story 80.1) ----
  const awayBox = page.locator('.away-check input[type="checkbox"]')
  await step('Away check, away', 'check the Away box in the header', async () => {
    await escapeAll()
    await awayBox.click()
    await page.locator('.away-check[data-away]').waitFor()
  })
  await step('Away summary dialog', 'uncheck the Away box, then palette: While you were away…', async () => {
    await awayBox.click()
    await page.locator('.away-check:not([data-away])').waitFor()
    await palette('While you were away…')
  }, true)

  // ---- Epic 84: the departure, its cards and their grant choices ----
  const head = page.locator('.away-check button.away-grant')
  const beforeYouGo = page.locator('dialog.before-you-go-dialog')
  await step('Head, leaving', 'bmn away --leaving: the head says "leaving"', async () => {
    await escapeAll()
    ownerCli(['away', '--leaving'])
    await page.locator('.away-check button.away-grant:not(.cards)', { hasText: /^leaving$/ }).waitFor()
  })
  await step('Head, two grant cards', 'two runs ask on a card each (bmn grant ask) and a third needs nothing', async () => {
    const ask = (run, title, terms, scope) => ownerCli(['grant', 'ask', '--run', run, '--card-file', '-'], JSON.stringify({ title, scope, terms }))
    ask('run-80', 'Epic 80 · clean up ai slop', grantTerms, 'Stories 80.2–80.6, then Epic 81')
    ask('run-81', 'Epic 81 · harness doctor', [grantTerms[0]], 'Story 81.2')
    ownerCli(['grant', 'ask', '--run', 'run-79', '--nothing', '--title', 'Epic 79 · first-run setup'])
    await page.locator('.away-check button.away-grant.cards', { hasText: /^2 cards$/ }).waitFor()
  })
  await step('Before you go', 'the head\'s "2 cards"', async () => {
    await head.click()
    await beforeYouGo.locator('article.grant-card.request').nth(1).waitFor()
  })
  await step('Before you go, a choice changed', 'the first card: No on its second term', async () => {
    const first = beforeYouGo.locator('article.grant-card.request').first()
    await first.locator('.segmented').nth(1).locator('[role="radio"]', { hasText: /^No$/ }).click()
    await first.locator('.segmented').nth(1).locator('[role="radio"][aria-checked="true"]', { hasText: /^No$/ }).waitFor()
  })

  // ---- Story 80.13: the boxes 80.1's capture did not reach (screens/box-confirmations.md) ----
  const clock = application.context().clock
  const pageNow = () => page.evaluate(() => Date.now())
  const sessionId = await page.locator('.session-row > button[data-session-id]').first().getAttribute('data-session-id')
  const pane = page.locator('.session-terminal.selected')
  // The shell runs what an agent would, typed by the owner's CLI; what it prints back is fixed words, never an id.
  const shellRuns = async (command, said) => {
    ownerCli(['send', command, '--submit', '--session', sessionId])
    await page.waitForFunction(([id, wanted]) =>
      window.__aitermTest?.snapshot(id)?.bufferLines.some((line) => line.includes(wanted)), [sessionId, said])
  }
  // A report a month old reads "31 d ago" and stale on every run; it carries a file the shell published as evidence.
  writeFileSync(join(home, 'report.md'), '# Search filters\n\nFilters added; the unit tests pass.\n')
  writeFileSync(join(home, 'box-progress.sh'), [
    'case "$1" in 1) label=\'Story 1.2 search filters\' at=2025-12-01T00:00:00.000Z ;; *) label=\'Story 1.3 search ranking\' at=2025-12-02T00:00:00.000Z ;; esac',
    '[ -s "$HOME/report.id" ] || bmn publish "$HOME/report.md" --name report.md --key box-report --json |',
    '  node -e \'process.stdout.write(JSON.parse(require("fs").readFileSync(0, "utf8")).artifactId)\' > "$HOME/report.id"',
    'bmn progress claimed-done "$label" --source synthetic --detail \'Filters added; the unit tests pass.\' \\',
    '  --evidence-id "$(cat "$HOME/report.id")" --observed "$at" > /dev/null && echo "progress $1 taken"',
    ''
  ].join('\n'))
  await step('Session pane, stale progress', 'the shell publishes report.md and reports progress observed a month before the page clock', async () => {
    await escapeAll()
    await shellRuns('sh ~/box-progress.sh 1', 'progress 1 taken')
    await pane.locator('.progress-strip .stale').waitFor()
  })
  const progressDialog = page.locator('dialog.progress-evidence-dialog')
  await step('Progress evidence dialog', 'the strip\'s state word', async () => {
    await pane.locator('.progress-open').click()
    await progressDialog.locator('.provenance .stale').waitFor()
  })
  await step('Progress evidence dialog, a file previewed', 'Preview on report.md', async () => {
    await progressDialog.getByRole('button', { name: 'Preview', exact: true }).click()
    await progressDialog.locator('.files-preview-box .files-preview-text').waitFor()
  })
  await step('Progress evidence dialog, a newer report', 'the shell reports again, a day newer, while the dialog is open', async () => {
    await shellRuns('sh ~/box-progress.sh 2', 'progress 2 taken')
    await progressDialog.locator('.progress-replaced').waitFor()
  })
  await step('Session details panel, stale progress', 'palette: Session details', async () => {
    await palette('Session details')
    await page.locator('.session-inspector .progress-strip .stale').waitFor()
  })
  await step('Files side panel, a file published', 'palette: Show files (report.md, published above)', async () => {
    await palette('Show files')
    await page.locator('.files-panel .files-preview-box').waitFor()
  })

  // Quick Look on files made for it: Markdown tasks, a config file with a token, and a .env file.
  writeFileSync(join(context.fixtureFolder, 'notes.md'),
    '# Notes\n\n- [x] search filters\n- [ ] search ranking\n\nThe search filters keep the last query.\n')
  writeFileSync(join(context.fixtureFolder, 'settings.json'),
    '{\n  "theme": "black",\n  "apiToken": "made-up-token-0123456789abcdef"\n}\n')
  writeFileSync(join(context.fixtureFolder, '.env'), 'API_KEY=made-up-key-0123456789\nREGION=eu-west-1\n')
  const quickLook = page.locator('dialog.quick-look[open]')
  const goToFile = async (name) => {
    if (!(await quickLook.count())) {
      await palette('Project files…')
      await quickLook.waitFor()
    }
    await page.keyboard.press('Control+P')
    await quickLook.locator('.ql-top input').fill(name)
    await quickLook.locator('.ql-results-list [role="option"]', { hasText: name }).first().waitFor()
  }
  const openInQuickLook = async (name) => {
    await goToFile(name)
    await page.keyboard.press('Enter')
    await quickLook.locator('.ql-path', { hasText: name }).waitFor()
  }
  await step('Quick Look, Go to file typed', 'palette: Project files…, Go to file: notes.md (the top field focused)', async () => {
    await escapeAll()
    await goToFile('notes.md')
    await quickLook.locator('.ql-in.focus').waitFor()
  })
  await step('Quick Look, Markdown tasks', 'Enter on notes.md', async () => {
    await page.keyboard.press('Enter')
    await quickLook.locator('.ql-path', { hasText: 'notes.md' }).waitFor()
    await quickLook.locator('.ql-md-box').first().waitFor()
  })
  await step('Quick Look, find in file', 'Ctrl+F, "search"', async () => {
    await page.keyboard.press('Control+F')
    await quickLook.locator('.ql-find-in').fill('search')
    await quickLook.locator('.ql-match-current').waitFor()
  })
  await step('Quick Look, file actions menu', 'the path row\'s More actions', async () => {
    await quickLook.getByRole('button', { name: 'More actions' }).click()
    await quickLook.locator('.ql-menu').waitFor()
  })
  await step('Quick Look, peeking', 'F8 held down', async () => {
    await page.keyboard.press('Escape')
    await page.keyboard.down('F8')
    await page.locator('dialog.quick-look.peeking').waitFor()
  })
  await page.keyboard.up('F8')
  await step('Quick Look, a value shown', 'settings.json, its token shown (the eye); the page clock held so it reads 10 s', async () => {
    await openInQuickLook('settings.json')
    const eye = quickLook.locator('.ql-secret-note .ql-eye').first()
    await eye.waitFor()
    await clock.setFixedTime(await pageNow())
    await eye.click()
    await quickLook.locator('.ql-secret-shown').waitFor()
  })
  await clock.setSystemTime(await pageNow())
  await step('Quick Look, a config file edited', 'settings.json, Edit', async () => {
    await quickLook.locator('.ql-secret-shown').waitFor({ state: 'detached', timeout: 15_000 })
    await quickLook.getByRole('button', { name: /^Edit/ }).click()
    await quickLook.locator('.ql-code.ql-editing').waitFor()
  })
  await step('Quick Look, an env value edited', '.env (leaving the unchanged edit), API_KEY double-clicked', async () => {
    await quickLook.getByRole('button', { name: 'Editing' }).click()
    await openInQuickLook('.env')
    await quickLook.locator('.ql-env-row', { hasText: 'API_KEY' }).dblclick()
    await quickLook.locator('.ql-env-field').waitFor()
  })

  // A refused amount in Preferences: the field's invalid ring.
  await step('Preferences › Agents › Team › Jev, a limit refused', 'Jev\'s card, Monthly limit: 0', async () => {
    await escapeAll()
    await preferences('Agents', 'Team')
    await card('Jev').locator('.agent-open').click()
    await pause(900)
    const limit = main.getByRole('textbox', { name: 'Monthly limit in dollars' })
    await limit.fill('0')
    await main.locator('.field[aria-invalid="true"]').waitFor()
    await limit.evaluate((field) => field.scrollIntoView({ block: 'center' }))
  })

  // The shell says how to resume it; then a stand-in agent holds its terminal, as Claude Code would: it reports
  // through `bmn hook claude` (a made-up conversation), and its one turn changes notes.md between the prompt and
  // the stop. A second session, Reviewer, leaves it a message with `bmn tell` and exits. The scans' clock times and
  // the message's stamp (session ids) differ on every run, so the capture paints them over.
  await escapeAll()
  await palette('Close files')
  await shellRuns('bmn resume-command -- bash --noprofile --norc', 'Resume command recorded')
  writeFileSync(join(home, 'stand-in.mjs'), [
    'import { spawnSync } from \'node:child_process\'',
    'import { readFileSync, writeFileSync } from \'node:fs\'',
    `const folder = ${JSON.stringify(context.fixtureFolder)}`,
    'const hook = (event) => spawnSync(\'bmn\', [\'hook\', \'claude\'], { encoding: \'utf8\', input: JSON.stringify({',
    '  session_id: \'5b5b5b5b-1b1b-2c2c-3d3d-4e4e4e4e4e4e\', cwd: folder, ...event }) })',
    'hook({ hook_event_name: \'SessionStart\', source: \'startup\' })',
    'hook({ hook_event_name: \'UserPromptSubmit\', prompt: \'Rank the search results\', prompt_id: \'prompt-1\' })',
    'const notes = `${folder}/notes.md`',
    'writeFileSync(notes, readFileSync(notes, \'utf8\').replace(\'- [ ] search ranking\', \'- [x] search ranking\') +',
    '  \'Ranking puts the newest match first.\\n\')',
    'hook({ hook_event_name: \'Stop\', last_assistant_message: \'Search ranking is done.\' })',
    'process.stdout.write(\'stand-in agent holds the terminal\\r\\n\')',
    'process.stdin.setRawMode(true)',
    'process.stdin.resume()',
    ''
  ].join('\n'))
  await shellRuns('node ~/stand-in.mjs', 'stand-in agent holds the terminal')
  const turnsDialog = page.locator('dialog.turn-changes-dialog')
  await step('Turn changes dialog, a turn opened', 'palette: Turn changes…, the one turn, notes.md', async () => {
    await palette('Turn changes…')
    await turnsDialog.locator('.turn-row').first().click()
    // The turn's files come from its second scan, which takes longer on a loaded machine.
    await turnsDialog.locator('.file-row', { hasText: 'notes.md' }).click({ timeout: 60_000 })
    await turnsDialog.locator('.turn-diff').waitFor()
  }, false, [turnsDialog.locator('.turn-labels li', { hasText: 'Two scans' })])
  await escapeAll()
  const workspaceId = await page.evaluate(async () => (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt).workspaceId)
  await page.evaluate((p) => window.aiTerminal.createSession(p), {
    workspaceId, name: 'Reviewer', cwd: context.fixtureFolder, executable: '/bin/sh', cols: 100, rows: 24, backgroundChoice: 'stop',
    argv: ['-c', `bmn tell ${sessionId} --text 'The ranking reads well; one question on ties.' --key box-tell > /dev/null`]
  })
  await page.waitForFunction(async (id) => (await window.aiTerminal.listSessionMessages(id)).messages.length === 1, workspaceId)
  const messagesDialog = page.locator('dialog.session-messages-dialog')
  await step('Messages dialog, a message opened', 'Reviewer (a second session) tells the stand-in; palette: Messages…, the message', async () => {
    await palette('Messages…')
    await messagesDialog.locator('.message-row').first().click()
    await messagesDialog.locator('.message-text').waitFor()
  }, false, [messagesDialog.locator('.message-stamp')])

  // The session stops: the brief notice, the stopped session, its saved output and Resume.
  await escapeAll()
  await step('Brief notice, a session stopped', 'palette: Stop session…, Stop session; the page clock held while it shows', async () => {
    await palette('Stop session…')
    await page.locator('dialog[open]').getByRole('button', { name: 'Stop session', exact: true }).click()
    await page.locator('.feedback-notice.brief').waitFor()
    await clock.pauseAt((await pageNow()) + 100)
  })
  await clock.resume()
  await step('Stopped session', 'the brief notice gone', async () => {
    await page.locator('.feedback-notice.brief').waitFor({ state: 'detached', timeout: 15_000 })
    await page.locator('.stopped-session .progress-strip').waitFor()
  })
  await step('Stopped session, saved output', 'Saved output', async () => {
    await page.locator('.stopped-session').getByRole('button', { name: 'Saved output', exact: true }).click()
    await page.locator('.saved-output-summary').waitFor()
  })
  await step('Resume dialog, a reported command', 'Resume', async () => {
    await page.locator('.stopped-session').getByRole('button', { name: 'Resume', exact: true }).click()
    await page.locator('dialog[open] .resume-command').waitFor()
  })
  return { states, facts }
}
