// MODULE: shell-menus.ts - the workspace, session and pane menus and the palette's read-only views (Story 75.10): a menu holds what the owner does by hand; what he only reads opens from the palette
import type { PaletteCommand } from './command-palette'
import type { MenuEntry } from './popup-menu'

/** A session's or workspace's place in its list, for Move up and Move down. */
interface ListPlace { first: boolean; last: boolean }

/** Workspace ⋯: Pinned files…, New session here, Rename…, Move up, Move down · the Marker · Archive or Restore. */
export function workspaceMenu(
  state: ListPlace & { archived: boolean; running: boolean },
  marker: Extract<MenuEntry, { group: string }>,
  act: { pins(): void; newSession(): void; rename(): void; move(step: -1 | 1): void; archive(): void }
): MenuEntry[] {
  const blocked = !state.archived && state.running
  return [
    { label: 'Pinned files…', disabled: state.archived, onSelect: act.pins },
    { label: 'New session here', disabled: state.archived, onSelect: act.newSession },
    { label: 'Rename…', onSelect: act.rename },
    { label: 'Move up', disabled: state.first, onSelect: () => act.move(-1) },
    { label: 'Move down', disabled: state.last, onSelect: () => act.move(1) },
    'separator',
    marker,
    'separator',
    {
      label: state.archived ? 'Restore workspace' : 'Archive workspace',
      disabled: blocked,
      title: blocked ? 'Stop this workspace’s running sessions before archiving.' : undefined,
      onSelect: act.archive
    }
  ]
}

/** Session ⋯: Split beside, Session details, quiet hours, Edit launch settings, Move up, Move down · Stop or Start again, Archive. */
export function sessionMenu(
  state: ListPlace & { archived: boolean; live: boolean; quietAllowed: boolean; quietFull: boolean; launchDisabled: string | undefined },
  act: { splitBeside(): void; details(): void; toggleQuiet(): void; editLaunch(): void; move(step: -1 | 1): void; stop(): void; startAgain(): void; archive(on: boolean): void },
  splitShortcut?: string
): MenuEntry[] {
  if (state.archived) {
    return [
      { label: 'Session details', onSelect: act.details },
      'separator',
      { label: 'Restore session', onSelect: () => act.archive(false) }
    ]
  }
  return [
    { label: 'Split beside', onSelect: act.splitBeside, shortcut: splitShortcut },
    { label: 'Session details', onSelect: act.details },
    {
      label: state.quietAllowed ? 'Stop allowing through quiet hours' : 'Allow through quiet hours',
      disabled: !state.quietAllowed && state.quietFull,
      onSelect: act.toggleQuiet
    },
    { label: 'Edit launch settings', onSelect: act.editLaunch },
    { label: 'Move up', disabled: state.first, onSelect: () => act.move(-1) },
    { label: 'Move down', disabled: state.last, onSelect: () => act.move(1) },
    'separator',
    state.live
      ? { label: 'Stop session…', danger: true, onSelect: act.stop }
      : { label: 'Start again', disabled: !!state.launchDisabled, title: state.launchDisabled, onSelect: act.startAgain },
    state.live
      ? { label: 'Archive session', disabled: true, title: 'Stop the session before archiving it', onSelect: () => undefined }
      : { label: 'Archive session', onSelect: () => act.archive(true) }
  ]
}

/** Pane More: the terminal's own commands, the layout and Stop; the read-only views are in the palette, itself a keyboard route. */
export function paneMenu(
  state: { live: boolean; panes: number; stacked: boolean; canStartHere: boolean },
  act: {
    details(): void; search(): void; copy(): void; paste(): void; selectAll(): void; sendNextKey(): void; resetModes(): void
    arrange(): void; newSession(): void; editLaunch(): void; stop(): void
  },
  shortcuts: { search?: string; copy?: string; paste?: string; selectAll?: string; sendNextKey?: string } = {}
): MenuEntry[] {
  return [
    { label: 'Session details', onSelect: act.details },
    { label: 'Search output', shortcut: shortcuts.search, onSelect: act.search },
    { label: 'Copy selection', shortcut: shortcuts.copy, onSelect: act.copy },
    { label: 'Paste', shortcut: shortcuts.paste, onSelect: act.paste },
    { label: 'Select all', shortcut: shortcuts.selectAll, onSelect: act.selectAll },
    { label: 'Send next key to terminal', shortcut: shortcuts.sendNextKey, onSelect: act.sendNextKey },
    { label: 'Reset terminal modes', disabled: !state.live, onSelect: act.resetModes },
    { label: state.stacked ? 'Arrange side by side' : 'Arrange stacked', disabled: state.panes < 2, onSelect: act.arrange },
    { label: 'New session in this workspace', disabled: !state.canStartHere, onSelect: act.newSession },
    { label: 'Edit launch settings', onSelect: act.editLaunch },
    'separator',
    { label: 'Stop session…', danger: true, onSelect: act.stop }
  ]
}

/**
 * The read-only views, together in the palette: While you were away… once a period has closed (Story 76.6), Review
 * results… and Messages… for the active workspace, Progress details, Turn changes… and Hook events… for the selected
 * session, then the dev-auto runs and plan use. Each opens what its menu entry opened before.
 */
export function readOnlyViewCommands(
  state: { workspace: string | null; session: string | null; progress: boolean; turnRecorded: boolean; awayPeriod?: string | null },
  open: { results(): void; messages(): void; progress(): void; turnChanges(): void; hookEvents(): void; devAutoRuns(): void; planUse(): void; awaySummary?(): void }
): PaletteCommand[] {
  const command = (id: string, label: string, run: () => void, extra: Partial<PaletteCommand> = {}): PaletteCommand => ({ id, group: 'Commands', label, run, ...extra })
  const workspace = state.workspace ?? undefined
  const session = state.session ?? undefined
  return [
    // Until a period has closed there is no summary, and a disabled command is left out of the palette.
    command('away-summary', 'While you were away…', () => open.awaySummary?.(), { disabled: !state.awayPeriod || !open.awaySummary, context: state.awayPeriod ?? undefined }),
    command('review-results', 'Review results…', open.results, { disabled: state.workspace === null, context: workspace }),
    command('messages', 'Messages…', open.messages, { disabled: state.workspace === null, context: workspace }),
    // The palette leaves a disabled command out, so a session with nothing reported or recorded simply has no such line.
    command('progress-details', 'Progress details', open.progress, { disabled: state.session === null || !state.progress, context: session }),
    command('turn-changes', 'Turn changes…', open.turnChanges, { disabled: state.session === null || !state.turnRecorded, context: session }),
    command('hook-events', 'Hook events…', open.hookEvents, { disabled: state.session === null, context: session }),
    command('dev-auto-runs', 'dev-auto runs…', open.devAutoRuns),
    command('plan-use', 'Plan use…', open.planUse)
  ]
}
