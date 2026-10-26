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
}): Promise<{ latePeerBlocked: boolean; secondClickStarted: boolean; previewPreservedTerminal: boolean; terminalEvidence?: unknown }> {
  const checkout = join(params.directory, 'checkout-peer-probe')
  mkdirSync(checkout, { recursive: true })
  execFileSync('git', ['-C', checkout, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', checkout, '-c', 'user.name=BMN Test', '-c', 'user.email=bmn@example.invalid',
    'commit', '--allow-empty', '-qm', 'fixture'])
  const executable = join(params.directory, 'repository-launch-good')
  return await window.webContents.executeJavaScript(`(async () => {
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
    const terminalsBeforeAt = performance.now();
    await window.aiTerminal.createSession({ workspaceId: peerWorkspaceId, name: peerName,
      cwd: checkout, executable, argv: ['--different-command'], cols: 80, rows: 24 });
    form.querySelector('button[type="submit"]').click();
    const warning = await wait(() => form.textContent.includes('Review the warning before starting.') &&
      form.textContent.includes(peerName) ? form.textContent : null, 'new peer review');
    const latePeerBlocked = (await window.aiTerminal.listSessions(workspaceId)).length === before;
    const terminalsAfter = window.__aitermTest?.snapshots() ?? {};
    const terminalsAfterAt = performance.now();
    const previewPreservedTerminal = Object.entries(terminalsBefore).every(([id, state]) =>
      terminalsAfter[id]?.inputEvents === state.inputEvents && terminalsAfter[id]?.refits === state.refits);
    if (!warning.includes('may edit the same files')) throw new Error('checkout warning lacks file-sharing consequence');
    await wait(() => !form.querySelector('button[type="submit"]').disabled, 'second start enabled');
    form.querySelector('button[type="submit"]').click();
    const secondClickStarted = !!await wait(async () =>
      (await window.aiTerminal.listSessions(workspaceId)).length === before + 1, 'reviewed start');
    // Observe only after both existing actions and their waits have finished.
    const normalize = (snapshots, id) => ({
      present: Object.hasOwn(snapshots, id),
      inputEvents: snapshots[id]?.inputEvents ?? null,
      refits: snapshots[id]?.refits ?? null,
      cols: snapshots[id]?.cols ?? null,
      rows: snapshots[id]?.rows ?? null
    });
    const terminalEvidence = {
      beforeAt: terminalsBeforeAt,
      afterAt: terminalsAfterAt,
      terminals: [...new Set([...Object.keys(terminalsBefore), ...Object.keys(terminalsAfter)])]
        .map(id => ({
          id,
          before: normalize(terminalsBefore, id),
          after: normalize(terminalsAfter, id),
          failedOriginalPredicate: Object.hasOwn(terminalsBefore, id) &&
            (terminalsAfter[id]?.inputEvents !== terminalsBefore[id].inputEvents ||
             terminalsAfter[id]?.refits !== terminalsBefore[id].refits)
        }))
    };
    console.warn('[BMN] checkout peer terminal evidence ' + JSON.stringify(terminalEvidence));
    return { latePeerBlocked, secondClickStarted, previewPreservedTerminal, terminalEvidence };
  })()`) as { latePeerBlocked: boolean; secondClickStarted: boolean; previewPreservedTerminal: boolean; terminalEvidence?: unknown }
}
