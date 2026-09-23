/* global window, document, HTMLElement, HTMLButtonElement, getComputedStyle, requestAnimationFrame */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { _electron as electron } from 'playwright'
import { temporaryRootContracts, withTemporaryRoot } from '../lib/temporary-root.mjs'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDirectory, '../..')
const appDirectory = join(repoRoot, 'apps/desktop')
const evidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-5')
const activityEvidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-14')
const markerEvidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-11')
const glanceEvidenceDirectory = join(repoRoot, '.dev-auto/evidence/epic-20')
const requireFromApp = createRequire(join(appDirectory, 'package.json'))
const electronBinary = requireFromApp('electron')
const execFileAsync = promisify(execFile)
const phase = (label) => console.error(`[BMN visual] ${label}`)

const originalRuntime = process.env.XDG_RUNTIME_DIR
const originalWaylandDisplay = process.env.WAYLAND_DISPLAY
const waylandDisplay =
  originalRuntime && originalWaylandDisplay && !isAbsolute(originalWaylandDisplay)
    ? join(originalRuntime, originalWaylandDisplay)
    : originalWaylandDisplay

const baselineCss = `
  .session-row.selected > button:first-child { border-left-color: var(--text) !important; }
  .session-row.selected .session-name { font-weight: 400 !important; }
  .session-area.split .session-terminal.selected { outline-color: var(--focus) !important; }
  .session-area.split .session-terminal:not(.selected) .pane-heading strong {
    color: var(--text) !important;
    font-weight: 600 !important;
  }
  .palette-results [role='option'][aria-selected='true'] {
    box-shadow: inset 2px 0 var(--text) !important;
  }
  button:disabled { color: var(--muted) !important; opacity: 1 !important; }
  .needs-you-button .count { color: var(--text) !important; box-shadow: none !important; }
  .pane-actions button[aria-pressed='true'] { background: transparent !important; }
  .session-row > button:first-child:focus-visible,
  .workspace-row > button:first-child:focus-visible,
  .popup-menu [role='menuitem']:focus-visible,
  .app-dialog-body button:focus-visible,
  .needs-you-popover button:focus-visible { outline-offset: 2px !important; }
`

const epic20BaselineCss = `
  .workspace-row .status-dot.needs-you { display: none !important; }
  .session-row[data-live='false'] .session-name { color: var(--text) !important; }
  .workspace-row .row-menu-button,
  .session-row .row-menu-button { opacity: 1 !important; }
`

function ratio(first, second) {
  const luminance = (color) => {
    const channels = color.startsWith('#')
      ? [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
      : color.match(/[\d.]+/g).slice(0, 3).map((part) => Number(part) / 255)
    const linear = channels
      .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
  }
  let one = luminance(first)
  let two = luminance(second)
  if (one < two) [one, two] = [two, one]
  return (one + 0.05) / (two + 0.05)
}

async function setContentSize(application, page, width, height) {
  await application.evaluate(({ BrowserWindow }, size) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(size.width, size.height)
  }, { width, height })
  await page.waitForFunction(
    (size) => window.innerWidth === size.width && window.innerHeight === size.height,
    { width, height }
  )
}

async function setAppearance(page, identity, colorMode) {
  await page.evaluate(async ({ identity, colorMode }) => {
    await window.aiTerminal.putSettings('appearance', { identity, colorMode, terminalFontSize: 14 })
  }, { identity, colorMode })
  await page.waitForFunction(
    ({ identity, colorMode }) =>
      document.documentElement.dataset.identity === identity &&
      document.documentElement.dataset.colorMode === colorMode,
    { identity, colorMode }
  )
}

async function screenshot(page, name, directory = evidenceDirectory) {
  const path = join(directory, name)
  await page.screenshot({ path })
  return path
}

async function runControlCli(roots, sessionId, command, ...args) {
  await execFileAsync(process.execPath, [
    join(appDirectory, 'bin/bmn'),
    command,
    ...args,
    '--session',
    sessionId,
    '--owner',
    '--socket',
    join(roots.runtime, 'bmn/control/control.sock')
  ])
}

async function settleTerminalLayout(page) {
  await page.evaluate(() => new Promise((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame))
  }))
  await page.waitForTimeout(250)
}

async function pointerStates(page, locator, activeScreenshotName) {
  const read = () => locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      activePseudo: element.matches(':active'),
      background: style.backgroundColor,
      borderLeftColor: style.borderLeftColor,
      boxShadow: style.boxShadow,
      color: style.color,
      transform: style.transform,
      transitionDuration: style.transitionDuration
    }
  })
  await page.mouse.move(0, 0)
  await page.waitForTimeout(120)
  const idle = await read()
  await locator.hover()
  await page.waitForTimeout(120)
  const hover = await read()
  const box = await locator.boundingBox()
  assert.ok(box)
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  const active = await read()
  const activeScreenshot = activeScreenshotName ? await screenshot(page, activeScreenshotName) : null
  await page.mouse.move(0, 0)
  await page.mouse.up()
  return { idle, hover, active, activeScreenshot }
}

await mkdir(evidenceDirectory, { recursive: true })
await mkdir(activityEvidenceDirectory, { recursive: true })
await mkdir(markerEvidenceDirectory, { recursive: true })
await mkdir(glanceEvidenceDirectory, { recursive: true })

