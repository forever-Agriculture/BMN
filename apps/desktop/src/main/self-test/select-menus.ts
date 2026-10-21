// MODULE: select-menus.ts - Electron self-test for BMN's select (Story 80.4 AC2): each of the five driven by real keys and real clicks
import type { BrowserWindow } from 'electron'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

/** What one select showed after each step; every field must be true for the run to pass. */
export interface SelectMenuSiteReceipt {
  keyboard: {
    opened: boolean
    openedOnValue: boolean
    moved: boolean
    escapeKeptValue: boolean
    escapeFocusedOpener: boolean
    homeEnd: boolean
    chose: boolean
    choseFocusedOpener: boolean
    tabClosedUnchanged: boolean
  }
  mouse: {
    opened: boolean
    outsideKeptValue: boolean
    toggledClosed: boolean
    chose: boolean
    choseFocusedOpener: boolean
  }
  /** The value the keyboard chose, and the one the mouse chose back. */
  values: { before: string; keyboard: string; mouse: string }
  /** Language saves as it is chosen: the settings read back after each choice. */
  saved?: { keyboard: string; mouse: string }
  unavailableWhileArchived?: boolean
}

interface Look {
  diagnostic?: Record<string, unknown>
  value: string
  expanded: string | null
  disabled: boolean
  list: boolean
  focusOpener: boolean
  focusBody: boolean
  focusValue: string | null
  rows: string[]
  x: number
  y: number
}

interface Site {
  name: string
  /** CSS selector of the opener. */
  opener: string
  /** CSS selector of a plain element outside the list and the opener, for the outside click. */
  outside: string
  /** Brings the opener on screen. */
  show(): Promise<void>
  /** The value the keyboard pass chooses; it is reached by type-ahead when `letter` is set. */
  target(rows: string[], before: string): string
  letter?: string
  /** Reads the saved value, for a select that saves as it is chosen. */
  saved?(): Promise<string>
}

const keyCodes: Record<string, string> = {
  ArrowDown: 'Down', ArrowUp: 'Up', Home: 'Home', End: 'End', Enter: 'Return', ' ': 'Space', Escape: 'Escape', Tab: 'Tab'
}

