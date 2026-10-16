// MODULE: repository-launch-self-test.ts - Electron self-test of an ordinary New session's repository identity, changed branch and Session details roots
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'

interface ProbeResult {
  gitVersion: string
  previewBranch: string
  preparationPreservedTerminals: boolean
  ordinaryChangedBlocked: boolean
  nonRepositoryStarted: boolean
  detailRoots: string[]
}

function git(directory: string, ...args: string[]): string {
  return execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8' }).trim()
}

/**
 * Repository identity of an ordinary New session (Story 75.3 kept what the launch-set probe carried): the
 * preview names the branch without touching a live terminal, a branch changed after the preview stops the
 * start until reviewed, a folder outside Git starts, and Session details names each session's own root.
 */
export async function runRepositoryLaunchSelfTest(
  window: BrowserWindow,
  params: { workspaceId: string; workspaceName: string; directory: string; existingSessionId: string }
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
  const good = join(repository, 'repository-launch-good')
  const plain = join(repository, '..', 'bmn-nonrepo-launch')
  mkdirSync(plain, { recursive: true })
  writeFileSync(good, `#!${process.env.BMN_SELF_TEST_NODE ?? '/usr/bin/env node'}\nsetInterval(() => undefined, 1000)\n`)
  chmodSync(good, 0o755)
  const gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8' }).trim()

  const preview = await window.webContents.executeJavaScript(`(async () => {
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
    const terminalBefore = window.__aitermTest?.snapshots() ?? {};
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
    const previewBranch = await wait(() => form.querySelector('.repository-identity')?.textContent.includes('Branch main')
      ? form.querySelector('.repository-identity').textContent : null, 'repository preview');
    const terminalAfter = window.__aitermTest?.snapshots() ?? {};
    const preparationPreservedTerminals = Object.keys(terminalBefore).length > 0 &&
      Object.entries(terminalBefore).every(([id, state]) => {
        const after = terminalAfter[id];
        return after?.inputEvents === state.inputEvents && after?.refits === state.refits;
      });
    return { previewBranch, preparationPreservedTerminals };
    } catch (error) { throw new Error('ordinary preview: ' + (error?.message ?? JSON.stringify(error))); }
  })()`) as { previewBranch: string; preparationPreservedTerminals: boolean }
  git(nested, 'checkout', '-qb', 'feature')
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
    const started = await wait(async () => (await window.aiTerminal.listSessions(workspaceId))
      .find(session => session.name === 'Ordinary Git probe'), 'ordinary session started');
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
    return { ordinaryChangedBlocked, nonRepositoryStarted, startedSessionId: started.sessionId };
    } catch (error) { throw new Error('ordinary launch: ' + (error?.message ?? JSON.stringify(error))); }
  })()`) as { ordinaryChangedBlocked: boolean; nonRepositoryStarted: boolean; startedSessionId: string }

  const details = await window.webContents.executeJavaScript(`(async () => {
    try {
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
      return await wait(() => document.querySelector('.session-inspector .repository-identity')?.textContent.includes('Repository root')
        ? document.querySelector('.session-inspector .repository-identity').textContent : null, 'repository root');
    };
    const outer = await details(${JSON.stringify(params.existingSessionId)});
    const nested = await details(${JSON.stringify(ordinary.startedSessionId)});
    return { detailRoots: [outer, nested] };
    } catch (error) { throw new Error('repository details: ' + (error?.message ?? JSON.stringify(error))); }
  })()`) as { detailRoots: string[] }

  return {
    gitVersion,
    previewBranch: preview.previewBranch,
    preparationPreservedTerminals: preview.preparationPreservedTerminals,
    ordinaryChangedBlocked: ordinary.ordinaryChangedBlocked,
    nonRepositoryStarted: ordinary.nonRepositoryStarted,
    detailRoots: details.detailRoots
  }
}