const evidence = await withTemporaryRoot(
  temporaryRootContracts.electronDevelopment,
  async ({ root, roots }) => {
    phase('launching isolated Electron app')
    const application = await electron.launch({
      executablePath: electronBinary,
      args: [appDirectory, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
      cwd: repoRoot,
      env: {
        ...process.env,
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

    try {
      const page = await application.firstWindow()
      page.setDefaultTimeout(15_000)
      await page.waitForSelector('.session-row')
      phase('creating six-session fixture')
      const fixture = await page.evaluate(async (cwd) => {
        const initialSettings = await window.aiTerminal.getSettings()
        const primary = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
        if (!primary) throw new Error('visual fixture has no primary workspace')
        const initial = (await window.aiTerminal.listSessions(primary.workspaceId))[0]
        if (!initial) throw new Error('visual fixture has no initial session')
        const second = await window.aiTerminal.createWorkspace({
          name: 'Research and review with a deliberately long workspace name',
          defaultCwd: cwd,
          position: 1
        })
        const create = async (workspaceId, name) => (
          await window.aiTerminal.createSession({
            workspaceId,
            name,
            cwd,
            executable: '/bin/bash',
            argv: ['--noprofile', '--norc'],
            cols: 80,
            rows: 24,
            backgroundChoice: 'stop'
          })
        ).session
        const sessions = [
          initial,
          await create(primary.workspaceId, 'Implementation — renderer hierarchy and interaction polish'),
          await create(primary.workspaceId, 'Verification — keyboard focus, motion and terminal stability'),
          await create(primary.workspaceId, 'Review — cross-epic architecture alignment'),
          await create(second.workspaceId, 'Reference audit — a deliberately long session name for truncation'),
          await create(second.workspaceId, 'Independent visual review')
        ]
        const current = await window.aiTerminal.getLayout(primary.workspaceId)
        const selected = sessions[0]
        const foreign = sessions[4]
        await window.aiTerminal.putLayout({
          workspaceId: primary.workspaceId,
          expectedRevision: current.layout.revision,
          state: {
            ...current.layout,
            workspaceId: primary.workspaceId,
            selectedSessionId: selected.sessionId,
            split: {
              orientation: 'side-by-side',
              panes: [
                { sessionId: selected.sessionId, ratio: 0.5 },
                { sessionId: foreign.sessionId, ratio: 0.5 }
              ]
            },
            sessionView: {
              ...current.layout.sessionView,
              [selected.sessionId]: { scrollLine: null, followTail: true },
              [foreign.sessionId]: { scrollLine: null, followTail: true }
            }
          }
        })
        return {
          initialSettings: initialSettings.appearance,
          primaryWorkspaceId: primary.workspaceId,
          primaryWorkspaceName: primary.name,
          secondWorkspaceId: second.workspaceId,
          secondWorkspaceName: second.name,
          selectedSessionId: selected.sessionId,
          foreignSessionId: foreign.sessionId,
          longSessionId: sessions[4].sessionId,
          sessionIds: sessions.map((item) => item.sessionId)
        }
      }, root)

      assert.equal(fixture.initialSettings.colorMode, 'black')
      phase('reloading fixture into renderer')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.session-area.split')
      await page.waitForFunction(() => document.querySelectorAll('.session-row').length === 6)
      await setContentSize(application, page, 1440, 900)

      const selectedTextarea = page.locator('.session-terminal.selected .xterm-helper-textarea')
      await Promise.all([
        runControlCli(roots, fixture.selectedSessionId, 'send', "printf 'EPIC5-PRIMARY-LIVE\\n'", '--submit'),
        runControlCli(roots, fixture.foreignSessionId, 'send', "printf 'EPIC5-FOREIGN-LIVE\\n'", '--submit')
      ])
      await page.waitForFunction(({ selectedSessionId }) => {
        const snapshots = window.__aitermTest?.snapshots()
        return snapshots?.[selectedSessionId]?.bufferLines.some((line) => line.includes('EPIC5-PRIMARY-LIVE'))
      }, { selectedSessionId: fixture.selectedSessionId })
        .catch(async (error) => {
          const snapshots = await page.evaluate(() => window.__aitermTest?.snapshots())
          throw new Error(`synthetic live output missing: ${JSON.stringify(snapshots)}`, { cause: error })
        })
      await page.locator(
        `.session-terminal[data-session-id="${fixture.foreignSessionId}"] .terminal-surface`
      ).click({ position: { x: 16, y: 16 } })
      await page.waitForFunction(({ foreignSessionId }) => {
        const snapshots = window.__aitermTest?.snapshots()
        return snapshots?.[foreignSessionId]?.bufferLines.some((line) => line.includes('EPIC5-FOREIGN-LIVE'))
      }, { foreignSessionId: fixture.foreignSessionId })
      await page.keyboard.press('Control+Tab')
      await page.waitForFunction((sessionId) =>
        document.querySelector(`.session-terminal[data-session-id="${sessionId}"]`)?.classList.contains('selected'),
      fixture.selectedSessionId)
      phase('synthetic live output visible in both panes')

      // The request is opened only after every synthetic keystroke and click has landed. BMN answers a
      // session's open request as soon as the owner types into it, so opening it first raced the
      // fixture's own input and intermittently left the phases below with a resolved request
      // (observed 2026-09-20; the same timeout is recorded against Epic 14).
      await runControlCli(
        roots,
        fixture.selectedSessionId,
        'ask',
        'epic5-visual',
        'Review visual hierarchy?',
        '--kind',
        'question'
      )
      await page.waitForFunction(() =>
        document.querySelector('.needs-you-button')?.getAttribute('data-has-items') === 'true'
      )
      phase('attention fixture visible')

      const disableTarget = async () => page.evaluate(() => {
        const button = document.querySelector('.session-terminal.selected .pane-actions button:last-child')
        if (!(button instanceof HTMLButtonElement)) throw new Error('visual fixture has no pane action')
        button.disabled = true
        button.dataset.visualDisabled = 'true'
      })
      await disableTarget()
      await setAppearance(page, 'knight', 'black')

      const screenshots = []
      phase('capturing paired palette screenshots')
      for (const [identity, colorMode] of [
        ['knight', 'black'],
        ['cross', 'black']
      ]) {
        await setAppearance(page, identity, colorMode)
        await disableTarget()
        const baseline = await page.addStyleTag({ content: baselineCss })
        screenshots.push(await screenshot(page, `${colorMode}-${identity}-before.png`))
        await baseline.evaluate((element) => element.remove())
        screenshots.push(await screenshot(page, `${colorMode}-${identity}-after.png`))
      }
      for (const [identity, colorMode] of [
        ['knight', 'steel'],
        ['cross', 'brown']
      ]) {
        await setAppearance(page, identity, colorMode)
        await disableTarget()
        screenshots.push(await screenshot(page, `${colorMode}-${identity}-after.png`))
      }

      await setAppearance(page, 'knight', 'black')
      await disableTarget()
      const grayscale = await page.addStyleTag({ content: '.shell-window { filter: grayscale(1); }' })
      screenshots.push(await screenshot(page, 'black-knight-after-grayscale.png'))
      await grayscale.evaluate((element) => element.remove())

      await page.waitForSelector('.session-terminal.selected .pane-status')
      await page.waitForSelector('.status-dot.needs-you').catch(async (error) => {
        const diagnostic = await page.evaluate(async () => ({
          attention: await window.aiTerminal.listAttention(),
          dots: [...document.querySelectorAll('.status-dot')].map((dot) => ({
            classes: dot.className,
            label: dot.getAttribute('aria-label'),
            where: dot.closest('.session-row') ? 'row' : dot.closest('.session-terminal')
              ? `pane${dot.closest('.session-terminal-hidden') ? '-hidden' : ''}` : 'other',
            box: dot.getBoundingClientRect().width
          }))
        }))
        throw new Error(`needs-you dot missing: ${JSON.stringify(diagnostic)}`, { cause: error })
      })
      const hierarchyPolish = await page.evaluate(() => {
        const status = document.querySelector('.session-terminal.selected .pane-status')
        const attention = document.querySelector('.status-dot.needs-you')
        if (!(status instanceof HTMLElement) || !(attention instanceof HTMLElement)) {
          throw new Error('hierarchy polish fixture unavailable')
        }
        const statusStyle = getComputedStyle(status)
        const attentionStyle = getComputedStyle(attention)
        return {
          statusOverflow: statusStyle.overflow,
          statusTextOverflow: statusStyle.textOverflow,
          statusTruncated: status.scrollWidth > status.clientWidth,
          attentionBoxShadow: attentionStyle.boxShadow
        }
      })
      assert.equal(hierarchyPolish.statusOverflow, 'hidden')
      assert.equal(hierarchyPolish.statusTextOverflow, 'ellipsis')
      assert.equal(hierarchyPolish.statusTruncated, true)
      assert.notEqual(hierarchyPolish.attentionBoxShadow, 'none')

      const visibleSessionIds = [fixture.selectedSessionId, fixture.foreignSessionId]
      const terminalBefore = await page.evaluate(({ trackedSessionIds, visibleSessionIds }) => {
        if (!window.__aitermTest) throw new Error('terminal test hook unavailable')
        window.__epic5TerminalElements = Object.fromEntries(trackedSessionIds.map((sessionId) => {
          const element = document.querySelector(`.session-terminal[data-session-id="${sessionId}"] .xterm`)
          if (!element) throw new Error(`terminal element unavailable for ${sessionId}`)
          return [sessionId, element]
        }))
        const snapshots = window.__aitermTest.snapshots()
        return {
          snapshots: Object.fromEntries(visibleSessionIds.map((sessionId) => [sessionId, snapshots[sessionId]])),
          registeredSessionCount: Object.keys(snapshots).length
        }
      }, { trackedSessionIds: fixture.sessionIds, visibleSessionIds })
      assert.equal(terminalBefore.registeredSessionCount, 6)

      const contrasts = await page.evaluate(() => {
        const modes = ['steel', 'brown', 'dark', 'black']
        const identities = ['knight', 'cross']
        const root = document.documentElement
        const previous = { colorMode: root.dataset.colorMode, identity: root.dataset.identity }
        const output = []
        for (const colorMode of modes) {
          for (const identity of identities) {
            root.dataset.colorMode = colorMode
            root.dataset.identity = identity
            const style = getComputedStyle(root)
            output.push({
              colorMode,
              identity,
              identityColor: style.getPropertyValue('--identity').trim(),
              selected: style.getPropertyValue('--selected').trim(),
              surface: style.getPropertyValue('--surface').trim(),
              raised: style.getPropertyValue('--raised').trim(),
              muted: style.getPropertyValue('--muted').trim(),
              focus: style.getPropertyValue('--focus').trim(),
              attention: style.getPropertyValue('--attention').trim()
            })
          }
        }
        root.dataset.colorMode = previous.colorMode
        root.dataset.identity = previous.identity
        return output
      })
      const measuredContrasts = contrasts.map((item) => ({
        colorMode: item.colorMode,
        identity: item.identity,
        identityOnSelected: ratio(item.identityColor, item.selected),
        identityOnSurface: ratio(item.identityColor, item.surface),
        mutedOnSurface: ratio(item.muted, item.surface),
        focusOnSurface: ratio(item.focus, item.surface),
        attentionOnRaised: ratio(item.attention, item.raised)
      }))
      for (const measurement of measuredContrasts) {
        assert.ok(measurement.identityOnSelected >= 3, JSON.stringify(measurement))
        assert.ok(measurement.identityOnSurface >= 3, JSON.stringify(measurement))
        assert.ok(measurement.mutedOnSurface >= 4.5, JSON.stringify(measurement))
        assert.ok(measurement.focusOnSurface >= 3, JSON.stringify(measurement))
        assert.ok(measurement.attentionOnRaised >= 4.5, JSON.stringify(measurement))
      }
      phase('contrast checks passed')

      const needsButton = page.locator('.needs-you-button')
      await needsButton.focus()
      await page.keyboard.press('Enter')
      await page.waitForSelector('.needs-you-popover')
      await page.waitForFunction(() => document.activeElement?.closest('.needs-you-popover'))
      const popoverFocus = await page.evaluate(() => {
        const focused = document.activeElement
        const style = focused instanceof HTMLElement ? getComputedStyle(focused) : null
        return {
          tag: focused?.tagName,
          outlineColor: style?.outlineColor,
          outlineWidth: style?.outlineWidth,
          outlineOffset: style?.outlineOffset
        }
      })
      assert.equal(popoverFocus.tag, 'BUTTON')
      assert.equal(popoverFocus.outlineOffset, '-2px')
      assert.notEqual(popoverFocus.outlineWidth, '0px')
      const primaryPress = await pointerStates(
        page,
        page.locator('.needs-you-popover button.primary').first(),
        'black-knight-primary-active.png'
      )
      if (primaryPress.activeScreenshot) screenshots.push(primaryPress.activeScreenshot)
      assert.notEqual(primaryPress.hover.background, primaryPress.idle.background)
      assert.notEqual(primaryPress.active.background, primaryPress.hover.background)
      assert.notEqual(primaryPress.active.boxShadow, 'none')
      assert.equal(primaryPress.active.transitionDuration, '0s')
      await page.keyboard.press('Escape')
      assert.equal(await needsButton.evaluate((element) => document.activeElement === element), true)

      const menuAnchor = page.locator('.session-row.selected .row-menu-button')
      await menuAnchor.click()
      await page.waitForSelector('.popup-menu')
      await page.keyboard.press('ArrowDown')
      const menuFocus = await page.evaluate(() => {
        const focused = document.activeElement
        const style = focused instanceof HTMLElement ? getComputedStyle(focused) : null
        return {
          role: focused?.getAttribute('role'),
          outlineColor: style?.outlineColor,
          outlineWidth: style?.outlineWidth,
          outlineOffset: style?.outlineOffset
        }
      })
      assert.equal(menuFocus.role, 'menuitem')
      assert.equal(menuFocus.outlineOffset, '-2px')
      assert.notEqual(menuFocus.outlineWidth, '0px')
      await page.keyboard.press('Escape')
      assert.equal(await menuAnchor.evaluate((element) => document.activeElement === element), true)

      const paletteButton = page.getByRole('button', { name: 'Command palette' })
      await paletteButton.click()
      await page.waitForSelector('.command-palette[open]')
      await page.keyboard.press('ArrowDown')
      const paletteFocus = await page.evaluate(() => ({
        inputFocused: document.activeElement?.getAttribute('aria-label') === 'Search commands, workspaces and sessions',
        activeOption: document.querySelector('.palette-results [aria-selected="true"]')?.textContent?.trim()
      }))
      assert.equal(paletteFocus.inputFocused, true)
      assert.ok(paletteFocus.activeOption)
      screenshots.push(await screenshot(page, 'black-knight-palette-selected.png'))
      const paletteScrollbar = await page.locator('.palette-results').evaluate((element) => ({
        width: getComputedStyle(element, '::-webkit-scrollbar').width,
        thumbColor: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
        buttonHeight: getComputedStyle(element, '::-webkit-scrollbar-button').height,
        rowHeights: [...element.querySelectorAll('[role="option"]')]
          .map((option) => option.getBoundingClientRect().height)
      }))
      assert.equal(paletteScrollbar.width, '8px')
      assert.equal(paletteScrollbar.buttonHeight, '0px')
      assert.equal(new Set(paletteScrollbar.rowHeights).size, 1)
      const palettePress = await pointerStates(
        page,
        page.locator('.palette-results [role="option"][aria-selected="true"]'),
        'black-knight-palette-active.png'
      )
      if (palettePress.activeScreenshot) screenshots.push(palettePress.activeScreenshot)
      assert.notEqual(palettePress.active.background, palettePress.hover.background)
      assert.notEqual(palettePress.active.transform, palettePress.hover.transform)
      assert.ok(palettePress.active.boxShadow.includes('inset'))
      await page.keyboard.press('Escape')
      assert.equal(await paletteButton.evaluate((element) => document.activeElement === element), true)
      await settleTerminalLayout(page)

      const terminalAfter = await page.evaluate((sessionIds) => {
        if (!window.__aitermTest) throw new Error('terminal test hook unavailable after overlays')
        const snapshots = window.__aitermTest.snapshots()
        return {
          sameElements: Object.fromEntries(sessionIds.map((sessionId) => [
            sessionId,
            window.__epic5TerminalElements?.[sessionId] ===
              document.querySelector(`.session-terminal[data-session-id="${sessionId}"] .xterm`)
          ])),
          snapshots: Object.fromEntries(sessionIds.map((sessionId) => [sessionId, snapshots[sessionId]]))
        }
      }, visibleSessionIds)
      for (const sessionId of visibleSessionIds) {
        assert.equal(terminalAfter.sameElements[sessionId], true)
        assert.equal(terminalAfter.snapshots[sessionId].cols, terminalBefore.snapshots[sessionId].cols)
        assert.equal(terminalAfter.snapshots[sessionId].rows, terminalBefore.snapshots[sessionId].rows)
        assert.equal(terminalAfter.snapshots[sessionId].refits, terminalBefore.snapshots[sessionId].refits)
      }
      phase('overlay keyboard and terminal-stability checks passed')

      const selectedButton = page.locator('.session-row.selected > button:first-child')
      await selectedButton.focus()
      const selectionFocus = await selectedButton.evaluate((element) => {
        const style = getComputedStyle(element)
        const focusRing = getComputedStyle(element, '::after')
        return {
          borderLeftColor: style.borderLeftColor,
          outlineColor: style.outlineColor,
          outlineStyle: style.outlineStyle,
          outlineOffset: style.outlineOffset,
          focusRingBorderColor: focusRing.borderLeftColor,
          focusRingBorderWidth: focusRing.borderLeftWidth,
          title: element.title
        }
      })
      assert.equal(selectionFocus.outlineStyle, 'none')
      assert.equal(selectionFocus.focusRingBorderWidth, '2px')
      assert.notEqual(selectionFocus.focusRingBorderColor, selectionFocus.borderLeftColor)
      assert.ok(selectionFocus.title.length > 0)
      screenshots.push(await screenshot(page, 'black-knight-keyboard-focus.png'))
      const grayscaleFocus = await page.addStyleTag({ content: '.shell-window { filter: grayscale(1); }' })
      screenshots.push(await screenshot(page, 'black-knight-keyboard-focus-grayscale.png'))
      await grayscaleFocus.evaluate((element) => element.remove())

      const hoverTarget = page.locator(
        '.session-terminal.selected .pane-actions button[aria-pressed="false"]:not(:disabled)'
      ).first()
      const pointer = await pointerStates(page, hoverTarget, 'black-knight-active-control.png')
      if (pointer.activeScreenshot) screenshots.push(pointer.activeScreenshot)
      assert.notEqual(pointer.hover.background, pointer.idle.background)
      assert.notEqual(pointer.active.boxShadow, 'none')
      assert.equal(pointer.active.transitionDuration, '0s')

      const selectedTogglePress = await pointerStates(
        page,
        page.locator('.session-terminal.selected .pane-actions button[aria-pressed="true"]'),
        'black-knight-active-selected-control.png'
      )
      if (selectedTogglePress.activeScreenshot) screenshots.push(selectedTogglePress.activeScreenshot)
      assert.notEqual(selectedTogglePress.active.boxShadow, selectedTogglePress.hover.boxShadow)
      assert.equal(selectedTogglePress.active.background, selectedTogglePress.hover.background)

      const selectedRowPress = await pointerStates(page, selectedButton)
      assert.equal(selectedRowPress.active.activePseudo, true, JSON.stringify(selectedRowPress))
      assert.notEqual(
        selectedRowPress.active.boxShadow,
        selectedRowPress.hover.boxShadow,
        JSON.stringify(selectedRowPress)
      )
      assert.equal(selectedRowPress.active.borderLeftColor, selectionFocus.borderLeftColor)

      const disabledAction = await page.evaluate(() => {
        const button = document.querySelector('button[data-visual-disabled="true"]')
        if (!(button instanceof HTMLButtonElement)) throw new Error('disabled fixture button missing')
        let calls = 0
        button.addEventListener('click', () => { calls += 1 })
        const style = getComputedStyle(button)
        button.click()
        return { calls, disabled: button.disabled, color: style.color, opacity: style.opacity }
      })
      assert.deepEqual({ calls: disabledAction.calls, disabled: disabledAction.disabled }, { calls: 0, disabled: true })
      assert.equal(disabledAction.opacity, '0.55')

      await page.emulateMedia({ reducedMotion: 'reduce' })
      const reducedMotion = await page.evaluate(() => {
        const button = document.querySelector('.pane-actions button')
        const terminal = document.querySelector('.xterm-screen')
        const attention = document.querySelector('.status-dot.needs-you')
        return {
          buttonTransition: button ? getComputedStyle(button).transitionDuration : null,
          terminalTransition: terminal ? getComputedStyle(terminal).transitionDuration : null,
          attentionTransition: attention ? getComputedStyle(attention).transitionDuration : null
        }
      })
      assert.equal(reducedMotion.buttonTransition, '0s')
      assert.equal(reducedMotion.terminalTransition, '0s')
      assert.equal(reducedMotion.attentionTransition, '0s')
      await page.emulateMedia({ reducedMotion: 'no-preference' })
      const normalTransitionMs = await hoverTarget.evaluate((element) => {
        const values = getComputedStyle(element).transitionDuration.split(',').map((value) => value.trim())
        return Math.max(...values.map((value) => value.endsWith('ms') ? Number.parseFloat(value) : Number.parseFloat(value) * 1000))
      })
      assert.ok(normalTransitionMs <= 100)

      const xtermFocus = await selectedTextarea.evaluate((element) => {
        element.focus()
        const style = getComputedStyle(element)
        return { focusVisible: element.matches(':focus-visible'), outlineStyle: style.outlineStyle }
      })
      assert.equal(xtermFocus.outlineStyle, 'none')

      await selectedTextarea.focus()
      await page.keyboard.press('Control+Shift+A')
      await page.waitForSelector('.session-terminal.selected .xterm-selection div')
      const selectedText = await page.evaluate(() => ({
        selectionRects: document.querySelectorAll('.session-terminal.selected .xterm-selection div').length,
        selectedTerminal: document.querySelector('.session-terminal.selected')?.getAttribute('data-session-id')
      }))
      assert.ok(selectedText.selectionRects > 0)
      assert.equal(selectedText.selectedTerminal, fixture.selectedSessionId)
      screenshots.push(await screenshot(page, 'black-knight-selected-text.png'))
      await settleTerminalLayout(page)
      const selectedTextStability = await page.evaluate((sessionIds) => {
        if (!window.__aitermTest) throw new Error('terminal test hook unavailable after text selection')
        const snapshots = window.__aitermTest.snapshots()
        return {
          selectionRects: document.querySelectorAll(
            '.session-terminal.selected .xterm-selection div'
          ).length,
          sameElements: Object.fromEntries(sessionIds.map((sessionId) => [
            sessionId,
            window.__epic5TerminalElements?.[sessionId] ===
              document.querySelector(`.session-terminal[data-session-id="${sessionId}"] .xterm`)
          ])),
          snapshots: Object.fromEntries(sessionIds.map((sessionId) => [sessionId, snapshots[sessionId]]))
        }
      }, visibleSessionIds)
      assert.ok(selectedTextStability.selectionRects > 0)
      for (const sessionId of visibleSessionIds) {
        assert.equal(selectedTextStability.sameElements[sessionId], true)
        assert.equal(selectedTextStability.snapshots[sessionId].cols, terminalBefore.snapshots[sessionId].cols)
        assert.equal(selectedTextStability.snapshots[sessionId].rows, terminalBefore.snapshots[sessionId].rows)
        assert.equal(selectedTextStability.snapshots[sessionId].refits, terminalBefore.snapshots[sessionId].refits)
      }

      await selectedButton.focus()

      await settleTerminalLayout(page)
      const chromeFocusStability = await page.evaluate((sessionIds) => {
        if (!window.__aitermTest) throw new Error('terminal test hook unavailable after chrome focus checks')
        const snapshots = window.__aitermTest.snapshots()
        return {
          selectionRects: document.querySelectorAll(
            `.session-terminal[data-session-id="${sessionIds[0]}"] .xterm-selection div`
          ).length,
          sameElements: Object.fromEntries(sessionIds.map((sessionId) => [
            sessionId,
            window.__epic5TerminalElements?.[sessionId] ===
              document.querySelector(`.session-terminal[data-session-id="${sessionId}"] .xterm`)
          ])),
          snapshots: Object.fromEntries(sessionIds.map((sessionId) => [sessionId, snapshots[sessionId]]))
        }
      }, visibleSessionIds)
      assert.ok(chromeFocusStability.selectionRects > 0)
      for (const sessionId of visibleSessionIds) {
        assert.equal(chromeFocusStability.sameElements[sessionId], true)
        assert.equal(chromeFocusStability.snapshots[sessionId].cols, terminalBefore.snapshots[sessionId].cols)
        assert.equal(chromeFocusStability.snapshots[sessionId].rows, terminalBefore.snapshots[sessionId].rows)
        assert.equal(chromeFocusStability.snapshots[sessionId].refits, terminalBefore.snapshots[sessionId].refits)
      }

      const paneSwitchBefore = chromeFocusStability

      await page.locator(
        `.session-terminal[data-session-id="${fixture.foreignSessionId}"] .terminal-surface`
      ).click({ position: { x: 16, y: 16 } })
      await page.waitForFunction((sessionId) =>
        document.querySelector(`.session-terminal[data-session-id="${sessionId}"]`)?.classList.contains('selected'),
      fixture.foreignSessionId)
      const pointerSelectedSessionId = await page.locator('.session-terminal.selected')
        .getAttribute('data-session-id')
      assert.equal(pointerSelectedSessionId, fixture.foreignSessionId)

      await page.keyboard.press('Control+Tab')
      await page.waitForFunction((sessionId) =>
        document.querySelector(`.session-terminal[data-session-id="${sessionId}"]`)?.classList.contains('selected'),
      fixture.selectedSessionId)
      const keyboardPaneSessionId = await page.locator('.session-terminal.selected')
        .getAttribute('data-session-id')
      assert.equal(keyboardPaneSessionId, fixture.selectedSessionId)
      await settleTerminalLayout(page)
      const paneSwitchStability = await page.evaluate((sessionIds) => {
        if (!window.__aitermTest) throw new Error('terminal test hook unavailable after pane switching')
        const snapshots = window.__aitermTest.snapshots()
        return {
          selectionRects: document.querySelectorAll(
            `.session-terminal[data-session-id="${sessionIds[0]}"] .xterm-selection div`
          ).length,
          sameElements: Object.fromEntries(sessionIds.map((sessionId) => [
            sessionId,
            window.__epic5TerminalElements?.[sessionId] ===
              document.querySelector(`.session-terminal[data-session-id="${sessionId}"] .xterm`)
          ])),
          snapshots: Object.fromEntries(sessionIds.map((sessionId) => [sessionId, snapshots[sessionId]]))
        }
      }, visibleSessionIds)
      assert.ok(paneSwitchStability.selectionRects > 0)
      for (const sessionId of visibleSessionIds) {
        assert.equal(paneSwitchStability.sameElements[sessionId], true)
        assert.equal(paneSwitchStability.snapshots[sessionId].cols, paneSwitchBefore.snapshots[sessionId].cols)
        assert.equal(paneSwitchStability.snapshots[sessionId].rows, paneSwitchBefore.snapshots[sessionId].rows)
        assert.equal(paneSwitchStability.snapshots[sessionId].refits, paneSwitchBefore.snapshots[sessionId].refits)
      }

      await page.locator(
        `.session-terminal[data-session-id="${fixture.selectedSessionId}"] .xterm-screen`
      ).click({ position: { x: 12, y: 12 } })
      await page.waitForFunction((sessionId) => !document.querySelector(
        `.session-terminal[data-session-id="${sessionId}"] .xterm-selection div`
      ), fixture.selectedSessionId)

      await page.keyboard.press('Control+Shift+ArrowDown')
      await page.waitForSelector(
        `.session-row.selected button[data-session-id="${fixture.sessionIds[1]}"]`
      )
      const keyboardNextSessionId = await page.locator('.session-terminal.selected')
        .getAttribute('data-session-id')
      assert.equal(keyboardNextSessionId, fixture.sessionIds[1])
      await page.keyboard.press('Control+Shift+ArrowUp')
      await page.waitForSelector(
        `.session-row.selected button[data-session-id="${fixture.selectedSessionId}"]`
      )

      await page.keyboard.press('Control+Shift+Z')
      await page.waitForSelector('.workspace-body.focus-mode')
      assert.equal(await page.locator('.workspace-sidebar').count(), 0)
      await page.keyboard.press('Control+Shift+Z')
      await page.waitForSelector('.workspace-body:not(.focus-mode) .workspace-sidebar')
      await settleTerminalLayout(page)

      await page.keyboard.press('Control+Shift+Enter')
      await page.waitForSelector('.session-area:not(.split)')
      await settleTerminalLayout(page)
      const singlePane = await page.evaluate(() => {
        const selected = document.querySelector('.session-area:not(.split) .session-terminal.selected')
        const style = selected instanceof HTMLElement ? getComputedStyle(selected) : null
        return {
          visiblePanes: document.querySelectorAll(
            '.session-terminal:not(.session-terminal-hidden)'
          ).length,
          outlineColor: style?.outlineColor,
          inactiveHeadingCount: document.querySelectorAll(
            '.session-area:not(.split) .session-terminal:not(.selected):not(.session-terminal-hidden) .pane-heading strong'
          ).length
        }
      })
      assert.equal(singlePane.visiblePanes, 1)
      assert.equal(singlePane.outlineColor, 'rgba(0, 0, 0, 0)')
      assert.equal(singlePane.inactiveHeadingCount, 0)
      screenshots.push(await screenshot(page, 'black-knight-single-pane.png'))

      await page.keyboard.press('Control+Shift+Enter')
      await page.waitForSelector('.command-palette[open]')
      await page.locator('.palette-results [role="option"]')
        .filter({ hasText: 'Reference audit' })
        .first()
        .click()
      await page.waitForSelector('.session-area.split')
      await settleTerminalLayout(page)

      const navigation = await page.evaluate(({ sessionIds, visibleSessionIds }) => {
        if (!window.__aitermTest) throw new Error('terminal test hook unavailable after navigation')
        const snapshots = window.__aitermTest.snapshots()
        return {
          sameElements: Object.fromEntries(sessionIds.map((sessionId) => [
            sessionId,
            window.__epic5TerminalElements?.[sessionId] ===
              document.querySelector(`.session-terminal[data-session-id="${sessionId}"] .xterm`)
          ])),
          restoredSnapshots: Object.fromEntries(
            visibleSessionIds.map((sessionId) => [sessionId, snapshots[sessionId]])
          )
        }
      }, { sessionIds: fixture.sessionIds, visibleSessionIds })
      for (const sessionId of fixture.sessionIds) assert.equal(navigation.sameElements[sessionId], true)
      for (const sessionId of visibleSessionIds) {
        assert.equal(navigation.restoredSnapshots[sessionId].cols, terminalBefore.snapshots[sessionId].cols)
        assert.equal(navigation.restoredSnapshots[sessionId].rows, terminalBefore.snapshots[sessionId].rows)
      }
      phase('pointer, keyboard, single-pane, focus-mode and reduced-motion checks passed')

      await setContentSize(application, page, 900, 600)
      await disableTarget()
      await settleTerminalLayout(page)
      const narrowBefore = await page.evaluate(() => {
        const sessionId = document.querySelector('.session-terminal.selected')?.getAttribute('data-session-id')
        if (!sessionId || !window.__aitermTest) throw new Error('selected narrow terminal unavailable')
        return { sessionId, snapshot: window.__aitermTest.snapshot(sessionId) }
      })
      await selectedButton.focus()
      await settleTerminalLayout(page)
      const narrowAfter = await page.evaluate(() => {
        const sessionId = document.querySelector('.session-terminal.selected')?.getAttribute('data-session-id')
        if (!sessionId || !window.__aitermTest) throw new Error('selected narrow terminal unavailable after focus')
        return { sessionId, snapshot: window.__aitermTest.snapshot(sessionId) }
      })
      assert.equal(narrowAfter.sessionId, narrowBefore.sessionId)
      assert.equal(narrowAfter.snapshot.cols, narrowBefore.snapshot.cols)
      assert.equal(narrowAfter.snapshot.rows, narrowBefore.snapshot.rows)
      assert.equal(narrowAfter.snapshot.refits, narrowBefore.snapshot.refits)
      const narrowLabels = await page.evaluate((longSessionId) => {
        const row = document.querySelector(`.session-row button[data-session-id="${longSessionId}"]`)
        const name = row?.querySelector('.session-name')
        const paneName = document.querySelector(
          `.session-terminal[data-session-id="${longSessionId}"]:not(.session-terminal-hidden) .pane-heading strong`
        )
        const actions = document.querySelector('.session-terminal.selected .pane-actions')
        const heading = document.querySelector('.session-terminal.selected .pane-heading')
        const actionRect = actions?.getBoundingClientRect()
        const headingRect = heading?.getBoundingClientRect()
        return {
          rowTitle: row?.getAttribute('title'),
          rowTruncated: !!name && name.scrollWidth > name.clientWidth,
          paneTitle: paneName?.getAttribute('title'),
          controlsInsideHeading: !!actionRect && !!headingRect && actionRect.right <= headingRect.right
        }
      }, fixture.longSessionId)
      assert.ok(narrowLabels.rowTitle?.includes('Reference audit'))
      assert.equal(narrowLabels.rowTruncated, true)
      assert.ok(narrowLabels.paneTitle?.includes('Reference audit'))
      assert.equal(narrowLabels.controlsInsideHeading, true)
      screenshots.push(await screenshot(page, 'black-knight-900x600.png'))
      phase('narrow layout checks passed')

      await setContentSize(application, page, 1440, 900)
      const persistedSteel = await page.evaluate(async () => {
        await window.aiTerminal.putSettings('appearance', { identity: 'knight', colorMode: 'steel', terminalFontSize: 14 })
        return (await window.aiTerminal.getSettings()).appearance
      })
      assert.equal(persistedSteel.colorMode, 'steel')
      await setAppearance(page, 'knight', 'black')

      // Epic 14.1 AC5: the observed working/idle mark and word, measured where they render, in both
      // states, across the four palettes and both identities, with selection and focus overlapping.
      phase('driving two live sessions into Working and Idle')
      await runControlCli(roots, fixture.selectedSessionId, 'withdraw', 'epic5-visual')
      await page.waitForFunction(() =>
        document.querySelector('.needs-you-button')?.getAttribute('data-has-items') === 'false')
      await runControlCli(
        roots,
        fixture.selectedSessionId,
        'send',
        "for index in $(seq 1 12000); do printf 'EPIC14-WORKING\\n'; sleep 0.05; done",
        '--submit'
      )
      await page.waitForFunction(({ working, idle }) => {
        const words = window.__bmnActivity?.words() ?? {}
        return words[working] === 'Working' && words[idle] === 'Idle'
      }, { working: fixture.selectedSessionId, idle: fixture.foreignSessionId })
      phase('both observed states visible')

      const readActivityPaint = () => page.evaluate(({ working, idle }) => {
        // The dot's own background is transparent while it is a ring, so the boundary is measured
        // against the first ancestor that actually paints.
        const opaque = (element) => {
          for (let node = element; node; node = node.parentElement) {
            const background = getComputedStyle(node).backgroundColor
            const parts = background.match(/[\d.]+/g)
            if (parts && (parts.length < 4 || Number(parts[3]) > 0.5)) return background
          }
          return getComputedStyle(document.documentElement).backgroundColor
        }
        const inkOf = (mark) => {
          const style = getComputedStyle(mark)
          return {
            ink: style.borderTopWidth === '0px' ? style.backgroundColor : style.borderTopColor,
            borderWidth: style.borderTopWidth,
            width: style.width,
            height: style.height
          }
        }
        // A word only the screen reader can reach is not a word the owner can see, so visibility is measured.
        const shown = (element) => element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden'
        const readRow = (sessionId) => {
          const row = document.querySelector(`.session-row button[data-session-id="${sessionId}"]`)
          const mark = row?.querySelector('.status-dot')
          const state = row?.querySelector('.session-state')
          if (!(row instanceof HTMLElement) || !(mark instanceof HTMLElement) || !(state instanceof HTMLElement)) {
            throw new Error(`activity row unavailable for ${sessionId}`)
          }
          return {
            ...inkOf(mark),
            marks: mark.className,
            word: state.textContent?.trim() ?? '',
            wordShown: shown(state),
            wordInk: getComputedStyle(state).color,
            wordBehind: opaque(state),
            rowTitle: row.getAttribute('title'),
            selected: !!row.closest('.session-row.selected'),
            behind: opaque(row)
          }
        }
        const readPane = (sessionId) => {
          const pane = document.querySelector(`.session-terminal[data-session-id="${sessionId}"]`)
          const mark = pane?.querySelector('.pane-heading .status-dot')
          const status = pane?.querySelector('.pane-status')
          const state = pane?.querySelector('.pane-heading .pane-state')
          if (!(mark instanceof HTMLElement) || !(status instanceof HTMLElement) || !(state instanceof HTMLElement)) {
            throw new Error(`activity pane unavailable for ${sessionId}`)
          }
          return {
            ...inkOf(mark),
            marks: mark.className,
            word: state.textContent?.trim() ?? '',
            wordShown: shown(state),
            markShown: shown(mark),
            wordInk: getComputedStyle(state).color,
            behind: opaque(status)
          }
        }
        const root = getComputedStyle(document.documentElement)
        return {
          workingRow: readRow(working),
          idleRow: readRow(idle),
          workingPane: readPane(working),
          idlePane: readPane(idle),
          // `.status-dot.idle` means Not started; no fixture session is stopped, so the token is read directly.
          notStartedInk: root.getPropertyValue('--faint').trim(),
          notStartedBorderWidth: '1px'
        }
      }, { working: fixture.selectedSessionId, idle: fixture.foreignSessionId })

      // The mark is measured on the selected, focused row, so selection, focus and the mark overlap.
      await page.click(`.session-row button[data-session-id="${fixture.selectedSessionId}"]`)
      await page.waitForFunction((sessionId) => !!document.querySelector(
        `.session-row.selected button[data-session-id="${sessionId}"]`), fixture.selectedSessionId)

      const settledActivityWords = () => page.waitForFunction(({ working, idle }) => {
        const words = window.__bmnActivity?.words() ?? {}
        return words[working] === 'Working' && words[idle] === 'Idle'
      }, { working: fixture.selectedSessionId, idle: fixture.foreignSessionId })

      const activityMeasurements = []
      for (const [identity, colorMode] of [
        ['knight', 'black'], ['cross', 'black'],
        ['knight', 'steel'], ['cross', 'steel'],
        ['knight', 'brown'], ['cross', 'brown'],
        ['knight', 'dark'], ['cross', 'dark']
      ]) {
        await setAppearance(page, identity, colorMode)
        await disableTarget()
        for (const [width, height] of [[1440, 900], [900, 600]]) {
          await setContentSize(application, page, width, height)
          await settleTerminalLayout(page)
          // A resize refits every terminal, and the shells redraw, so the silent one is briefly working.
          // Focusing the row can refit again, so the pair is re-checked right before the paint is read and
          // the read is repeated if the idle session was mid-redraw.
          let paint
          let capture
          for (let attempt = 0; ; attempt += 1) {
            await settledActivityWords()
            // The selected row also carries focus here, so the mark is measured with every overlap at once.
            await page.focus(`.session-row.selected button[data-session-id="${fixture.selectedSessionId}"]`)
            paint = await readActivityPaint()
            // The screenshot is taken inside the settled window and the words re-read after it, so the
            // evidence shows the states that were measured rather than a shell mid-redraw.
            capture = await screenshot(
              page,
              `${colorMode}-${identity}-${width}x${height}-working-idle.png`,
              activityEvidenceDirectory
            )
            const stillSettled = await page.evaluate(({ working, idle }) => {
              const words = window.__bmnActivity?.words() ?? {}
              return words[working] === 'Working' && words[idle] === 'Idle'
            }, { working: fixture.selectedSessionId, idle: fixture.foreignSessionId })
            if (stillSettled &&
              paint.idleRow.marks.includes('running-idle') &&
              !paint.workingRow.marks.includes('running-idle')) break
            if (attempt >= 5) throw new Error(`the two observed states never settled: ${JSON.stringify(paint)}`)
          }
          const measurement = {
            identity,
            colorMode,
            width,
            height,
            words: {
              workingRow: paint.workingRow.word,
              idleRow: paint.idleRow.word,
              workingPane: paint.workingPane.word,
              idlePane: paint.idlePane.word
            },
            // Meaningful boundaries: the mark against whatever is painted behind it.
            workingRowMark: ratio(paint.workingRow.ink, paint.workingRow.behind),
            idleRowMark: ratio(paint.idleRow.ink, paint.idleRow.behind),
            workingPaneMark: ratio(paint.workingPane.ink, paint.workingPane.behind),
            idlePaneMark: ratio(paint.idlePane.ink, paint.idlePane.behind),
            // Words, measured where they are painted, in all three of AC3's places.
            workingPaneWord: ratio(paint.workingPane.wordInk, paint.workingPane.behind),
            idlePaneWord: ratio(paint.idlePane.wordInk, paint.idlePane.behind),
            workingRowWord: ratio(paint.workingRow.wordInk, paint.workingRow.wordBehind),
            idleRowWord: ratio(paint.idleRow.wordInk, paint.idleRow.wordBehind),
            shown: {
              workingRowWord: paint.workingRow.wordShown,
              idleRowWord: paint.idleRow.wordShown,
              workingPaneWord: paint.workingPane.wordShown,
              idlePaneWord: paint.idlePane.wordShown,
              workingPaneMark: paint.workingPane.markShown,
              idlePaneMark: paint.idlePane.markShown
            },
            // Recorded, not gated: the live-idle ring is told from Not started by geometry and hue,
            // which is Fable's call for a 7px mark, not by a contrast ratio between two marks.
            idleMarkAgainstNotStarted: ratio(paint.idleRow.ink, paint.notStartedInk),
            geometry: {
              workingBorderWidth: paint.workingRow.borderWidth,
              idleBorderWidth: paint.idleRow.borderWidth,
              notStartedBorderWidth: paint.notStartedBorderWidth,
              markWidth: paint.idleRow.width
            },
            marks: { working: paint.workingRow.marks, idle: paint.idleRow.marks },
            selectionOverlap: paint.workingRow.selected,
            rowTitles: { working: paint.workingRow.rowTitle, idle: paint.idleRow.rowTitle }
          }
          activityMeasurements.push(measurement)
          screenshots.push(capture)
        }
      }
      for (const measurement of activityMeasurements) {
        const detail = JSON.stringify(measurement)
        assert.ok(measurement.workingRowMark >= 3, detail)
        assert.ok(measurement.idleRowMark >= 3, detail)
        assert.ok(measurement.workingPaneMark >= 3, detail)
        assert.ok(measurement.idlePaneMark >= 3, detail)
        assert.ok(measurement.workingPaneWord >= 4.5, detail)
        assert.ok(measurement.idlePaneWord >= 4.5, detail)
        assert.ok(measurement.workingRowWord >= 4.5, detail)
        assert.ok(measurement.idleRowWord >= 4.5, detail)
        // AC3: filled versus a 2px ring, and never the 1px ring that means Not started.
        assert.equal(measurement.geometry.workingBorderWidth, '0px', detail)
        assert.equal(measurement.geometry.idleBorderWidth, '2px', detail)
        assert.equal(measurement.geometry.markWidth, '7px', detail)
        assert.ok(measurement.marks.working.includes('running'), detail)
        assert.ok(!measurement.marks.working.includes('running-idle'), detail)
        assert.ok(measurement.marks.idle.includes('running-idle'), detail)
        // AC5: no information depends on the mark alone — every mark is named, visibly, where it is shown,
        // at 900x600 as well as 1440x900.
        assert.equal(measurement.words.workingRow, 'Working', detail)
        assert.equal(measurement.words.idleRow, 'Idle', detail)
        assert.equal(measurement.words.workingPane, 'Working', detail)
        assert.equal(measurement.words.idlePane, 'Idle', detail)
        for (const [where, visible] of Object.entries(measurement.shown)) {
          assert.equal(visible, true, `${where} is not visible: ${detail}`)
        }
        assert.ok(measurement.rowTitles.working?.includes('· Working ·'), detail)
        assert.ok(measurement.rowTitles.idle?.includes('· Idle ·'), detail)
        // The selected row carries the mark under selection and focus at the same time.
        assert.equal(measurement.selectionOverlap, true, detail)
      }
      // Below 800 px the sidebar collapses to a rail of marks: the name, the path and the observed word all
      // live in the row tooltip, and nothing may spill out of the 64 px column.
      await setContentSize(application, page, 780, 600)
      await settleTerminalLayout(page)
      const railRow = await page.evaluate((sessionId) => {
        const row = document.querySelector(`.session-row button[data-session-id="${sessionId}"]`)
        const detail = row?.querySelector('.session-detail')
        const mark = row?.querySelector('.status-dot')
        if (!(row instanceof HTMLElement) || !(detail instanceof HTMLElement) || !(mark instanceof HTMLElement)) {
          throw new Error('rail row unavailable')
        }
        const sidebar = row.closest('.workspace-sidebar')
        return {
          detailShown: detail.getClientRects().length > 0,
          markShown: mark.getClientRects().length > 0,
          title: row.getAttribute('title'),
          overflows: !!sidebar && row.getBoundingClientRect().right > sidebar.getBoundingClientRect().right + 1
        }
      }, fixture.selectedSessionId)
      screenshots.push(await screenshot(page, 'black-knight-780x600-rail.png', activityEvidenceDirectory))
      const railDetail = JSON.stringify(railRow)
      assert.equal(railRow.markShown, true, railDetail)
      assert.equal(railRow.detailShown, false, railDetail)
      assert.equal(railRow.overflows, false, railDetail)
      assert.ok(railRow.title?.includes(' · Working · ') || railRow.title?.includes(' · Idle · '), railDetail)

      await setContentSize(application, page, 1440, 900)
      await setAppearance(page, 'knight', 'black')
      await disableTarget()
      // That last resize refit the terminals again, so the silent session is briefly working.
      await page.waitForFunction(({ working, idle }) => {
        const words = window.__bmnActivity?.words() ?? {}
        return words[working] === 'Working' && words[idle] === 'Idle'
      }, { working: fixture.selectedSessionId, idle: fixture.foreignSessionId })
      // AC3: the state word joins the palette row's context, so typing it filters with no new control.
      const activityNames = await page.evaluate(({ working, idle }) => {
        const nameOf = (sessionId) => document
          .querySelector(`.session-row button[data-session-id="${sessionId}"] .session-name`)
          ?.textContent?.trim()
        const names = { working: nameOf(working), idle: nameOf(idle) }
        if (!names.working || !names.idle) throw new Error('activity fixture names unavailable')
        return names
      }, { working: fixture.selectedSessionId, idle: fixture.foreignSessionId })
      await paletteButton.click()
      await page.waitForSelector('.command-palette[open]')
      const paletteSessionNames = async (query) => {
        await page.fill('.command-palette input', query)
        await page.waitForFunction((text) =>
          document.querySelector('.command-palette input')?.value === text, query)
        return page.evaluate(() => [...document.querySelectorAll('.palette-results [role="option"]')]
          .map((option) => option.textContent?.trim() ?? ''))
      }
      // AC3: the palette session row carries the mark as well as the word.
      const paletteMarks = async (query) => {
        await page.fill('.command-palette input', query)
        await page.waitForFunction((text) =>
          document.querySelector('.command-palette input')?.value === text, query)
        return page.evaluate(() => [...document.querySelectorAll('.palette-results [role="option"]')]
          .map((option) => {
            const mark = option.querySelector('.status-dot')
            return {
              label: option.querySelector('.label')?.textContent?.trim() ?? '',
              mark: mark?.className ?? null,
              markShown: !!mark && mark.getClientRects().length > 0
            }
          }))
      }
      const activityPaletteFiltering = {
        workingName: activityNames.working,
        idleName: activityNames.idle,
        working: await paletteSessionNames('working'),
        idle: await paletteSessionNames('idle'),
        workingMarks: await paletteMarks('working'),
        idleMarks: await paletteMarks('idle')
      }
      screenshots.push(await screenshot(page, 'black-knight-palette-idle-filter.png', activityEvidenceDirectory))
      const filterDetail = JSON.stringify(activityPaletteFiltering)
      assert.ok(
        activityPaletteFiltering.working.some((text) => text.includes(activityNames.working)),
        filterDetail
      )
      assert.ok(
        !activityPaletteFiltering.working.some((text) => text.includes(activityNames.idle)),
        filterDetail
      )
      assert.ok(
        activityPaletteFiltering.idle.some((text) => text.includes(activityNames.idle)),
        filterDetail
      )
      assert.ok(
        !activityPaletteFiltering.idle.some((text) => text.includes(activityNames.working)),
        filterDetail
      )
      for (const [state, expected] of [['workingMarks', 'running'], ['idleMarks', 'running-idle']]) {
        const rows = activityPaletteFiltering[state]
        assert.ok(rows.length > 0, filterDetail)
        for (const row of rows) {
          assert.ok(row.mark?.includes(expected), `${state}: ${JSON.stringify(row)}`)
          assert.equal(row.markShown, true, `${state}: ${JSON.stringify(row)}`)
        }
      }
      assert.ok(
        activityPaletteFiltering.workingMarks.every((row) => !row.mark?.includes('running-idle')),
        filterDetail
      )
      await page.keyboard.press('Escape')

      // AC3: an open request still outranks activity, in all three places at once.
      await runControlCli(
        roots, fixture.selectedSessionId, 'ask', 'epic14-precedence', 'Which branch?', '--kind', 'question'
      )
      await page.waitForFunction(() =>
        document.querySelector('.needs-you-button')?.getAttribute('data-has-items') === 'true')
      const precedence = await page.evaluate(async (sessionId) => {
        const wait = async (check) => {
          for (let attempt = 0; attempt < 80; attempt += 1) {
            if (check()) return true
            await new Promise((resolve) => setTimeout(resolve, 50))
          }
          return false
        }
        const rowWord = () => document
          .querySelector(`.session-row button[data-session-id="${sessionId}"] .session-state`)?.textContent?.trim()
        const settled = await wait(() => rowWord() === 'Waiting for your response')
        const row = document.querySelector(`.session-row button[data-session-id="${sessionId}"]`)
        const pane = document.querySelector(`.session-terminal[data-session-id="${sessionId}"] .pane-heading`)
        return {
          settled,
          rowWord: rowWord(),
          rowMark: row?.querySelector('.status-dot')?.className ?? null,
          paneWord: pane?.querySelector('.pane-state')?.textContent?.trim() ?? null,
          paneMark: pane?.querySelector('.status-dot')?.className ?? null
        }
      }, fixture.selectedSessionId)
      const precedenceDetail = JSON.stringify(precedence)
      assert.equal(precedence.settled, true, precedenceDetail)
      assert.equal(precedence.rowWord, 'Waiting for your response', precedenceDetail)
      assert.ok(precedence.rowMark?.includes('needs-you'), precedenceDetail)
      assert.equal(precedence.paneWord, 'Waiting for your response', precedenceDetail)
      assert.ok(precedence.paneMark?.includes('needs-you'), precedenceDetail)
      screenshots.push(await screenshot(
        page, 'black-knight-attention-outranks-activity.png', activityEvidenceDirectory
      ))

      // 14.2 AC3: the popover says what opened each request, in plain words beside the row content.
      await page.locator('.needs-you-button').click()
      await page.waitForSelector('.needs-you-popover')
      const provenanceLines = await page.evaluate(() => [...document.querySelectorAll('.needs-you-popover')]
        .flatMap((popover) => [...popover.querySelectorAll('.provenance')])
        .map((line) => line.textContent?.trim() ?? ''))
      screenshots.push(await screenshot(
        page, 'black-knight-needs-you-provenance.png', activityEvidenceDirectory
      ))
      await page.keyboard.press('Escape')
      assert.ok(
        provenanceLines.some((line) => line.startsWith('from bmn ask')),
        JSON.stringify(provenanceLines)
      )
      await runControlCli(roots, fixture.selectedSessionId, 'withdraw', 'epic14-precedence')

      // The Hook events dialog is not screenshotted here: `bmn hook` deliberately ignores a call that is
      // not the agent's own foreground process, so a shell in this fixture cannot produce an event. The
      // dialog is driven end to end, with real events and its rendered rows, by the Electron self-test.
      phase('observed activity mark and word checks passed')

      // ---------- Epic 11: workspace identity markers ----------
      phase('workspace identity markers')
      await setContentSize(application, page, 1440, 900)
      await setAppearance(page, 'knight', 'black')
      await settleTerminalLayout(page)

      // The cross-workspace split is already on screen: the selected pane belongs to the primary
      // workspace and the foreign pane to the second one, so the two panes test AC2 directly.
      const markerGeometryBefore = await page.evaluate(({ selectedSessionId, foreignSessionId }) => {
        const pane = (sessionId) => document.querySelector(`.session-terminal[data-session-id="${sessionId}"]`)
        const grid = (sessionId) => {
          const surface = pane(sessionId)?.querySelector('.xterm-screen')
          const box = surface?.getBoundingClientRect()
          return box ? { width: Math.round(box.width), height: Math.round(box.height) } : null
        }
        const heading = (sessionId) => {
          const box = pane(sessionId)?.querySelector('.pane-heading')?.getBoundingClientRect()
          return box ? Math.round(box.height) : null
        }
        const sidebarRow = document.querySelector('.workspace-row > button:first-child')?.getBoundingClientRect()
        return {
          selectedGrid: grid(selectedSessionId),
          foreignGrid: grid(foreignSessionId),
          selectedHeading: heading(selectedSessionId),
          foreignHeading: heading(foreignSessionId),
          sidebarRowHeight: sidebarRow ? Math.round(sidebarRow.height) : null,
          markerCount: document.querySelectorAll('.workspace-marker').length
        }
      }, { selectedSessionId: fixture.selectedSessionId, foreignSessionId: fixture.foreignSessionId })
      assert.equal(markerGeometryBefore.markerCount, 0, JSON.stringify(markerGeometryBefore))

      // The owner's real route: the workspace's own menu. A direct store write would change the
      // database without redrawing anything, because the renderer holds its workspaces in state.
      const setMarker = async (workspaceName, label, marker) => {
        await page.click(`[aria-label="Actions for ${workspaceName}"]`)
        await page.waitForSelector('.popup-menu [role="group"][aria-label="Marker"]')
        await page.locator('.popup-menu [role="group"][aria-label="Marker"] [role="menuitemradio"]')
          .filter({ hasText: new RegExp(`^${label}$`) })
          .click()
        await page.waitForFunction(() => !document.querySelector('.popup-menu'))
        await page.waitForFunction(({ workspaceName, marker }) => {
          const group = document.querySelector(`.workspace-group[aria-label="${workspaceName}"]`)
          const shown = group?.querySelector('.workspace-row .workspace-marker')?.dataset.marker ?? null
          return marker === 'none' ? shown === null : shown === marker
        }, { workspaceName, marker })
      }

      // AC5: the six choices are named, keyboard reachable and carry a visible selection in the menu.
      await page.click('.workspace-row .row-menu-button')
      await page.waitForSelector('.popup-menu [role="group"][aria-label="Marker"]')
      const markerMenu = await page.evaluate(() => {
        const group = document.querySelector('.popup-menu [role="group"][aria-label="Marker"]')
        const options = [...(group?.querySelectorAll('[role="menuitemradio"]') ?? [])]
        const covered = (element) => {
          const box = element.getBoundingClientRect()
          const at = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
          return !element.contains(at) && at !== element
        }
        const menu = document.querySelector('.popup-menu')?.getBoundingClientRect()
        return {
          labels: options.map((option) => option.textContent?.trim() ?? ''),
          checked: options.filter((option) => option.getAttribute('aria-checked') === 'true')
            .map((option) => option.textContent?.trim()),
          swatches: options.map((option) => option.querySelector('.workspace-marker')?.dataset.marker ?? null),
          anyCovered: options.some(covered),
          // Nothing the menu adds may push its own items off screen.
          fitsViewport: !!menu && menu.top >= 0 && menu.bottom <= window.innerHeight + 1
        }
      })
      // Keyboard only: the arrow keys walk into the group and the choice that lands there shows a ring.
      let markerKeyboardFocus = null
      for (let step = 0; step < 10; step += 1) {
        await page.keyboard.press('ArrowDown')
        markerKeyboardFocus = await page.evaluate(() => {
          const active = document.activeElement
          const style = active ? getComputedStyle(active) : null
          return {
            role: active?.getAttribute('role') ?? null,
            label: active?.textContent?.trim() ?? null,
            outlineWidth: style?.outlineWidth ?? null,
            outlineStyle: style?.outlineStyle ?? null,
            outlineColor: style?.outlineColor ?? null,
            steps: 0
          }
        })
        if (markerKeyboardFocus.role === 'menuitemradio') {
          markerKeyboardFocus.steps = step + 1
          break
        }
      }
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('.popup-menu'))

      await setMarker(fixture.primaryWorkspaceName, 'Teal', 'teal')
      await setMarker(fixture.secondWorkspaceName, 'Rose', 'rose')

      // AC3 wants selection, keyboard focus and Needs you overlapping a marker, so the marked row that
      // the loop selects and focuses also carries a real open request for the whole loop.
      await runControlCli(
        roots, fixture.selectedSessionId, 'ask', 'epic11-marker', 'Review the workspace marker?',
        '--kind', 'question'
      )
      await page.waitForFunction(() =>
        document.querySelector('.needs-you-button')?.getAttribute('data-has-items') === 'true')
      // The markers were just chosen with the mouse, and Chromium keeps that modality until a key
      // arrives: a programmatic focus after a click is not :focus-visible. One Tab makes the focus
      // below the keyboard focus this criterion is actually about.
      await page.keyboard.press('Tab')

      const markerMeasurements = []
      for (const [identity, colorMode] of [
        ['knight', 'black'], ['cross', 'black'],
        ['knight', 'steel'], ['cross', 'steel'],
        ['knight', 'brown'], ['cross', 'brown'],
        ['knight', 'dark'], ['cross', 'dark']
      ]) {
        await setAppearance(page, identity, colorMode)
        for (const [width, height] of [[1440, 900], [900, 600]]) {
          await setContentSize(application, page, width, height)
          await settleTerminalLayout(page)
          // Selection, keyboard focus and Needs you all land on the row that also carries a marker.
          await page.focus(`.session-row.selected button[data-session-id="${fixture.selectedSessionId}"]`)
          const paint = await page.evaluate(({ selectedSessionId, foreignSessionId }) => {
            const behind = (element) => {
              let node = element
              while (node) {
                const background = getComputedStyle(node).backgroundColor
                if (background && background !== 'rgba(0, 0, 0, 0)' && background !== 'transparent') return background
                node = node.parentElement
              }
              return getComputedStyle(document.body).backgroundColor
            }
            const read = (marker) => {
              if (!(marker instanceof HTMLElement)) return null
              const style = getComputedStyle(marker)
              const box = marker.getBoundingClientRect()
              return {
                marker: marker.dataset.marker ?? null,
                ink: style.backgroundColor,
                behind: behind(marker.parentElement ?? marker),
                width: Math.round(box.width),
                height: Math.round(box.height),
                borderRadius: style.borderRadius,
                shown: marker.getClientRects().length > 0,
                label: marker.getAttribute('aria-label'),
                title: marker.getAttribute('title'),
                // AC4/"no animations": nothing named to animate and no transition time at all.
                animation: `${style.animationName} ${style.animationDuration} ${style.transitionDuration}`
              }
            }
            const pane = (sessionId) => document.querySelector(`.session-terminal[data-session-id="${sessionId}"]`)
            const paneMarker = (sessionId) => read(pane(sessionId)?.querySelector('.pane-heading .workspace-marker'))
            const groups = [...document.querySelectorAll('.workspace-group')]
            const selectedRow = document.querySelector(`.session-row.selected button[data-session-id="${selectedSessionId}"]`)
            const selectedStyle = selectedRow ? getComputedStyle(selectedRow) : null
            const statusDot = selectedRow?.querySelector('.status-dot')
            const statusStyle = statusDot ? getComputedStyle(statusDot) : null
            const attention = document.querySelector('.status-dot.needs-you')
            const token = (name) => {
              const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
              const hex = raw.replace('#', '')
              return `rgb(${[0, 2, 4].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)).join(', ')})`
            }
            return {
              tokens: {
                identity: token('--identity'),
                attention: token('--attention'),
                focus: token('--focus'),
                verified: token('--verified')
              },
              selectedPane: paneMarker(selectedSessionId),
              foreignPane: paneMarker(foreignSessionId),
              sidebar: groups.map((group) => ({
                workspace: group.getAttribute('aria-label'),
                ...(read(group.querySelector('.workspace-row .workspace-marker[data-marker]')) ?? { marker: null }),
                nameShown: (group.querySelector('.workspace-row .eyebrow')?.getClientRects().length ?? 0) > 0,
                nameText: group.querySelector('.workspace-row .eyebrow')?.textContent?.trim() ?? null,
                nameInk: (() => {
                  const name = group.querySelector('.workspace-row .eyebrow')
                  return name ? getComputedStyle(name).color : null
                })(),
                nameBehind: (() => {
                  const name = group.querySelector('.workspace-row .eyebrow')
                  return name ? behind(name) : null
                })()
              })),
              // The semantic tokens that must keep their meaning beside a marker.
              selection: selectedStyle?.borderLeftColor ?? null,
              // The selected row is the one carrying the open request, so its mark is the attention mark.
              statusDot: statusStyle
                ? { background: statusStyle.backgroundColor, width: statusStyle.width, radius: statusStyle.borderRadius }
                : null,
              // A selected row draws its keyboard ring as a ::after border, not an outline
              // (styles.css:661-672), so the outline properties would report a default that happens to
              // match --focus. The real ring is read here.
              focusRing: selectedRow
                ? {
                    color: getComputedStyle(selectedRow, '::after').borderTopColor,
                    width: getComputedStyle(selectedRow, '::after').borderTopWidth
                  }
                : null,
              attentionDot: attention ? getComputedStyle(attention).backgroundColor : null,
              // Terminal ink, to show the marker never reached the terminal.
              terminalBackground: (() => {
                const screen = pane(selectedSessionId)?.querySelector('.xterm-screen')
                return screen ? behind(screen) : null
              })()
            }
          }, { selectedSessionId: fixture.selectedSessionId, foreignSessionId: fixture.foreignSessionId })

          const capture = await screenshot(
            page,
            `${colorMode}-${identity}-${width}x${height}-workspace-markers.png`,
            markerEvidenceDirectory
          )
          screenshots.push(capture)
          markerMeasurements.push({
            identity,
            colorMode,
            width,
            height,
            selectedPane: paint.selectedPane,
            foreignPane: paint.foreignPane,
            sidebar: paint.sidebar,
            selectedPaneMark: ratio(paint.selectedPane.ink, paint.selectedPane.behind),
            foreignPaneMark: ratio(paint.foreignPane.ink, paint.foreignPane.behind),
            sidebarMarks: paint.sidebar
              .filter((row) => row.marker)
              .map((row) => ({ workspace: row.workspace, marker: row.marker, contrast: ratio(row.ink, row.behind) })),
            sidebarNames: paint.sidebar
              .map((row) => ({ workspace: row.workspace, shown: row.nameShown, text: row.nameText,
                contrast: row.nameInk && row.nameBehind ? ratio(row.nameInk, row.nameBehind) : null })),
            semantics: {
              selection: paint.selection,
              focusRing: paint.focusRing,
              statusDot: paint.statusDot,
              attentionDot: paint.attentionDot,
              terminalBackground: paint.terminalBackground,
              tokens: paint.tokens
            }
          })
        }
      }

      for (const measurement of markerMeasurements) {
        const detail = JSON.stringify(measurement)
        // AC2: each pane takes its own workspace's marker; the active workspace never reaches the other pane.
        assert.equal(measurement.selectedPane.marker, 'teal', detail)
        assert.equal(measurement.foreignPane.marker, 'rose', detail)
        assert.equal(measurement.selectedPane.shown, true, detail)
        assert.equal(measurement.foreignPane.shown, true, detail)
        // AC5/AC3: 3:1 for a meaningful boundary, in every palette and at both sizes.
        assert.ok(measurement.selectedPaneMark >= 3, detail)
        assert.ok(measurement.foreignPaneMark >= 3, detail)
        for (const mark of measurement.sidebarMarks) assert.ok(mark.contrast >= 3, detail)
        // AC3: the marker is a bar, never the 7px status circle, and it never animates.
        for (const mark of [measurement.selectedPane, measurement.foreignPane]) {
          assert.equal(mark.width, 4, detail)
          assert.equal(mark.height, 12, detail)
          assert.equal(mark.borderRadius, '2px', detail)
          assert.equal(mark.animation, 'none 0s 0s', detail)
          // AC2/AC5: the workspace travels with the marker as text, so no meaning rests on hue alone.
          assert.ok(mark.label?.includes('workspace'), detail)
          assert.equal(mark.label, mark.title, detail)
        }
        assert.ok(measurement.selectedPane.label?.includes('Teal marker'), detail)
        assert.ok(measurement.foreignPane.label?.includes('Rose marker'), detail)
        assert.notEqual(measurement.selectedPane.label, measurement.foreignPane.label, detail)
        // AC3: beside a marker, gold selection, white focus and orange attention are still painted with
        // their own tokens, and the status mark keeps the circle it has always been.
        assert.equal(measurement.semantics.selection, measurement.semantics.tokens.identity, detail)
        assert.equal(measurement.semantics.focusRing?.color, measurement.semantics.tokens.focus, detail)
        assert.equal(measurement.semantics.focusRing?.width, '2px', detail)
        assert.equal(measurement.semantics.attentionDot, measurement.semantics.tokens.attention, detail)
        assert.equal(measurement.semantics.statusDot?.background, measurement.semantics.tokens.attention, detail)
        assert.equal(measurement.semantics.statusDot?.width, '7px', detail)
        assert.equal(measurement.semantics.statusDot?.radius, '50%', detail)
        // The marker is none of them: identity never borrows a semantic token.
        for (const semantic of Object.values(measurement.semantics.tokens)) {
          assert.notEqual(measurement.selectedPane.ink, semantic, detail)
          assert.notEqual(measurement.foreignPane.ink, semantic, detail)
        }
        // AC5: names stay legible at 4.5:1 and visible next to the marker, at both sizes.
        for (const name of measurement.sidebarNames) {
          assert.equal(name.shown, true, `${name.workspace}: ${detail}`)
          assert.ok(name.text && name.text.length > 0, detail)
          assert.ok(name.contrast !== null && name.contrast >= 4.5, `${name.workspace}: ${detail}`)
        }
      }

      // AC4: the same layout before and after, so the terminal keeps its grid and the headings their height.
      const markerGeometryAfter = await page.evaluate(({ selectedSessionId, foreignSessionId }) => {
        const pane = (sessionId) => document.querySelector(`.session-terminal[data-session-id="${sessionId}"]`)
        const grid = (sessionId) => {
          const surface = pane(sessionId)?.querySelector('.xterm-screen')
          const box = surface?.getBoundingClientRect()
          return box ? { width: Math.round(box.width), height: Math.round(box.height) } : null
        }
        const heading = (sessionId) => {
          const box = pane(sessionId)?.querySelector('.pane-heading')?.getBoundingClientRect()
          return box ? Math.round(box.height) : null
        }
        const sidebarRow = document.querySelector('.workspace-row > button:first-child')?.getBoundingClientRect()
        return {
          selectedGrid: grid(selectedSessionId),
          foreignGrid: grid(foreignSessionId),
          selectedHeading: heading(selectedSessionId),
          foreignHeading: heading(foreignSessionId),
          sidebarRowHeight: sidebarRow ? Math.round(sidebarRow.height) : null,
          markerCount: document.querySelectorAll('.workspace-marker').length
        }
      }, { selectedSessionId: fixture.selectedSessionId, foreignSessionId: fixture.foreignSessionId })

      await setContentSize(application, page, 1440, 900)
      await setAppearance(page, 'knight', 'black')
      await settleTerminalLayout(page)
      const markerGeometrySameSize = await page.evaluate(({ selectedSessionId, foreignSessionId }) => {
        const pane = (sessionId) => document.querySelector(`.session-terminal[data-session-id="${sessionId}"]`)
        const grid = (sessionId) => {
          const surface = pane(sessionId)?.querySelector('.xterm-screen')
          const box = surface?.getBoundingClientRect()
          return box ? { width: Math.round(box.width), height: Math.round(box.height) } : null
        }
        const heading = (sessionId) => {
          const box = pane(sessionId)?.querySelector('.pane-heading')?.getBoundingClientRect()
          return box ? Math.round(box.height) : null
        }
        const sidebarRow = document.querySelector('.workspace-row > button:first-child')?.getBoundingClientRect()
        return {
          selectedGrid: grid(selectedSessionId),
          foreignGrid: grid(foreignSessionId),
          selectedHeading: heading(selectedSessionId),
          foreignHeading: heading(foreignSessionId),
          sidebarRowHeight: sidebarRow ? Math.round(sidebarRow.height) : null,
          markerCount: document.querySelectorAll('.workspace-marker').length
        }
      }, { selectedSessionId: fixture.selectedSessionId, foreignSessionId: fixture.foreignSessionId })
      const geometryDetail = JSON.stringify({ markerGeometryBefore, markerGeometrySameSize })
      assert.deepEqual(markerGeometrySameSize.selectedGrid, markerGeometryBefore.selectedGrid, geometryDetail)
      assert.deepEqual(markerGeometrySameSize.foreignGrid, markerGeometryBefore.foreignGrid, geometryDetail)
      assert.equal(markerGeometrySameSize.selectedHeading, markerGeometryBefore.selectedHeading, geometryDetail)
      assert.equal(markerGeometrySameSize.foreignHeading, markerGeometryBefore.foreignHeading, geometryDetail)
      assert.equal(markerGeometrySameSize.sidebarRowHeight, markerGeometryBefore.sidebarRowHeight, geometryDetail)
      assert.ok(markerGeometrySameSize.markerCount >= 3, geometryDetail)
      screenshots.push(await screenshot(page, 'black-knight-markers-1440x900.png', markerEvidenceDirectory))

      const markerMenuDetail = JSON.stringify({ markerMenu, markerKeyboardFocus })
      assert.deepEqual(markerMenu.labels, ['None', 'Slate', 'Teal', 'Blue', 'Violet', 'Rose'], markerMenuDetail)
      assert.deepEqual(markerMenu.checked, ['None'], markerMenuDetail)
      assert.deepEqual(markerMenu.swatches, ['none', 'slate', 'teal', 'blue', 'violet', 'rose'], markerMenuDetail)
      assert.equal(markerMenu.anyCovered, false, markerMenuDetail)
      assert.equal(markerMenu.fitsViewport, true, markerMenuDetail)
      assert.equal(markerKeyboardFocus.role, 'menuitemradio', markerMenuDetail)
      assert.ok(markerMenu.labels.includes(markerKeyboardFocus.label), markerMenuDetail)
      assert.notEqual(markerKeyboardFocus.outlineStyle, 'none', markerMenuDetail)
      assert.notEqual(markerKeyboardFocus.outlineWidth, '0px', markerMenuDetail)

      // AC5: the second workspace's name is deliberately long. Beside a marker it must still truncate
      // rather than push the marker or the menu button out of the row.
      const longNameRow = await page.evaluate((workspaceName) => {
        const group = document.querySelector(`.workspace-group[aria-label="${workspaceName}"]`)
        const marker = group?.querySelector('.workspace-row .workspace-marker')
        const row = marker?.closest('.workspace-row')
        const name = row?.querySelector('.eyebrow')
        const menuButton = row?.querySelector('.row-menu-button')
        if (!(row instanceof HTMLElement) || !(name instanceof HTMLElement)) throw new Error('long-name row missing')
        const sidebar = row.closest('.workspace-sidebar')
        return {
          truncated: name.scrollWidth > name.clientWidth,
          markerShown: marker.getClientRects().length > 0,
          menuButtonShown: !!menuButton && menuButton.getClientRects().length > 0,
          overflows: !!sidebar && row.getBoundingClientRect().right > sidebar.getBoundingClientRect().right + 1,
          markerLeftOfName: marker.getBoundingClientRect().right <= name.getBoundingClientRect().left + 1
        }
      }, fixture.secondWorkspaceName)
      screenshots.push(await screenshot(page, 'black-knight-marker-long-name.png', markerEvidenceDirectory))
      const longNameDetail = JSON.stringify(longNameRow)
      assert.equal(longNameRow.truncated, true, longNameDetail)
      assert.equal(longNameRow.markerShown, true, longNameDetail)
      assert.equal(longNameRow.menuButtonShown, true, longNameDetail)
      assert.equal(longNameRow.overflows, false, longNameDetail)
      assert.equal(longNameRow.markerLeftOfName, true, longNameDetail)

      await setContentSize(application, page, 780, 600)
      await settleTerminalLayout(page)
      const markerRail = await page.evaluate((workspaceName) => {
        const group = document.querySelector(`.workspace-group[aria-label="${workspaceName}"]`)
        const marker = group?.querySelector('.workspace-row .workspace-marker')
        const row = marker?.closest('.workspace-row')
        const name = row?.querySelector('.eyebrow')
        if (!(row instanceof HTMLElement) || !(name instanceof HTMLElement)) throw new Error('rail marker missing')
        const sidebar = row.closest('.workspace-sidebar')
        return {
          markerShown: marker.getClientRects().length > 0,
          nameShown: name.getClientRects().length > 0,
          nameWidth: Math.round(name.getBoundingClientRect().width),
          overflows: !!sidebar && row.getBoundingClientRect().right > sidebar.getBoundingClientRect().right + 1
        }
      }, fixture.secondWorkspaceName)
      screenshots.push(await screenshot(page, 'black-knight-marker-780x600-rail.png', markerEvidenceDirectory))
      const markerRailDetail = JSON.stringify(markerRail)
      assert.equal(markerRail.markerShown, true, markerRailDetail)
      assert.equal(markerRail.nameShown, true, markerRailDetail)
      assert.ok(markerRail.nameWidth > 0, markerRailDetail)
      assert.equal(markerRail.overflows, false, markerRailDetail)

      await setContentSize(application, page, 1440, 900)
      await settleTerminalLayout(page)
      await runControlCli(roots, fixture.selectedSessionId, 'withdraw', 'epic11-marker')

      // AC1/AC3: None is an equivalent usable choice, and choosing it puts the row back as it was.
      await setMarker(fixture.primaryWorkspaceName, 'None', 'none')
      // Every pane of that workspace drops its mark, hidden ones included; the other workspace keeps its.
      await page.waitForFunction(({ selectedSessionId, foreignSessionId }) => {
        const mark = (sessionId) => document
          .querySelector(`.session-terminal[data-session-id="${sessionId}"] .pane-heading .workspace-marker`)
        return !mark(selectedSessionId) && !!mark(foreignSessionId)
      }, { selectedSessionId: fixture.selectedSessionId, foreignSessionId: fixture.foreignSessionId })
      const afterNone = await page.evaluate(({ selectedSessionId, foreignSessionId }) => {
        const pane = (sessionId) => document.querySelector(`.session-terminal[data-session-id="${sessionId}"]`)
        return {
          selectedPaneMarker: pane(selectedSessionId)
            ?.querySelector('.pane-heading .workspace-marker')?.dataset.marker ?? null,
          foreignPaneMarker: pane(foreignSessionId)
            ?.querySelector('.pane-heading .workspace-marker')?.dataset.marker ?? null,
          sidebarMarkerWorkspaces: [...document.querySelectorAll('.workspace-group')]
            .filter((group) => group.querySelector('.workspace-row .workspace-marker[data-marker]'))
            .map((group) => group.getAttribute('aria-label')),
          // Unmarked rows hold an invisible slot so every workspace name keeps one left edge.
          reservedSlots: document.querySelectorAll('.workspace-row .workspace-marker:not([data-marker])').length,
          nameLeftEdges: [...new Set([...document.querySelectorAll('.workspace-row .eyebrow')]
            .map((name) => Math.round(name.getBoundingClientRect().left)))],
          // Hidden panes follow their workspace too, so no stale mark is left behind anywhere.
          remainingPaneMarkers: [...document.querySelectorAll('.session-terminal .pane-heading .workspace-marker')]
            .map((mark) => mark.dataset.marker)
        }
      }, { selectedSessionId: fixture.selectedSessionId, foreignSessionId: fixture.foreignSessionId })
      const afterNoneDetail = JSON.stringify(afterNone)
      assert.equal(afterNone.selectedPaneMarker, null, afterNoneDetail)
      assert.equal(afterNone.foreignPaneMarker, 'rose', afterNoneDetail)
      assert.equal(afterNone.sidebarMarkerWorkspaces.length, 1, afterNoneDetail)
      assert.deepEqual([...new Set(afterNone.remainingPaneMarkers)], ['rose'], afterNoneDetail)
      // One workspace still carries a marker, so the unmarked one keeps its slot and the names line up.
      assert.equal(afterNone.reservedSlots, 1, afterNoneDetail)
      assert.equal(afterNone.nameLeftEdges.length, 1, afterNoneDetail)
      phase('workspace identity marker checks passed')

      // ---------- Epic 20: workspace attention, dormant rows and quiet controls ----------
      phase('workspace glance states')
      const glanceScreenshots = []
      const glanceFixture = {
        liveSessionId: fixture.selectedSessionId,
        dormantSessionId: fixture.sessionIds[1],
        dormantSessionName: 'Implementation — renderer hierarchy and interaction polish',
        attentionSessionId: fixture.foreignSessionId,
        workspaceName: fixture.secondWorkspaceName
      }
      await setContentSize(application, page, 1440, 900)
      await setAppearance(page, 'knight', 'black')
      await settleTerminalLayout(page)

      const ensureWorkspaceExpanded = async (workspaceName) => {
        await page.evaluate((name) => {
          const group = [...document.querySelectorAll('.workspace-group')]
            .find((candidate) => candidate.getAttribute('aria-label') === name)
          if (!group) throw new Error(`workspace group unavailable: ${name}`)
          if (group.querySelectorAll('.session-row').length === 0) {
            const button = group.querySelector('.workspace-row > button:first-child')
            if (!(button instanceof HTMLElement)) throw new Error(`workspace toggle unavailable: ${name}`)
            button.click()
          }
        }, workspaceName)
        await page.waitForFunction((name) => [...document.querySelectorAll('.workspace-group')]
          .find((candidate) => candidate.getAttribute('aria-label') === name)
          ?.querySelectorAll('.session-row').length > 0, workspaceName)
      }

      await ensureWorkspaceExpanded(glanceFixture.workspaceName)
      const stopForGlance = async (sessionId) => {
        await page.evaluate(async (id) => {
          const sessionButton = document.querySelector(`.session-row button[data-session-id="${id}"]`)
          const row = sessionButton?.closest('.session-row')
          if (row?.getAttribute('data-live') === 'true') await window.aiTerminal.stopSession(id)
        }, sessionId)
      }
      await stopForGlance(glanceFixture.dormantSessionId)
      await stopForGlance(glanceFixture.attentionSessionId)
      await page.waitForFunction(({ dormantSessionId, attentionSessionId }) => {
        const live = (sessionId) => document
          .querySelector(`.session-row button[data-session-id="${sessionId}"]`)
          ?.closest('.session-row')?.getAttribute('data-live')
        return live(dormantSessionId) === 'false' && live(attentionSessionId) === 'false'
      }, glanceFixture)
      await runControlCli(
        roots,
        glanceFixture.attentionSessionId,
        'ask',
        'epic20-visual',
        'Review the visual states?',
        '--kind',
        'question'
      )
      await page.waitForFunction(({ attentionSessionId, workspaceName }) => {
        const sessionRow = document.querySelector(
          `.session-row button[data-session-id="${attentionSessionId}"]`
        )
        const group = [...document.querySelectorAll('.workspace-group')]
          .find((candidate) => candidate.getAttribute('aria-label') === workspaceName)
        return !!sessionRow?.querySelector('.status-dot.needs-you') &&
          !!group?.querySelector('.workspace-row .status-dot.needs-you')
      }, glanceFixture)

      const readGlanceState = () => page.evaluate((state) => {
        const group = [...document.querySelectorAll('.workspace-group')]
          .find((candidate) => candidate.getAttribute('aria-label') === state.workspaceName)
        const workspaceButton = group?.querySelector('.workspace-row > button:first-child')
        const workspaceDot = group?.querySelector('.workspace-row .status-dot.needs-you')
        const hiddenText = group?.querySelector('.workspace-row .visually-hidden')
        const buttonFor = (sessionId) => document
          .querySelector(`.session-row button[data-session-id="${sessionId}"]`)
        const readRow = (sessionId) => {
          const button = buttonFor(sessionId)
          const row = button?.closest('.session-row')
          const name = row?.querySelector('.session-name')
          const dot = row?.querySelector('.status-dot')
          return {
            dataLive: row?.getAttribute('data-live') ?? null,
            nameColor: name ? getComputedStyle(name).color : null,
            nameWeight: name ? getComputedStyle(name).fontWeight : null,
            selected: row?.classList.contains('selected') ?? false,
            borderColor: button ? getComputedStyle(button).borderLeftColor : null,
            backgroundColor: button ? getComputedStyle(button).backgroundColor : null,
            dot: dot?.className ?? null,
            dotShown: !!dot && dot.getClientRects().length > 0
          }
        }
        const probe = document.createElement('span')
        probe.style.color = 'var(--muted)'
        probe.style.borderLeft = '2px solid var(--identity)'
        probe.style.backgroundColor = 'var(--selected)'
        probe.style.position = 'fixed'
        probe.style.visibility = 'hidden'
        document.body.append(probe)
        const mutedColor = getComputedStyle(probe).color
        const identityColor = getComputedStyle(probe).borderLeftColor
        const selectedColor = getComputedStyle(probe).backgroundColor
        probe.remove()
        return {
          workspace: {
            expanded: workspaceButton?.getAttribute('aria-expanded') === 'true',
            dotShown: !!workspaceDot && workspaceDot.getClientRects().length > 0 &&
              getComputedStyle(workspaceDot).display !== 'none',
            hiddenText: hiddenText?.textContent?.trim() ?? '',
            title: workspaceButton?.getAttribute('title') ?? ''
          },
          mutedColor,
          identityColor,
          selectedColor,
          rows: {
            live: readRow(state.liveSessionId),
            dormant: readRow(state.dormantSessionId),
            attention: readRow(state.attentionSessionId)
          }
        }
      }, glanceFixture)

      const captureGlancePair = async (identity, stateName) => {
        await setAppearance(page, identity, 'black')
        await page.mouse.move(0, 0)
        const baseline = await page.addStyleTag({ content: epic20BaselineCss })
        glanceScreenshots.push(await screenshot(
          page,
          `black-${identity}-epic20-${stateName}-before.png`,
          glanceEvidenceDirectory
        ))
        await baseline.evaluate((element) => element.remove())
        glanceScreenshots.push(await screenshot(
          page,
          `black-${identity}-epic20-${stateName}-after.png`,
          glanceEvidenceDirectory
        ))
      }

      const glanceIdentities = ['knight', 'cross']
      for (const identity of glanceIdentities) await captureGlancePair(identity, 'expanded')
      const expandedGlance = await readGlanceState()
      const expandedDetail = JSON.stringify(expandedGlance)
      assert.equal(expandedGlance.workspace.expanded, true, expandedDetail)
      assert.equal(expandedGlance.workspace.dotShown, true, expandedDetail)
      assert.equal(expandedGlance.workspace.hiddenText, '1 waiting for your response', expandedDetail)
      assert.ok(expandedGlance.workspace.title.includes('1 waiting for your response'), expandedDetail)
      assert.equal(expandedGlance.rows.live.dataLive, 'true', expandedDetail)
      assert.equal(expandedGlance.rows.dormant.dataLive, 'false', expandedDetail)
      assert.equal(expandedGlance.rows.attention.dataLive, 'false', expandedDetail)
      assert.equal(expandedGlance.rows.dormant.nameColor, expandedGlance.mutedColor, expandedDetail)
      assert.notEqual(expandedGlance.rows.attention.nameColor, expandedGlance.mutedColor, expandedDetail)
      assert.ok(expandedGlance.rows.attention.dot?.includes('needs-you'), expandedDetail)
      const selectedGlanceButton = page.locator('.session-row.selected > button:first-child')
      await selectedGlanceButton.focus()
      await page.keyboard.press('Shift+Tab')
      await page.keyboard.press('Tab')
      const glanceGrayscaleFocus = await selectedGlanceButton.evaluate((button) => {
        const ring = getComputedStyle(button, '::after')
        return {
          keyboardVisible: button.matches(':focus-visible') && document.activeElement === button,
          ringWidth: ring.borderTopWidth,
          ringStyle: ring.borderTopStyle,
          ringColor: ring.borderTopColor,
          selectedBar: getComputedStyle(button).borderLeftColor,
          workspaceDot: !!document.querySelector('.workspace-row .status-dot.needs-you')
        }
      })
      assert.equal(glanceGrayscaleFocus.keyboardVisible, true, JSON.stringify(glanceGrayscaleFocus))
      assert.equal(glanceGrayscaleFocus.ringWidth, '2px', JSON.stringify(glanceGrayscaleFocus))
      assert.equal(glanceGrayscaleFocus.ringStyle, 'solid', JSON.stringify(glanceGrayscaleFocus))
      assert.equal(glanceGrayscaleFocus.workspaceDot, true, JSON.stringify(glanceGrayscaleFocus))
      const glanceGrayscale = await page.addStyleTag({ content: '.shell-window { filter: grayscale(1); }' })
      glanceScreenshots.push(await screenshot(page, 'black-cross-epic20-expanded-grayscale.png', glanceEvidenceDirectory))
      await glanceGrayscale.evaluate((element) => element.remove())

      const selectedExitedStates = []
      await page.locator(`.session-row button[data-session-id="${glanceFixture.dormantSessionId}"]`).click()
      for (const identity of glanceIdentities) {
        await captureGlancePair(identity, 'selected-exited')
        const state = await readGlanceState()
        const row = state.rows.dormant
        const detail = JSON.stringify({ identity, row, state })
        assert.equal(row.dataLive, 'false', detail)
        assert.equal(row.selected, true, detail)
        assert.equal(row.nameColor, state.mutedColor, detail)
        assert.equal(row.nameWeight, '500', detail)
        assert.equal(row.borderColor, state.identityColor, detail)
        assert.equal(row.backgroundColor, state.selectedColor, detail)
        selectedExitedStates.push({ identity, row })
      }
      await page.locator(`.session-row button[data-session-id="${glanceFixture.liveSessionId}"]`).click()

      await page.evaluate((name) => {
        const group = [...document.querySelectorAll('.workspace-group')]
          .find((candidate) => candidate.getAttribute('aria-label') === name)
        if (!group) throw new Error(`workspace group unavailable: ${name}`)
        const button = group.querySelector('.workspace-row > button:first-child')
        if (!(button instanceof HTMLElement)) throw new Error(`workspace toggle unavailable: ${name}`)
        button.click()
      }, glanceFixture.workspaceName)
      await page.waitForFunction((name) => [...document.querySelectorAll('.workspace-group')]
        .find((candidate) => candidate.getAttribute('aria-label') === name)
        ?.querySelectorAll('.session-row').length === 0, glanceFixture.workspaceName)
      await settleTerminalLayout(page)
      for (const identity of glanceIdentities) await captureGlancePair(identity, 'collapsed')
      const collapsedGlance = await readGlanceState()
      const collapsedDetail = JSON.stringify(collapsedGlance)
      assert.equal(collapsedGlance.workspace.expanded, false, collapsedDetail)
      assert.equal(collapsedGlance.workspace.dotShown, true, collapsedDetail)
      assert.equal(collapsedGlance.workspace.hiddenText, '1 waiting for your response', collapsedDetail)

      await setContentSize(application, page, 780, 600)
      await settleTerminalLayout(page)
      for (const identity of glanceIdentities) await captureGlancePair(identity, 'rail')
      const narrowGlance = await readGlanceState()
      const narrowDetail = JSON.stringify(narrowGlance)
      assert.equal(narrowGlance.workspace.expanded, false, narrowDetail)
      assert.equal(narrowGlance.workspace.dotShown, true, narrowDetail)
      assert.equal(narrowGlance.workspace.hiddenText, '1 waiting for your response', narrowDetail)

      const glanceContrastTokens = await page.evaluate(() => {
        const modes = ['steel', 'brown', 'dark', 'black']
        const root = document.documentElement
        const previousMode = root.dataset.colorMode
        const output = []
        for (const colorMode of modes) {
          root.dataset.colorMode = colorMode
          const probe = document.createElement('span')
          probe.style.color = 'var(--muted)'
          probe.style.position = 'fixed'
          probe.style.visibility = 'hidden'
          document.body.append(probe)
          const style = getComputedStyle(root)
          output.push({
            colorMode,
            muted: getComputedStyle(probe).color,
            surface: style.getPropertyValue('--surface').trim()
          })
          probe.remove()
        }
        root.dataset.colorMode = previousMode
        return output
      })
      const glanceMutedContrasts = glanceContrastTokens.map((item) => ({
        colorMode: item.colorMode,
        mutedOnSurface: ratio(item.muted, item.surface)
      }))
      for (const measurement of glanceMutedContrasts) {
        assert.ok(measurement.mutedOnSurface >= 4.5, JSON.stringify(measurement))
      }

      await setContentSize(application, page, 1440, 900)
      await setAppearance(page, 'knight', 'black')
      await settleTerminalLayout(page)
      const dormantMain = page.locator(
        `.session-row > button[data-session-id="${glanceFixture.dormantSessionId}"]`
      )
      const dormantRow = dormantMain.locator('..')
      const dormantMenu = dormantRow.locator('.row-menu-button')
      await page.mouse.move(0, 0)
      await page.evaluate(() => {
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
      })
      const menuIdleOpacity = await dormantMenu.evaluate((element) => getComputedStyle(element).opacity)
      assert.equal(menuIdleOpacity, '0', menuIdleOpacity)
      await dormantRow.hover()
      const menuHoverOpacity = await dormantMenu.evaluate((element) => getComputedStyle(element).opacity)
      assert.equal(menuHoverOpacity, '1', menuHoverOpacity)
      glanceScreenshots.push(await screenshot(
        page,
        'black-knight-epic20-menu-hover.png',
        glanceEvidenceDirectory
      ))
      await page.mouse.move(0, 0)
      await dormantMain.focus()
      const menuFocusOpacity = await dormantMenu.evaluate((element) => getComputedStyle(element).opacity)
      assert.equal(menuFocusOpacity, '1', menuFocusOpacity)
      await page.keyboard.press('Tab')
      const menuTab = await page.evaluate(() => {
        const active = document.activeElement
        return {
          label: active?.getAttribute('aria-label') ?? null,
          opacity: active instanceof HTMLElement ? getComputedStyle(active).opacity : null
        }
      })
      const menuDetail = JSON.stringify(menuTab)
      assert.equal(menuTab.label, `Actions for ${glanceFixture.dormantSessionName}`, menuDetail)
      assert.equal(menuTab.opacity, '1', menuDetail)
      await dormantMenu.click()
      await page.waitForSelector('.popup-menu')
      const menuOpen = await dormantMenu.evaluate((element) => ({
        expanded: element.getAttribute('aria-expanded'),
        opacity: getComputedStyle(element).opacity
      }))
      assert.equal(menuOpen.expanded, 'true', JSON.stringify(menuOpen))
      assert.equal(menuOpen.opacity, '1', JSON.stringify(menuOpen))
      glanceScreenshots.push(await screenshot(
        page,
        'black-knight-epic20-menu-open.png',
        glanceEvidenceDirectory
      ))
      await page.keyboard.press('Escape')
      phase('workspace glance checks passed')

      phase('all runtime checks passed')
      return {
        fixture,
        markerMeasurements,
        markerMenu,
        markerKeyboardFocus,
        markerGeometry: { before: markerGeometryBefore, afterPalettes: markerGeometryAfter, sameSize: markerGeometrySameSize },
        markerLongName: longNameRow,
        markerRail,
        markerAfterNone: afterNone,
        epic20Glance: {
          fixture: glanceFixture,
          expanded: expandedGlance,
          collapsed: collapsedGlance,
          narrowRail: narrowGlance,
          mutedContrasts: glanceMutedContrasts,
          grayscaleFocus: glanceGrayscaleFocus,
          selectedExitedStates,
          menu: { idleOpacity: menuIdleOpacity, hoverOpacity: menuHoverOpacity, focusOpacity: menuFocusOpacity, tab: menuTab, open: menuOpen },
          screenshots: glanceScreenshots
        },
        activityMeasurements,
        activityPaletteFiltering,
        activityAttentionPrecedence: precedence,
        activityCompactRail: railRow,
        activityProvenanceLines: provenanceLines,
        screenshotProvenance: {
          before: 'Reconstructed previous CSS selectors applied to the repaired runtime; not a base-HEAD capture.',
          after: 'Current repaired runtime.'
        },
        screenshots,
        measuredContrasts,
        hierarchyPolish,
        terminalBefore,
        terminalAfter,
        popoverFocus,
        menuFocus,
        paletteFocus,
        paletteScrollbar,
        palettePress,
        selectionFocus,
        selectedText,
        selectedTextStability,
        chromeFocusStability,
        paneSwitchStability,
        pointer,
        primaryPress,
        selectedTogglePress,
        selectedRowPress,
        disabledAction,
        reducedMotion,
        normalTransitionMs,
        xtermFocus,
        singlePane,
        navigation,
        narrowFocus: { before: narrowBefore, after: narrowAfter },
        narrowLabels,
        persistedSteel
      }
    } finally {
      phase('closing isolated Electron app')
      const electronProcess = application.process()
      const exited = electronProcess.exitCode === null && electronProcess.signalCode === null
        ? new Promise((resolveExit) => electronProcess.once('exit', resolveExit))
        : Promise.resolve()
      await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
      await exited
    }
  }
)

// A real application restart gives this fixture an interrupted row alongside live, exited,
// exited-with-question and selected-exited rows. All five are visible in each identity capture.
const interruptedGlance = await withTemporaryRoot(
  temporaryRootContracts.electronDevelopment,
  async ({ root, roots }) => {
    const launch = () => electron.launch({
      executablePath: electronBinary,
      args: [appDirectory, '--bmn-test-mode', '--', '/bin/bash', '--noprofile', '--norc'],
      cwd: repoRoot,
      env: {
        ...process.env,
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
    const exit = async (application) => {
      const process = application.process()
      const exited = process.exitCode === null && process.signalCode === null
        ? new Promise((resolveExit) => process.once('exit', resolveExit))
        : Promise.resolve()
      await application.evaluate(({ app }) => app.exit(0)).catch(() => undefined)
      await exited
    }
    phase('creating real interrupted sidebar fixture')
    let application = await launch()
    try {
      let page = await application.firstWindow()
      page.setDefaultTimeout(15_000)
      await page.waitForSelector('.session-row')
      const fixture = await page.evaluate(async (cwd) => {
        const workspace = (await window.aiTerminal.listWorkspaces()).find((item) => !item.archivedAt)
        if (!workspace) throw new Error('interrupted visual fixture has no workspace')
        const initial = (await window.aiTerminal.listSessions(workspace.workspaceId))[0]
        if (!initial) throw new Error('interrupted visual fixture has no initial session')
        const create = async (name) => (await window.aiTerminal.createSession({
          workspaceId: workspace.workspaceId, name, cwd, executable: '/bin/bash',
          argv: ['--noprofile', '--norc'], cols: 80, rows: 24, backgroundChoice: 'stop'
        })).session
        const exited = await create('Exited visual fixture')
        const question = await create('Exited with question visual fixture')
        const selected = await create('Selected exited visual fixture')
        for (const session of [exited, question, selected]) await window.aiTerminal.stopSession(session.sessionId)
        return { workspaceId: workspace.workspaceId, interrupted: initial.sessionId,
          exited: exited.sessionId, question: question.sessionId, selected: selected.sessionId }
      }, root)
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.waitForSelector(`.session-row button[data-session-id="${fixture.question}"]`)
      await runControlCli(roots, fixture.question, 'ask', 'epic20-interrupted-question',
        'Review the interrupted fixture?', '--kind', 'question')
      await page.waitForFunction((id) => document.querySelector(
        `.session-row button[data-session-id="${id}"] .status-dot.needs-you`
      ), fixture.question)
      await exit(application)

      application = await launch()
      page = await application.firstWindow()
      page.setDefaultTimeout(15_000)
      await page.waitForSelector(`.session-row button[data-session-id="${fixture.selected}"]`)
      fixture.live = await page.evaluate(async (ids) => {
        const records = await window.aiTerminal.listSessions(ids.workspaceId)
        const live = records.find((row) => row.lastProcess?.state === 'live' &&
          ![ids.interrupted, ids.exited, ids.question, ids.selected].includes(row.sessionId))
        if (!live) throw new Error('restart did not launch a fresh live shell')
        return live.sessionId
      }, fixture)
      await page.waitForSelector(`.session-row[data-live="true"] button[data-session-id="${fixture.live}"]`)
      await page.locator(`.session-row button[data-session-id="${fixture.selected}"]`).click()
      await setContentSize(application, page, 1440, 900)
      const screenshots = []
      const measurements = []
      for (const identity of ['knight', 'cross']) {
        await setAppearance(page, identity, 'black')
        await settleTerminalLayout(page)
        const baseline = await page.addStyleTag({ content: epic20BaselineCss })
        screenshots.push(await screenshot(page, `black-${identity}-epic20-interrupted-before.png`, glanceEvidenceDirectory))
        await baseline.evaluate((element) => element.remove())
        screenshots.push(await screenshot(page, `black-${identity}-epic20-interrupted-after.png`, glanceEvidenceDirectory))
        const measured = await page.evaluate(async (ids) => {
          const records = await window.aiTerminal.listSessions(ids.workspaceId)
          const state = (id) => records.find((row) => row.sessionId === id)?.lastProcess?.state ?? null
          const live = records.find((row) => row.sessionId === ids.live)
          const row = (id) => {
            const button = document.querySelector(`.session-row button[data-session-id="${id}"]`)
            const host = button?.closest('.session-row')
            const name = host?.querySelector('.session-name')
            return { live: host?.getAttribute('data-live') ?? null,
              selected: host?.classList.contains('selected') ?? false,
              mutedName: name ? getComputedStyle(name).color : null,
              weight: name ? getComputedStyle(name).fontWeight : null,
              attention: !!host?.querySelector('.status-dot.needs-you'),
              bar: button ? getComputedStyle(button).borderLeftColor : null,
              fill: button ? getComputedStyle(button).backgroundColor : null }
          }
          const probe = document.createElement('span')
          probe.style.color = 'var(--muted)'
          probe.style.borderLeft = '2px solid var(--identity)'
          probe.style.backgroundColor = 'var(--selected)'
          document.body.append(probe)
          const tokens = { muted: getComputedStyle(probe).color,
            identity: getComputedStyle(probe).borderLeftColor,
            selected: getComputedStyle(probe).backgroundColor }
          probe.remove()
          return { records: { interrupted: state(ids.interrupted), exited: state(ids.exited),
            question: state(ids.question), selected: state(ids.selected), live: live?.lastProcess?.state ?? null },
          rows: { interrupted: row(ids.interrupted), exited: row(ids.exited),
            question: row(ids.question), selected: row(ids.selected), live: live ? row(live.sessionId) : null },
          tokens, workspaceDot: !!document.querySelector('.workspace-row .status-dot.needs-you') }
        }, fixture)
        const detail = JSON.stringify({ identity, measured })
        assert.deepEqual(measured.records, { interrupted: 'interrupted', exited: 'exited',
          question: 'exited', selected: 'exited', live: 'live' }, detail)
        assert.equal(measured.rows.live?.live, 'true', detail)
        assert.equal(measured.rows.interrupted.live, 'false', detail)
        assert.equal(measured.rows.interrupted.mutedName, measured.tokens.muted, detail)
        assert.equal(measured.rows.exited.mutedName, measured.tokens.muted, detail)
        assert.equal(measured.rows.question.attention, true, detail)
        assert.notEqual(measured.rows.question.mutedName, measured.tokens.muted, detail)
        assert.equal(measured.rows.selected.selected, true, detail)
        assert.equal(measured.rows.selected.mutedName, measured.tokens.muted, detail)
        assert.equal(measured.rows.selected.weight, '500', detail)
        assert.equal(measured.rows.selected.bar, measured.tokens.identity, detail)
        assert.equal(measured.rows.selected.fill, measured.tokens.selected, detail)
        assert.equal(measured.workspaceDot, true, detail)
        measurements.push({ identity, ...measured })
      }
      phase('real interrupted sidebar fixture passed')
      return { fixture, measurements, screenshots }
    } finally {
      await exit(application)
    }
  }
)
evidence.epic20Glance.interrupted = interruptedGlance

await writeFile(
  join(evidenceDirectory, 'runtime-evidence.json'),
  `${JSON.stringify(evidence, null, 2)}\n`,
  { mode: 0o600 }
)
console.log(JSON.stringify({ epic5Visual: 'PASS', evidence: join(evidenceDirectory, 'runtime-evidence.json') }))