export async function runSelectMenusSelfTest(window: BrowserWindow): Promise<{ sites: Record<string, SelectMenuSiteReceipt>; archiveWorkspaceId: string }> {
  const renderer = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code) as Promise<T>
  let phase = 'setup'
  let inputId = 0
  const native: Record<string, unknown>[] = []
  const looks: Record<string, unknown>[] = []
  const completed: Record<string, SelectMenuSiteReceipt> = {}
  let overflow = 0
  const record = (entry: Record<string, unknown>): void => {
    native.push(entry)
    if (native.length > 300) { native.shift(); overflow += 1 }
  }
  const delivery = (_event: unknown, input: { type: string; key: string; code: string }): void => {
    record({ kind: 'native-delivery', phase, inputId, type: input.type, key: input.key, code: input.code })
  }
  const mark = (name: string, detail: Record<string, unknown> = {}): void => {
    phase = name
    console.error(`[BMN select diagnostic] ${JSON.stringify({ kind: 'boundary', phase, inputId, ...detail })}`)
  }
  const capture = async (name: string, detail: Record<string, unknown> = {}): Promise<void> => {
    try {
      const dom = await renderer<unknown>('window.__bmnSelectDiagnostics?.read()')
      console.error(`[BMN select diagnostic] ${JSON.stringify({ kind: 'capture', phase: name, ...detail, completed,
        native, looks, overflow, window: { focused: window.isFocused(), contentsFocused: window.webContents.isFocused(),
          visible: window.isVisible(), minimized: window.isMinimized(), bounds: window.getContentBounds() }, dom })}`)
    } catch { console.error('[BMN select diagnostic] capture unavailable; original failure retained') }
  }
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const look = (opener: string): Promise<Look | null> => renderer<Look | null>(`(() => {
    const opener = document.querySelector(${JSON.stringify(opener)});
    if (!opener) return null;
    const list = document.querySelector('.popup-menu.select-list');
    const active = document.activeElement;
    const box = opener.getBoundingClientRect();
    return {
      diagnostic: window.__bmnSelectDiagnostics?.snapshot(opener, box),
      value: opener.dataset.value ?? '',
      expanded: opener.getAttribute('aria-expanded'),
      disabled: opener.disabled,
      list: !!list,
      focusOpener: active === opener,
      focusBody: !active || active === document.body,
      focusValue: list && list.contains(active) ? active.dataset.value ?? null : null,
      rows: list ? [...list.querySelectorAll('[role="menuitemradio"]')].map((row) => row.dataset.value ?? '') : [],
      x: box.left + box.width / 2,
      y: box.top + box.height / 2
    };
  })()`)
  /** Waits up to 3 s for the select to show what `test` wants; returns whether it did. */
  const until = async (opener: string, test: (state: Look) => boolean): Promise<boolean> => {
    const end = Date.now() + 3000
    while (Date.now() < end) {
      const state = await look(opener)
      looks.push({ phase, inputId, selector: opener, state })
      if (looks.length > 130) { looks.shift(); overflow += 1 }
      if (state && !state.disabled && test(state)) return true
      await pause(25)
    }
    return false
  }
  const now = async (opener: string): Promise<Look> => {
    const state = await look(opener)
    if (!state) throw new Error(`select self-test: ${opener} is not on screen`)
    return state
  }
  const key = (name: string): void => {
    record({ kind: 'native-submit', phase, inputId: ++inputId, key: name, focused: window.isFocused(),
      contentsFocused: window.webContents.isFocused(), visible: window.isVisible() })
    const keyCode = keyCodes[name] ?? name
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (name.length === 1) window.webContents.sendInputEvent({ type: 'char', keyCode })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  const clickAt = (x: number, y: number): void => {
    record({ kind: 'native-pointer-submit', phase, inputId: ++inputId, x, y })
    window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    window.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  }
  const centre = (selector: string): Promise<{ x: number; y: number }> => renderer<{ x: number; y: number }>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('select self-test: nothing at ' + ${JSON.stringify(selector)});
    if (element.closest('.select-list')) element.scrollIntoView({ block: 'nearest' });
    const box = element.getBoundingClientRect();
    return { x: box.left + Math.min(box.width / 2, 24), y: box.top + box.height / 2 };
  })()`)
  const clickOn = async (selector: string): Promise<void> => {
    const point = await centre(selector)
    clickAt(point.x, point.y)
  }
  const palette = (label: string): Promise<void> => renderer<void>(`(async () => {
    const wait = async (read) => { const end = Date.now() + 10000; while (Date.now() < end) {
      const value = read(); if (value) return value; await new Promise((r) => setTimeout(r, 25)); }
      throw new Error('select self-test palette: ${label}'); };
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'P', code: 'KeyP', ctrlKey: true, shiftKey: true, bubbles: true }));
    const input = await wait(() => document.querySelector('.command-palette input'));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(label)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(() => [...document.querySelectorAll('.palette-results [role="option"][aria-selected="true"]')]
      .find((option) => option.textContent.includes(${JSON.stringify(label)})));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  })()`)
  const settle = (code: string, label: string): Promise<void> => renderer<void>(`(async () => {
    const end = Date.now() + 10000;
    while (Date.now() < end) {
      const value = (() => { ${code} })();
      if (value) return;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('select self-test: ' + ${JSON.stringify(label)});
  })()`)
  const preferencesPage = async (page: string, opener: string): Promise<void> => {
    await settle(`if (document.querySelector('.preferences-dialog[open]')) return true;
      document.querySelector('.preferences-button')?.click(); return false;`, 'preferences open')
    await settle(`const item = [...document.querySelectorAll('.preferences-nav .nav-item')]
        .find((candidate) => candidate.textContent.trim().startsWith(${JSON.stringify(page)}));
      item?.click();
      const opener = document.querySelector(${JSON.stringify(opener)});
      if (!opener || !opener.getClientRects().length) return false;
      opener.scrollIntoView({ block: 'center' });
      return true;`, `preferences ${page}`)
    await pause(300)
  }
  const launcher = async (opener: string): Promise<void> => {
    if (!(await look(opener))?.x) {
      await palette('New session…')
    }
    await settle(`const advanced = document.querySelector('.session-launcher details.advanced');
        if (!advanced) return false;
        advanced.open = true;
        const opener = document.querySelector(${JSON.stringify(opener)});
        if (!opener) return false;
        opener.scrollIntoView({ block: 'center' });
        const box = opener.getBoundingClientRect();
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return box.width > 0 && box.height > 0 && hit && opener.contains(hit);`, 'launcher choice exposed')
    await pause(200)
  }

  const sites: Site[] = [
    {
      name: 'whenWindowsClose',
      opener: '.session-launcher .select-opener[data-label="When windows close"]',
      outside: '.session-launcher .panel-heading .eyebrow',
      show: () => launcher('.session-launcher .select-opener[data-label="When windows close"]'),
      target: () => 'stop',
      letter: 's'
    },
    {
      name: 'terminalImages',
      opener: '.session-launcher .select-opener[data-label="Terminal images (Sixel)"]',
      outside: '.session-launcher .panel-heading .eyebrow',
      show: () => launcher('.session-launcher .select-opener[data-label="Terminal images (Sixel)"]'),
      target: () => 'standard'
    },
    {
      name: 'sendToSession',
      opener: 'dialog.file-reference-dialog .select-opener[data-label="Send to session"]',
      outside: 'dialog.file-reference-dialog .app-dialog-heading h2',
      show: async () => {
        await palette('Open file reference')
        await settle(`const dialog = document.querySelector('dialog.file-reference-dialog[open]');
          const input = dialog?.querySelector('input[aria-label="File reference"]');
          if (!input) return false;
          if (!dialog.querySelector('.file-reference-send')) {
            if (!dialog.dataset.selectSelfTest) {
              dialog.dataset.selectSelfTest = 'read';
              Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'refs/src/parser.ts:42:7');
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.closest('form').requestSubmit();
            }
            return false;
          }
          return true;`, 'file reference read')
      },
      // The last session in the list: the keyboard walks down to it.
      target: (rows) => rows.at(-1) ?? ''
    },
    {
      name: 'notifyOn',
      opener: '#preferences-telegram-notify-on',
      outside: '.preferences-dialog .app-dialog-heading h2',
      show: () => preferencesPage('Notifications', '#preferences-telegram-notify-on'),
      target: (rows, before) => rows.find((row) => row !== before) ?? ''
    },
    {
      name: 'language',
      opener: '#preferences-voice-language',
      outside: '.preferences-dialog .app-dialog-heading h2',
      show: () => preferencesPage('Voice', '#preferences-voice-language'),
      // Type-ahead: "p" goes to Polski, the first language starting with it.
      target: () => 'pl',
      letter: 'p',
      saved: async () => (await renderer<{ voice: { language: string } }>('window.aiTerminal.getSettings()')).voice.language
    }
  ]

  const clockBefore = Date.now()
  const rendererClock = await renderer<number>(`(() => {
    const nodes = new WeakMap(); let next = 0; let sequence = 0; let overflow = 0;
    const events = []; const changes = [];
    const identify = (element) => {
      if (!element || !(element instanceof Element)) return null;
      if (!nodes.has(element)) nodes.set(element, ++next);
      return { node: nodes.get(element), tag: element.tagName, id: element.id, className: element.className,
        label: element.getAttribute('data-label'), connected: element.isConnected };
    };
    const append = (list, entry) => { list.push({ sequence: ++sequence, ...entry }); if (list.length > 350) {list.shift(); overflow++;} };
    const listener = (event) => append(events, { phase: window.__bmnSelectDiagnostics.phase, type: event.type,
      focusAttemptInputId: window.__bmnSelectDiagnostics.focusAttemptInputId,
      key: event.key ?? null, target: identify(event.target), active: identify(document.activeElement), trusted: event.isTrusted });
    for (const type of ['keydown', 'keyup', 'pointerdown', 'focusin', 'focusout']) document.addEventListener(type, listener, true);
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const target = record.target instanceof Element ? record.target : record.target.parentElement;
        if (target?.matches('dialog,.select-list,.select-opener,details.advanced') ||
          [...record.addedNodes, ...record.removedNodes].some(node => node instanceof Element && node.matches('.select-list,dialog'))) {
          append(changes, { phase: window.__bmnSelectDiagnostics.phase, type: record.type, attribute: record.attributeName, target: identify(target) });
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['open', 'disabled', 'aria-expanded', 'inert'] });
    const snapshot = (opener, box = opener.getBoundingClientRect()) => ({ rendererTime: Date.now(),
      opener: identify(opener), matches: document.querySelectorAll('.session-launcher .select-opener').length,
      documentFocused: document.hasFocus(), active: identify(document.activeElement), disabled: opener.disabled,
      effectiveDisabled: opener.matches(':disabled'), inert: !!opener.closest('[inert]'),
      fieldset: opener.closest('fieldset')?.disabled ?? null, advanced: opener.closest('details')?.open ?? null,
      bounds: { x: box.x, y: box.y, width: box.width, height: box.height },
      hit: identify(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)),
      modals: [...document.querySelectorAll('dialog[open]')].map(dialog => ({ ...identify(dialog), modal: dialog.matches(':modal') })),
      menus: [...document.querySelectorAll('.select-list')].map(menu => ({ ...identify(menu), label: menu.getAttribute('aria-label') })) });
    window.__bmnSelectDiagnostics = { phase: 'setup', snapshot, read: () => ({ rendererTime: Date.now(), sequence,
      overflow, events, changes, openers: [...document.querySelectorAll('.session-launcher .select-opener')].map(opener => snapshot(opener)) }),
      dispose: () => { observer.disconnect(); for (const type of ['keydown', 'keyup', 'pointerdown', 'focusin', 'focusout']) document.removeEventListener(type, listener, true); } };
    return Date.now();
  })()`)
  mark('loaded', { functionHash: createHash('sha256').update(runSelectMenusSelfTest.toString()).digest('hex'),
    loadedMain: __filename, loadedMainHash: createHash('sha256').update(readFileSync(__filename)).digest('hex'),
    electron: process.versions.electron, clock: { before: clockBefore, renderer: rendererClock, after: Date.now() } })
  window.webContents.on('before-input-event', delivery)
  try {
  window.webContents.focus()
  const receipts: Record<string, SelectMenuSiteReceipt> = {}
  for (const site of sites) {
    mark(`${site.name}:start`)
    await site.show()
    const opener = site.opener
    const before = (await now(opener)).value
    await renderer<void>(`window.__bmnSelectDiagnostics.phase = ${JSON.stringify(phase)}; window.__bmnSelectDiagnostics.focusAttemptInputId = ${inputId + 1}; document.querySelector(${JSON.stringify(opener)}).focus()`)

    // Keyboard: ArrowDown opens on the current value, ArrowDown moves, Escape changes nothing and refocuses the opener.
    key('ArrowDown')
    const opened = await until(opener, (state) => state.list && state.expanded === 'true')
    const openedOnValue = await until(opener, (state) => state.focusValue === before)
    const rows = (await now(opener)).rows
    const next = rows[(rows.indexOf(before) + 1) % rows.length]
    key('ArrowDown')
    const moved = await until(opener, (state) => state.focusValue === next)
    key('Escape')
    const escaped = await until(opener, (state) => !state.list && state.expanded === 'false')
    const escapeKeptValue = escaped && (await now(opener)).value === before
    const escapeFocusedOpener = (await now(opener)).focusOpener
    // Enter opens; End and Home jump; the target is reached by type-ahead or by ArrowDown; Space chooses.
    key('Enter')
    await until(opener, (state) => state.focusValue === before)
    key('End')
    const atEnd = await until(opener, (state) => state.focusValue === rows.at(-1))
    key('Home')
    const homeEnd = atEnd && await until(opener, (state) => state.focusValue === rows[0])
    const target = site.target(rows, before)
    if (site.letter) key(site.letter)
    else for (let step = 0; step < rows.length && (await now(opener)).focusValue !== target; step += 1) {
      key('ArrowDown')
      await pause(60)
    }
    await until(opener, (state) => state.focusValue === target)
    key(' ')
    const chose = await until(opener, (state) => !state.list && state.value === target)
    const choseFocusedOpener = await until(opener, (state) => state.focusOpener)
    const savedKeyboard = site.saved ? await site.saved() : undefined
    // Tab closes without a change and moves on from the opener.
    key('ArrowUp')
    await until(opener, (state) => state.list)
    key('ArrowDown')
    await pause(60)
    key('Tab')
    const tabClosedUnchanged = await until(opener, (state) => !state.list && state.value === target &&
      !state.focusOpener && !state.focusBody)

    // Mouse: a click opens, a click outside changes nothing, a second click on the opener closes, a row click chooses.
    const point = await now(opener)
    clickAt(point.x, point.y)
    const mouseOpened = await until(opener, (state) => state.list && state.expanded === 'true')
    await clickOn(site.outside)
    const outsideKeptValue = await until(opener, (state) => !state.list && state.value === target)
    clickAt(point.x, point.y)
    await until(opener, (state) => state.list)
    clickAt(point.x, point.y)
    const toggledClosed = await until(opener, (state) => !state.list && state.expanded === 'false' && state.value === target)
    clickAt(point.x, point.y)
    await until(opener, (state) => state.list)
    await clickOn(`.popup-menu.select-list [role="menuitemradio"][data-value=${JSON.stringify(before)}]`)
    const mouseChose = await until(opener, (state) => !state.list && state.value === before)
    const mouseFocusedOpener = await until(opener, (state) => state.focusOpener)
    const savedMouse = site.saved ? await site.saved() : undefined

    const receipt: SelectMenuSiteReceipt = {
      keyboard: { opened, openedOnValue, moved, escapeKeptValue, escapeFocusedOpener, homeEnd, chose, choseFocusedOpener, tabClosedUnchanged },
      mouse: { opened: mouseOpened, outsideKeptValue, toggledClosed, chose: mouseChose, choseFocusedOpener: mouseFocusedOpener },
      values: { before, keyboard: target, mouse: (await now(opener)).value },
      ...(savedKeyboard !== undefined && savedMouse !== undefined ? { saved: { keyboard: savedKeyboard, mouse: savedMouse } } : {})
    }
    const failed = [
      ...Object.entries(receipt.keyboard).filter(([, value]) => !value).map(([name]) => `keyboard.${name}`),
      ...Object.entries(receipt.mouse).filter(([, value]) => !value).map(([name]) => `mouse.${name}`),
      ...(target === before ? ['target equals the starting value'] : []),
      ...(receipt.saved && (receipt.saved.keyboard !== target || receipt.saved.mouse !== before) ? ['saved value'] : [])
    ]
    if (failed.length > 0) {
      await capture(`${site.name}:failed`, { receipt, failed })
      throw new Error(`select self-test ${site.name} failed: ${failed.join(', ')} ${JSON.stringify({ receipt, rows })}`)
    }
    receipts[site.name] = receipt
    completed[site.name] = receipt
    mark(`${site.name}:passed`, { receipt })
  }
  // Exercise the production launcher bindings: wrapper-only disabled props cannot catch a missing call-site prop.
  const archiveFixture = await renderer<{ id: string; previousName: string; showedArchived: boolean }>(`(async () => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    document.querySelector('.session-launcher button[aria-label="Close new session"]')?.click();
    const workspaces = await window.aiTerminal.listWorkspaces();
    const selected = document.querySelector('.workspace-group:has(.session-row.selected)')?.getAttribute('aria-label');
    const previous = workspaces.find(item => item.name === selected) ?? workspaces[0];
    const checkbox = document.querySelector('.show-archived input');
    const showedArchived = checkbox.checked;
    if (!showedArchived) checkbox.click();
    const fixture = await window.aiTerminal.createWorkspace({ name: 'Select disabled fixture', defaultCwd: previous.defaultCwd });
    return { id: fixture.workspaceId, previousName: previous.name, showedArchived };
  })()`)
  mark('archive:fixture-created', { archiveFixture })
  await settle(`const group = [...document.querySelectorAll('.workspace-group')]
    .find(item => item.getAttribute('aria-label') === 'Select disabled fixture');
    if (!group) return false;
    group.querySelector('.workspace-row > button').click(); return true;`, 'archive fixture selected')
  await palette('New session…')
  const archiveOpeners = sites.slice(0, 2).map((site) => site.opener)
  await launcher(archiveOpeners[0]!)
  const setArchived = (archived: boolean): Promise<void> => renderer<void>(`(async () => {
    const workspace = (await window.aiTerminal.listWorkspaces(true)).find(item => item.workspaceId === ${JSON.stringify(archiveFixture.id)});
    await window.aiTerminal.updateWorkspace({ workspaceId: workspace.workspaceId, expectedRevision: workspace.revision, archived: ${archived} });
  })()`)
  let archiveFailure: unknown = null
  try {
    await setArchived(true)
    mark('archive:acknowledged')
    await settle(`return ${JSON.stringify(archiveOpeners)}.every(selector => document.querySelector(selector)?.disabled === true);`, 'archived launcher choices disabled')
    for (const opener of archiveOpeners) {
      await launcher(opener)
      mark('archive:disabled-attempt', { opener })
      const point = await now(opener)
      clickAt(point.x, point.y)
      await renderer<void>(`window.__bmnSelectDiagnostics.phase = ${JSON.stringify(phase)}; window.__bmnSelectDiagnostics.focusAttemptInputId = ${inputId + 1}; document.querySelector(${JSON.stringify(opener)}).focus()`)
      key('ArrowDown')
      await pause(60)
      if ((await now(opener)).expanded !== 'false') throw new Error('an archived launcher choice opened')
      mark('archive:disabled-rejected', { opener, state: await now(opener) })
    }
    await setArchived(false)
    mark('restore:acknowledged')
    await settle(`return ${JSON.stringify(archiveOpeners)}.every(selector => document.querySelector(selector)?.disabled === false);`, 'restored launcher choices enabled')
    for (const opener of archiveOpeners) {
      await launcher(opener)
      mark('restore:opening-attempt', { opener })
      await renderer<void>(`window.__bmnSelectDiagnostics.phase = ${JSON.stringify(phase)}; window.__bmnSelectDiagnostics.focusAttemptInputId = ${inputId + 1}; document.querySelector(${JSON.stringify(opener)}).focus()`)
      key('ArrowDown')
      if (!await until(opener, (state) => state.list)) throw new Error(`a restored launcher choice did not open: ${opener}`)
      mark('restore:opened', { opener, state: await now(opener) })
      key('Escape')
      if (!await until(opener, (state) => !state.list && state.focusOpener)) throw new Error(`a restored launcher choice did not close and return focus: ${opener}`)
      mark('restore:escaped', { opener, state: await now(opener) })
    }
    receipts.whenWindowsClose!.unavailableWhileArchived = true
    receipts.terminalImages!.unavailableWhileArchived = true
  } catch (error) {
    archiveFailure = error
    await capture('archive:failure-before-cleanup', { failedPhase: phase })
  } finally {
    try {
    await setArchived(false)
    await renderer<void>(`(() => {
      document.querySelector('.session-launcher button[aria-label="Close new session"]')?.click();
      const group = [...document.querySelectorAll('.workspace-group')]
        .find(item => item.getAttribute('aria-label') === ${JSON.stringify(archiveFixture.previousName)});
      group?.querySelector('.workspace-row > button').click();
      const checkbox = document.querySelector('.show-archived input');
      if (checkbox.checked !== ${archiveFixture.showedArchived}) checkbox.click();
    })()`)
    } catch (cleanupError) {
      if (archiveFailure === null) archiveFailure = cleanupError
      else console.error('[BMN select diagnostic] archive cleanup failed; original failure retained')
    }
  }
  if (archiveFailure !== null) throw archiveFailure
  // Leave the window as it was found: no dialog and no launcher open.
  await renderer<void>(`(() => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    document.querySelector('.session-launcher button[aria-label="Close new session"]')?.click();
  })()`)
  return { sites: receipts, archiveWorkspaceId: archiveFixture.id }
  } catch (error) {
    await capture('outer:failure', { failedPhase: phase })
    throw error
  } finally {
    window.webContents.removeListener('before-input-event', delivery)
    await renderer<void>('window.__bmnSelectDiagnostics?.dispose()').catch(() => undefined)
  }
}
