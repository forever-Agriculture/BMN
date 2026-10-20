// MODULE: select-menus.ts - Electron self-test for BMN's select (Story 80.4 AC2): each of the five driven by real keys and real clicks
import type { BrowserWindow } from 'electron'

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
}

interface Look {
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

export async function runSelectMenusSelfTest(window: BrowserWindow): Promise<Record<string, SelectMenuSiteReceipt>> {
  const renderer = <T>(code: string): Promise<T> => window.webContents.executeJavaScript(code) as Promise<T>
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  const look = (opener: string): Promise<Look | null> => renderer<Look | null>(`(() => {
    const opener = document.querySelector(${JSON.stringify(opener)});
    if (!opener) return null;
    const list = document.querySelector('.popup-menu.select-list');
    const active = document.activeElement;
    const box = opener.getBoundingClientRect();
    return {
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
    const keyCode = keyCodes[name] ?? name
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
    if (name.length === 1) window.webContents.sendInputEvent({ type: 'char', keyCode })
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  }
  const clickAt = (x: number, y: number): void => {
    window.webContents.sendInputEvent({ type: 'mouseMove', x: Math.round(x), y: Math.round(y) })
    window.webContents.sendInputEvent({ type: 'mouseDown', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
    window.webContents.sendInputEvent({ type: 'mouseUp', x: Math.round(x), y: Math.round(y), button: 'left', clickCount: 1 })
  }
  const centre = (selector: string): Promise<{ x: number; y: number }> => renderer<{ x: number; y: number }>(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('select self-test: nothing at ' + ${JSON.stringify(selector)});
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
      await settle(`const advanced = document.querySelector('.session-launcher details.advanced');
        if (!advanced) return false;
        advanced.open = true;
        return !!document.querySelector(${JSON.stringify(opener)})?.getClientRects().length;`, 'launcher open')
    }
    await renderer<void>(`document.querySelector(${JSON.stringify(opener)}).scrollIntoView({ block: 'center' })`)
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

  window.webContents.focus()
  const receipts: Record<string, SelectMenuSiteReceipt> = {}
  for (const site of sites) {
    await site.show()
    const opener = site.opener
    const before = (await now(opener)).value
    await renderer<void>(`document.querySelector(${JSON.stringify(opener)}).focus()`)

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
      throw new Error(`select self-test ${site.name} failed: ${failed.join(', ')} ${JSON.stringify({ receipt, rows })}`)
    }
    receipts[site.name] = receipt
  }
  // Leave the window as it was found: no dialog and no launcher open.
  await renderer<void>(`(() => {
    for (const dialog of document.querySelectorAll('dialog[open]')) dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
    document.querySelector('.session-launcher button[aria-label="Close new session"]')?.click();
  })()`)
  return receipts
}
