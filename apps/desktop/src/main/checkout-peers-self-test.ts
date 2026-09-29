import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

/** Drives the real renderer and host routes with an isolated Git checkout and synthetic sessions. */
export async function runCheckoutPeersSelfTest(window: BrowserWindow, params: {
  directory: string
  workspaceId: string
  workspaceName: string
  peerWorkspaceId: string
  peerWorkspaceName: string
}): Promise<{ latePeerBlocked: boolean; secondClickStarted: boolean; bothPreviewsNamedPeer: boolean;
  previewPreservedTerminal: boolean; setPreviewDidNotStart: boolean }> {
  const checkout = join(params.directory, 'checkout-peer-probe')
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['-C', checkout, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', checkout, '-c', 'user.name=BMN Test', '-c', 'user.email=bmn@example.invalid',
    'commit', '--allow-empty', '-qm', 'fixture'])
  const executable = join(params.directory, 'launch-set-good')
  const ordinary = await window.webContents.executeJavaScript(`(async () => {
    const checkout = ${JSON.stringify(checkout)};
    const executable = ${JSON.stringify(executable)};
    const workspaceId = ${JSON.stringify(params.workspaceId)};
    const workspaceName = ${JSON.stringify(params.workspaceName)};
    const peerWorkspaceId = ${JSON.stringify(params.peerWorkspaceId)};
    const peerName = 'Different command checkout peer';
    const wait = async (read, label) => {
      const deadline = Date.now() + 12000;
      for (;;) {
        const result = await read();
        if (result) return result;
        if (Date.now() > deadline) throw new Error('checkout peers: ' + label);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const button = (scope, label) => [...scope.querySelectorAll('button')]
      .find(item => item.textContent.trim() === label);
    const setInput = (input, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const previousDialog = document.querySelector('.launch-sets-dialog[open]');
    previousDialog?.querySelector('[aria-label^="Close Launch sets"]')?.click();
    await wait(() => !document.querySelector('.launch-sets-dialog[open]'), 'close prior set dialog');
    const group = [...document.querySelectorAll('.workspace-group')]
      .find(item => item.getAttribute('aria-label') === workspaceName);
    group.querySelector('.workspace-row .row-menu-button').click();
    const newSession = await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
      .find(item => item.textContent.trim() === 'New session here'), 'new session menu');
    newSession.click();
    const form = await wait(() => document.querySelector('.create-form'), 'new session form');
    setInput(form.querySelector('[aria-label="Session name"]'), 'Reviewed checkout launch');
    setInput(form.querySelector('[aria-label="Working directory"]'), checkout);
    setInput(form.querySelector('[aria-label="Executable"]'), executable);
    await wait(() => form.querySelector('.repository-identity')?.textContent.includes('Branch main') &&
      !form.querySelector('button[type="submit"]').disabled, 'initial checkout preview');
    if (form.textContent.includes('share this checkout')) throw new Error('clear checkout was reported as shared');
    const before = (await window.aiTerminal.listSessions(workspaceId)).length;
    const terminalsBefore = window.__aitermTest?.snapshots() ?? {};
    await window.aiTerminal.createSession({ workspaceId: peerWorkspaceId, name: peerName,
      cwd: checkout, executable, argv: ['--different-command'], cols: 80, rows: 24 });
    form.querySelector('button[type="submit"]').click();
    const warning = await wait(() => form.textContent.includes('Review the warning before starting.') &&
      form.textContent.includes(peerName) ? form.textContent : null, 'new peer review');
    const latePeerBlocked = (await window.aiTerminal.listSessions(workspaceId)).length === before;
    const terminalsAfter = window.__aitermTest?.snapshots() ?? {};
    const previewPreservedTerminal = Object.entries(terminalsBefore).every(([id, state]) =>
      terminalsAfter[id]?.inputEvents === state.inputEvents && terminalsAfter[id]?.refits === state.refits);
    if (!warning.includes('may edit the same files')) throw new Error('checkout warning lacks file-sharing consequence');
    await wait(() => !form.querySelector('button[type="submit"]').disabled, 'second start enabled');
    form.querySelector('button[type="submit"]').click();
    const secondClickStarted = !!await wait(async () =>
      (await window.aiTerminal.listSessions(workspaceId)).length === before + 1, 'reviewed start');
    return { latePeerBlocked, secondClickStarted, previewPreservedTerminal };
  })()`) as { latePeerBlocked: boolean; secondClickStarted: boolean; previewPreservedTerminal: boolean }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('checkout peer renderer reload timed out')), 8000)
    window.webContents.once('did-finish-load', () => { clearTimeout(timer); resolve() })
    window.webContents.reload()
  })
  const setPreview = await window.webContents.executeJavaScript(`(async () => {
    const checkout = ${JSON.stringify(checkout)};
    const executable = ${JSON.stringify(executable)};
    const workspaceId = ${JSON.stringify(params.workspaceId)};
    const workspaceName = ${JSON.stringify(params.workspaceName)};
    const peerWorkspaceName = ${JSON.stringify(params.peerWorkspaceName)};
    const wait = async (read, label) => {
      const deadline = Date.now() + 12000;
      for (;;) {
        const result = await read();
        if (result) return result;
        if (Date.now() > deadline) throw new Error('checkout peer set: ' + label);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    await wait(() => [...document.querySelectorAll('.workspace-group')]
      .some(item => item.getAttribute('aria-label') === workspaceName), 'workspace startup');
    const saved = await window.aiTerminal.createLaunchSet({ workspaceId, name: 'Checkout peer preview set',
      entries: [{ entryId: crypto.randomUUID(), name: 'Set entry', executable,
        argv: ['--set-command'], backgroundChoice: null, terminalGraphics: null }] });
    const before = (await window.aiTerminal.listSessions(workspaceId)).length;
    const group = [...document.querySelectorAll('.workspace-group')]
      .find(item => item.getAttribute('aria-label') === workspaceName);
    group.querySelector('.workspace-row .row-menu-button').click();
    const menu = await wait(() => [...document.querySelectorAll('.popup-menu [role="menuitem"]')]
      .find(item => item.textContent.trim() === 'Save a launch set…'), 'manage menu');
    menu.click();
    const dialog = await wait(() => document.querySelector('.launch-sets-dialog[open]'), 'set dialog');
    const picker = await wait(() => dialog.querySelector('[aria-label="Saved launch set"]'), 'set picker');
    picker.value = saved.setId;
    picker.dispatchEvent(new Event('change', { bubbles: true }));
    await wait(() => [...dialog.querySelectorAll('button')].some(item => item.textContent.trim() === 'Launch set…'),
      'launch button');
    [...dialog.querySelectorAll('button')].find(item => item.textContent.trim() === 'Launch set…').click();
    const input = await wait(() => dialog.querySelector('[aria-label="Set launch directory"]'), 'launch preview');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, checkout);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const warning = await wait(() => dialog.textContent.includes('share this checkout') &&
      dialog.textContent.includes(peerWorkspaceName + ' / Different command checkout peer')
      ? dialog.textContent : null, 'cross-workspace peer warning');
    const bothPreviewsNamedPeer = warning.includes('Reviewed checkout launch') &&
      dialog.querySelectorAll('.inline-warning').length === 1;
    const setPreviewDidNotStart = (await window.aiTerminal.listSessions(workspaceId)).length === before;
    dialog.querySelector('[aria-label^="Close Launch sets"]')?.click();
    return { bothPreviewsNamedPeer, setPreviewDidNotStart };
  })()`) as { bothPreviewsNamedPeer: boolean; setPreviewDidNotStart: boolean }
  return { ...ordinary, ...setPreview }
}
