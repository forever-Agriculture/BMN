import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

interface ProbeResult {
  gitVersion: string
  savedWithoutStart: boolean
  previewBranch: string
  changedBranchBlocked: boolean
  startedOrder: string[]
  selectionPreserved: boolean
  partialOutcomes: string[]
  retryAddedSessions: number
  reconnectAddedSessions: number
  detailRoots: string[]
  ordinaryChangedBlocked: boolean
  nonRepositoryStarted: boolean
  failedSessionLinked: boolean
  preparationPreservedTerminals: boolean
  keyboardFocusInDialog: boolean
  editDeletePreservedSessions: boolean
  reorderedEntries: string[]
  cancelledPendingStart: boolean
  equivalentDirectoryWarning: boolean
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
}

/** Exercises the owner dialog and its real preload/utility routes in the isolated Electron window. */
export async function runLaunchSetRepositorySelfTest(
  window: BrowserWindow,
  params: { workspaceId: string; workspaceName: string; directory: string; existingSessionId: string },
  controls: { pauseNextSetRead(): { entered: Promise<void>; release(): void }; startRequestCount(): number }
): Promise<ProbeResult> {
  const repository = params.directory
  const nested = join(repository, 'nested-launch-repo')
  mkdirSync(nested, { recursive: true })
  git(repository, 'init', '-q', '-b', 'main')
  git(repository, '-c', 'user.name=BMN Test', '-c', 'user.email=bmn@example.invalid',
    'commit', '--allow-empty', '-qm', 'fixture')
  git(nested, 'init', '-q', '-b', 'main')
  git(nested, '-c', 'user.name=BMN Test', '-c', 'user.email=bmn@example.invalid',
    'commit', '--allow-empty', '-qm', 'fixture')
  const good = join(repository, 'launch-set-good')
  const plain = join(repository, '..', 'bmn-nonrepo-launch')
  mkdirSync(plain, { recursive: true })
  writeFileSync(good, `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}\nsetInterval(() => undefined, 1000)\n`)
  chmodSync(good, 0o755)
  const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()

  const prepared = await window.webContents.executeJavaScript(`(async () => {
    let stage = 'initial';
    try {
    const workspaceId = ${JSON.stringify(params.workspaceId)};
    const workspaceName = ${JSON.stringify(params.workspaceName)};
    const nested = ${JSON.stringify(nested)};
    const good = ${JSON.stringify(good)};
    const wait = async (read, label) => {
      const deadline = Date.now() + 8000;
      for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('launch set: ' + label);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const button = (scope, label) => [...scope.querySelectorAll('button')]
      .find(item => item.textContent.trim() === label);
    const openMenu = () => {
      const group = [...document.querySelectorAll('.workspace-group')]
        .find(item => item.getAttribute('aria-label') === workspaceName);
      if (!group) throw new Error('launch set workspace row missing');
      group.querySelector('.workspace-row .row-menu-button').click();
    };
    const menuItem = async label => {
      const item = await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
        .find(node => node.textContent.trim() === label), 'menu item ' + label);
      item.click();
    };
    const setInput = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    stage = 'list sessions before';
    const before = (await window.aiTerminal.listSessions(workspaceId)).length;
    const terminalBefore = window.__aitermTest?.snapshots() ?? {};
    stage = 'open manage';
    openMenu();
    await menuItem('Save a launch set…');
    let dialog = await wait(() => document.querySelector('.launch-sets-dialog[open]'), 'manage dialog');
    await wait(() => button(dialog, 'New set'), 'new set button');
    const keyboardFocusInDialog = dialog.contains(document.activeElement) &&
      button(dialog, 'New set').tabIndex === 0;
    button(dialog, 'New set').click();
    await wait(() => dialog.querySelector('[aria-label="Set name"]'), 'set editor');
    setInput(dialog.querySelector('[aria-label="Set name"]'), 'Daily synthetic set');
    setInput(dialog.querySelector('[aria-label="Entry 1 name"]'), 'First');
    setInput(dialog.querySelector('[aria-label="Entry 1 executable"]'), good);
    button(dialog, 'Add entry').click();
    await wait(() => dialog.querySelector('[aria-label="Entry 2 name"]'), 'second entry');
    setInput(dialog.querySelector('[aria-label="Entry 2 name"]'), 'Second');
    setInput(dialog.querySelector('[aria-label="Entry 2 executable"]'), good);
    button(dialog, 'Add entry').click();
    await wait(() => dialog.querySelector('[aria-label="Entry 3 name"]'), 'third entry');
    setInput(dialog.querySelector('[aria-label="Entry 3 name"]'), 'Third');
    setInput(dialog.querySelector('[aria-label="Entry 3 executable"]'), good);
    stage = 'save set';
    button(dialog, 'Save set').click();
    stage = 'list saved sets';
    const saved = await wait(async () => (await window.aiTerminal.listLaunchSets(workspaceId))[0], 'saved set');
    const savedWithoutStart = (await window.aiTerminal.listSessions(workspaceId)).length === before;
    dialog.querySelector('[aria-label="Close Launch sets in ' + workspaceName + '"]').click();
    await wait(() => !document.querySelector('.launch-sets-dialog[open]'), 'manage close');
    stage = 'open launch preview';
    openMenu();
    await menuItem('Launch set…');
    dialog = await wait(() => document.querySelector('.launch-sets-dialog[open]'), 'launch dialog');
    await wait(() => dialog.querySelector('[aria-label="Set launch directory"]'), 'launch preview');
    setInput(dialog.querySelector('[aria-label="Set launch directory"]'), nested);
    const previewBranch = await wait(() => dialog.querySelector('.repository-identity')?.textContent.includes('Branch main')
      ? dialog.querySelector('.repository-identity').textContent : null, 'repository preview');
    if (!dialog.textContent.includes('First') || !dialog.textContent.includes(good))
      throw new Error('launch set exact command preview missing');
    const terminalAfter = window.__aitermTest?.snapshots() ?? {};
    const preparationPreservedTerminals = Object.keys(terminalBefore).length > 0 &&
      Object.entries(terminalBefore).every(([id, state]) => {
        const after = terminalAfter[id];
        return after?.inputEvents === state.inputEvents && after?.refits === state.refits;
      });
    return { saved, before, savedWithoutStart, previewBranch,
      preparationPreservedTerminals, keyboardFocusInDialog };
    } catch (error) { throw new Error('prepared/' + stage + ': ' + (error?.message ?? JSON.stringify(error))); }
  })()`) as { saved: { setId: string }; before: number; savedWithoutStart: boolean;
    previewBranch: string; preparationPreservedTerminals: boolean; keyboardFocusInDialog: boolean }

  const beforeCancelledStart = controls.startRequestCount()
  const heldRead = controls.pauseNextSetRead()
  try {
    await window.webContents.executeJavaScript(`(async () => {
      const dialog = document.querySelector('.launch-sets-dialog[open]');
      const start = [...dialog.querySelectorAll('button')]
        .find(item => item.textContent.trim() === 'Start 3 new sessions');
      if (!start || start.disabled) throw new Error('cancel probe start unavailable');
      start.click();
    })()`)
    await Promise.race([
      heldRead.entered,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('held set read was not entered')), 8000))
    ])
    await window.webContents.executeJavaScript(`(async () => {
      const dialog = document.querySelector('.launch-sets-dialog[open]');
      const cancel = [...dialog.querySelectorAll('button')]
        .find(item => item.textContent.trim() === 'Cancel');
      if (!cancel) throw new Error('cancel probe button unavailable');
      cancel.click();
    })()`)
  } finally { heldRead.release() }
  await new Promise((resolve) => setTimeout(resolve, 500))
  const restoredPreview = await window.webContents.executeJavaScript(`(async () => {
      const dialog = document.querySelector('.launch-sets-dialog[open]');
      if (!dialog || dialog.textContent.includes('Launch results')) return false;
      const button = [...dialog.querySelectorAll('button')]
        .find(item => item.textContent.trim() === 'Launch set…');
      if (!button) return false;
      button.click();
      const deadline = Date.now() + 8000;
      while (!dialog.querySelector('[aria-label="Set launch directory"]')) {
        if (Date.now() > deadline) throw new Error('cancel probe reopen failed');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      const input = dialog.querySelector('[aria-label="Set launch directory"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, ${JSON.stringify(nested + '/')});
      input.dispatchEvent(new Event('input', { bubbles: true }));
      while (!dialog.querySelector('.repository-identity')?.textContent.includes('Branch main')) {
        if (Date.now() > deadline) throw new Error('cancel probe identity did not settle');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      return true;
    })()`) as boolean
  const cancelledPendingStart = controls.startRequestCount() === beforeCancelledStart && restoredPreview
  if (!cancelledPendingStart) throw new Error('cancelled pending launch-set start dispatched or changed the dialog')

  git(nested, 'checkout', '-qb', 'feature')
  const launched = await window.webContents.executeJavaScript(`(async () => {
    try {
    const workspaceId = ${JSON.stringify(params.workspaceId)};
    const before = ${prepared.before};
    const wait = async (read, label) => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('launch set: ' + label);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const dialog = document.querySelector('.launch-sets-dialog[open]');
    const start = () => [...dialog.querySelectorAll('button')]
      .find(item => item.textContent.trim() === 'Start 3 new sessions');
    const selectedBefore = (await window.aiTerminal.getLayout(workspaceId)).layout.selectedSessionId;
    await wait(() => start() && !start().disabled, 'start enabled');
    start().click();
    const changedBranchBlocked = !!await wait(() => dialog.textContent.includes('Repository identity changed.')
      ? true : null, 'changed branch review');
    if ((await window.aiTerminal.listSessions(workspaceId)).length !== before)
      throw new Error('a changed repository identity started a session');
    await wait(() => start() && !start().disabled, 'reviewed start enabled');
    start().click();
    await wait(() => dialog.textContent.includes('Launch results'), 'three launch results');
    const created = (await window.aiTerminal.listSessions(workspaceId)).slice(before);
    const selectedAfter = (await window.aiTerminal.getLayout(workspaceId)).layout.selectedSessionId;
    const review = [...dialog.querySelectorAll('button')]
      .find(item => item.textContent.trim() === 'Review a fresh launch');
    if (!review) throw new Error('fresh launch review unavailable');
    review.click();
    const input = await wait(() => dialog.querySelector('[aria-label="Set launch directory"]'), 'fresh directory');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, ${JSON.stringify(nested + '/')});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const equivalentDirectoryWarning = !!await wait(() =>
      dialog.textContent.includes('Similar live sessions already use this directory and command:') &&
      dialog.textContent.includes('First') && dialog.textContent.includes('Second') &&
      dialog.textContent.includes('Third'), 'equivalent directory duplicate warning');
    return {
      changedBranchBlocked,
      startedOrder: created.map(item => item.name),
      startedSessionId: created[0]?.sessionId,
      selectionPreserved: selectedBefore === selectedAfter,
      equivalentDirectoryWarning
    };
    } catch (error) { throw new Error('launched: ' + (error?.message ?? JSON.stringify(error))); }
  })()`) as { changedBranchBlocked: boolean; startedOrder: string[]; startedSessionId: string;
    selectionPreserved: boolean; equivalentDirectoryWarning: boolean }

  const partial = await window.webContents.executeJavaScript(`(async () => {
    try {
    const workspaceId = ${JSON.stringify(params.workspaceId)};
    const directory = ${JSON.stringify(nested)};
    const good = ${JSON.stringify(good)};
    const entries = [0, 1, 2].map(index => ({
      entryId: crypto.randomUUID(), name: 'Partial ' + index, executable: good,
      argv: index === 1 ? ['--bmn-self-test-fail-after-start'] : [], backgroundChoice: null
    }));
    const set = await window.aiTerminal.createLaunchSet({ workspaceId, name: 'Partial synthetic set', entries });
    const before = (await window.aiTerminal.listSessions(workspaceId)).length;
    const request = { workspaceId, setId: set.setId, expectedRevision: set.revision,
      directory, idempotencyKey: crypto.randomUUID(), cols: 80, rows: 24 };
    const [first, retry] = await Promise.all([
      window.aiTerminal.startLaunchSet(request), window.aiTerminal.startLaunchSet(request)
    ]);
    const after = (await window.aiTerminal.listSessions(workspaceId)).length;
    return { request, partialOutcomes: first.entries.map(entry => entry.outcome),
      failedSessionLinked: !!first.entries[1]?.sessionId &&
        first.sessions.some(session => session.sessionId === first.entries[1].sessionId),
      retryMatches: JSON.stringify(first.entries) === JSON.stringify(retry.entries),
      retryAddedSessions: after - before };
    } catch (error) { throw new Error('partial: ' + (error?.message ?? JSON.stringify(error))); }
  })()`) as { request: object; partialOutcomes: string[]; failedSessionLinked: boolean; retryMatches: boolean; retryAddedSessions: number }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('launch set renderer reconnect timed out')), 8000)
    window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve() })
    window.webContents.reload()
  })
  const reconnected = await window.webContents.executeJavaScript(`(async () => {
    try {
    const workspaceId = ${JSON.stringify(params.workspaceId)};
    await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('reconnected terminal startup timed out')), 8000);
      const unsubscribe = window.aiTerminal.onStartup(startup => {
        if (!startup.ok) return;
        clearTimeout(deadline);
        unsubscribe();
        resolve();
      });
    });
    const before = (await window.aiTerminal.listSessions(workspaceId)).length;
    await window.aiTerminal.startLaunchSet(${JSON.stringify(partial.request)});
    const after = (await window.aiTerminal.listSessions(workspaceId)).length;
    const wait = async (read, label) => {
      const deadline = Date.now() + 8000;
      for (;;) {
        const value = read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('repository details: ' + label);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const details = async sessionId => {
      const row = await wait(() => document.querySelector('.session-row > button[data-session-id="' + sessionId + '"]'), 'session row');
      row.click();
      const menu = row.parentElement.querySelector('.row-menu-button');
      menu.click();
      const item = await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
        .find(button => button.textContent.trim() === 'Session details'), 'details item');
      item.click();
      return await wait(() => document.querySelector('.session-inspector .repository-identity')?.textContent.includes('Repository root:')
        ? document.querySelector('.session-inspector .repository-identity').textContent : null, 'repository root');
    };
    const outer = await details(${JSON.stringify(params.existingSessionId)});
    const nested = await details(${JSON.stringify(launched.startedSessionId)});
    return { reconnectAddedSessions: after - before, detailRoots: [outer, nested] };
    } catch (error) { throw new Error('reconnected: ' + (error?.message ?? JSON.stringify(error))); }
  })()`) as { reconnectAddedSessions: number; detailRoots: string[] }

  const ordinaryPreview = await window.webContents.executeJavaScript(`(async () => {
    try {
    const workspaceName = ${JSON.stringify(params.workspaceName)};
    const nested = ${JSON.stringify(nested)};
    const good = ${JSON.stringify(good)};
    const wait = async (read, label) => {
      const deadline = Date.now() + 8000;
      for (;;) {
        const value = read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('ordinary preview: ' + label);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const group = [...document.querySelectorAll('.workspace-group')]
      .find(item => item.getAttribute('aria-label') === workspaceName);
    group.querySelector('.workspace-row .row-menu-button').click();
    const item = await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
      .find(button => button.textContent.trim() === 'New session here'), 'new session menu');
    item.click();
    const form = await wait(() => document.querySelector('.create-form'), 'new session form');
    const set = (label, value) => {
      const input = form.querySelector('[aria-label="' + label + '"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('Session name', 'Ordinary Git probe');
    set('Executable', good);
    set('Arguments', '');
    set('Working directory', nested);
    await wait(() => form.querySelector('.repository-identity')?.textContent.includes('Branch feature'), 'feature identity');
    return true;
    } catch (error) { throw new Error('ordinary preview: ' + (error?.message ?? JSON.stringify(error))); }
  })()`) as boolean
  git(nested, 'checkout', '-qb', 'reviewed')
  const ordinary = await window.webContents.executeJavaScript(`(async () => {
    try {
    const workspaceId = ${JSON.stringify(params.workspaceId)};
    const plain = ${JSON.stringify(plain)};
    const wait = async (read, label) => {
      const deadline = Date.now() + 10000;
      for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('ordinary launch: ' + label);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    let form = document.querySelector('.create-form');
    const before = (await window.aiTerminal.listSessions(workspaceId)).length;
    const start = () => form.querySelector('button[type="submit"]');
    await wait(() => !start().disabled, 'initial create enabled');
    start().click();
    const ordinaryChangedBlocked = !!await wait(() => form.textContent.includes('Repository identity changed.')
      ? true : null, 'changed branch review');
    if ((await window.aiTerminal.listSessions(workspaceId)).length !== before)
      throw new Error('changed branch started an ordinary session');
    await wait(() => !start().disabled, 'reviewed create enabled');
    start().click();
    await wait(async () => (await window.aiTerminal.listSessions(workspaceId)).length === before + 1,
      'ordinary session started');
    const group = document.querySelector('.workspace-group[aria-label=${JSON.stringify(params.workspaceName)}]');
    group.querySelector('.workspace-row .row-menu-button').click();
    const menu = await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
      .find(button => button.textContent.trim() === 'New session here'), 'new session menu again');
    menu.click();
    form = await wait(() => document.querySelector('.create-form'), 'non-repository form');
    const input = form.querySelector('[aria-label="Working directory"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, plain);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(() => form.querySelector('.repository-identity')?.textContent.includes('Not a Git repository'),
      'non-repository identity');
    await wait(() => !form.querySelector('button[type="submit"]').disabled, 'non-repository create enabled');
    form.querySelector('button[type="submit"]').click();
    const nonRepositoryStarted = !!await wait(async () =>
      (await window.aiTerminal.listSessions(workspaceId)).length === before + 2,
      'non-repository start');
    return { ordinaryChangedBlocked, nonRepositoryStarted };
    } catch (error) { throw new Error('ordinary launch: ' + (error?.message ?? JSON.stringify(error))); }
  })()`) as { ordinaryChangedBlocked: boolean; nonRepositoryStarted: boolean }

  const maintenance = await window.webContents.executeJavaScript(`(async () => {
    try {
    const workspaceId = ${JSON.stringify(params.workspaceId)};
    const workspaceName = ${JSON.stringify(params.workspaceName)};
    const setId = ${JSON.stringify(prepared.saved.setId)};
    const wait = async (read, label) => {
      const deadline = Date.now() + 8000;
      for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('set maintenance: ' + label);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const button = (scope, label) => [...scope.querySelectorAll('button')]
      .find(item => item.textContent.trim() === label);
    const group = [...document.querySelectorAll('.workspace-group')]
      .find(item => item.getAttribute('aria-label') === workspaceName);
    group.querySelector('.workspace-row .row-menu-button').click();
    const item = await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
      .find(node => node.textContent.trim() === 'Save a launch set…'), 'manage menu');
    item.click();
    const dialog = await wait(() => document.querySelector('.launch-sets-dialog[open]'), 'manage dialog');
    const picker = await wait(() => dialog.querySelector('[aria-label="Saved launch set"]'), 'set picker');
    picker.value = setId;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => button(dialog, 'Edit set'), 'edit set');
    button(dialog, 'Edit set').click();
    const name = await wait(() => dialog.querySelector('[aria-label="Set name"]'), 'set name');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(name, 'Daily revised');
    name.dispatchEvent(new Event('input', { bubbles: true }));
    const third = dialog.querySelectorAll('fieldset')[2];
    button(third, 'Move up').click();
    await wait(() => dialog.querySelector('[aria-label="Entry 2 name"]')?.value === 'Third',
      'entry reorder rendered');
    button(dialog, 'Save set').click();
    const revised = await wait(async () => {
      const current = await window.aiTerminal.getLaunchSet(workspaceId, setId);
      return current.revision === 2 ? current : null;
    }, 'revised set');
    const reorderedEntries = revised.entries.map(entry => entry.name);
    const beforeDelete = (await window.aiTerminal.listSessions(workspaceId)).length;
    await wait(() => button(dialog, 'Delete set…'), 'delete set');
    button(dialog, 'Delete set…').click();
    await wait(() => button(dialog, 'Confirm delete'), 'confirm delete');
    button(dialog, 'Confirm delete').click();
    await wait(async () => !(await window.aiTerminal.listLaunchSets(workspaceId))
      .some(set => set.setId === setId), 'set removed');
    return { reorderedEntries,
      editDeletePreservedSessions: (await window.aiTerminal.listSessions(workspaceId)).length === beforeDelete };
    } catch (error) { throw new Error('set maintenance: ' + (error?.message ?? JSON.stringify(error))); }
  })()`) as { reorderedEntries: string[]; editDeletePreservedSessions: boolean }

  return {
    gitVersion,
    savedWithoutStart: prepared.savedWithoutStart,
    previewBranch: prepared.previewBranch,
    changedBranchBlocked: launched.changedBranchBlocked,
    startedOrder: launched.startedOrder,
    selectionPreserved: launched.selectionPreserved,
    partialOutcomes: partial.partialOutcomes,
    retryAddedSessions: partial.retryMatches ? partial.retryAddedSessions : -1,
    reconnectAddedSessions: reconnected.reconnectAddedSessions,
    detailRoots: reconnected.detailRoots,
    ordinaryChangedBlocked: ordinaryPreview && ordinary.ordinaryChangedBlocked,
    nonRepositoryStarted: ordinary.nonRepositoryStarted,
    failedSessionLinked: partial.failedSessionLinked,
    preparationPreservedTerminals: prepared.preparationPreservedTerminals,
    keyboardFocusInDialog: prepared.keyboardFocusInDialog,
    editDeletePreservedSessions: maintenance.editDeletePreservedSessions,
    reorderedEntries: maintenance.reorderedEntries,
    cancelledPendingStart,
    equivalentDirectoryWarning: launched.equivalentDirectoryWarning
  }
}
