# Dev Auto handoff

- Project / selected epics: `/home/oleksandr/code/BMN`; Epic 8 (stories 8.1, 8.2).
- Original request and intended outcomes: `/dev-auto 8` (2026-09-19, Claude Code); open local file references from the command palette (8.1) and by Ctrl+click on terminal output (8.2) in a read-only snapshot overlay, per `_bmad-output/planning-artifacts/epics.md` Epic 8 and `reference-context-8-12.md` "File references".
- Mode: build
- Stopping condition: selected scope accepted; no automatic time limit
- Explicit user stop (if any; only a later user instruction clears it): none
- Restrictions and authorization boundaries: local implementation, proportionate checks, isolated synthetic Electron runs, independent review dispatches under the owner's dev-auto policy (`~/.claude/CLAUDE.md` Authority), sprint/handoff updates and ready checked local commits. Push to `main` and `pnpm run update:desktop` (AGENTS.md) need separate owner authorization. No install, deploy, destructive cleanup, or private-content screenshots.
- Authorized provider routes: native Claude Code helpers; Codex CLI, Claude CLI and configured GLM profile per `~/.claude/skills/dev-auto/references/models.md`; minimum task-relevant payload only.
- Lead host / requested model / observed model: Claude Code; no model requested; lead runs as `claude-opus-5[1m]` (session system prompt).
- Prior run: Epics 6–7 handoff (COMPLETE) is in git history at `93a6fe3`.

## Progress

- Sprint board and reconciled state: board (`_bmad-output/implementation-artifacts/sprint-status.yaml`, ignored) shows epics 5–7 done; epic-8 `in-progress`, 8-1 and 8-2 `review` (implemented and checked, awaiting independent review). Base `8b5a2db` was clean.
- Implemented: shared grammar `shared/protocol/src/file-reference.ts` (typed/terminal parse, token scan, quoting, `file.reference.read` method); utility reader `apps/desktop/src/utility/file-reference-reader.ts` (realpath + O_NOFOLLOW|O_NONBLOCK open, fstat regular-file check, 1 MiB bound incl. growth, NUL/strict UTF-8) routed in `pty-host.ts` with the live launch directory (`SessionManager.liveLaunchDirectory`) or stored cwd; main IPC `file-reference-ipc.ts` (sender check, bounded fields, folder picker, Show in folder); preload bridge; renderer dialog/presentation, palette entry, selection prefill; xterm link provider `file-reference-links.ts` (requested-row only, wrapped-row join ≤16, Ctrl-only underline/activation, off in mouse-tracking mode, activation re-validates the printed cells); macOS Ctrl+click context menu suppressed; README and architecture notes.
- Associated loop (optional; host and native loop/task ID): none
- Active native helpers (ID, route, scope, ownership, state): none
- Collected terminal helper results: none

## Decisions and findings

- Original or approved intent changes: none.
- Material pending findings: none.
- Cross-epic obligations: preserve Epic 5 gold/white/orange semantics and geometry; Epic 6 attention resolution (opening a file never resolves attention); Epic 7 handoff paste/receipt behaviour; one live xterm per session; no PTY writes from file preview.

## Evidence

- Checks run and observed results (2026-09-19, working tree before the first Epic 8 commit): `pnpm run test:unit` 884 passed / 1 skipped (`.dev-auto/evidence/unit-7.log`, sha256 `d0ee1d18…`); `pnpm run lint` EXIT 0 (`lint-4.log`); `pnpm run typecheck` EXIT 0 (`typecheck-4.log`); `git diff --check` clean; `pnpm run test:electron` EXIT 0 (`electron-12.log`, sha256 `5fe0ab22…`) exercising palette by keyboard → preview line 42 → copy → Show (stubbed, path recorded) → Escape focus return; launch directory used after shell `cd`; chosen-folder read; `$HOME` rejection keeping input; Ctrl+click from the unselected pane; plain click, Ctrl+drag copy, SGR mouse-mode fixture; redraw of a hovered link (stale click shut, new reference opens as itself); palette opening from a cross-workspace split pane names `Archived running chat · Self-test archived workspace` and main's read log addresses that session; exact read log = 8 explicit opens (no hover/output reads); PTY input 0; geometry 43x30 / refits unchanged / same element; attention unchanged; missing session NOT_FOUND.
- Regression proof: stale-link activation test fails without the cell re-check (unit) and Electron fails with `staleOpened:true` (`electron-11-nofix.log`, sha256 `c2460c7e…`); both pass with it.
- Failed attempts kept for context: electron-1 (default mouse encoding goes via xterm `onBinary`, switched fixture to SGR), electron-3 (synthetic mousedown `detail` 0 skipped selection), electron-3/4 `terminalUnchanged:false` INCONCLUSIVE — most likely the files-panel close refit racing the baseline; baseline now waits for refits to settle, 7 consecutive passes (6–10, 12; 11 was the deliberate no-fix run). Unit timeouts in `saved-output-store.test.ts` (unit-2..4) occurred only while an unrelated 8-worker pytest ran; the file passes alone and the suite passes after (unit-5, unit-6).
- Reviewed scope and route: none yet.
- Reviewed revision / material finding closures / recheck or delta evidence: none yet.
- Unreviewed or unverified areas: independent review pending. UNVERIFIED: macOS (Ctrl+click vs context menu, Show in folder), the real Linux file manager (self-test stubs `shell.showItemInFolder`), the native folder picker (dialogs disabled in self-test; chosen base exercised through the bridge). Both self-test sessions share one launch directory, so per-session base selection is shown by the addressed session ID, not by distinct paths.
- Unrelated pre-existing gap (mention once): xterm default-encoding mouse reports arrive via `onBinary`, which BMN does not forward; SGR (1006) reports work.

## Measurement

- Timing: started 2026-09-19T14:04+03:00 / accepted — / elapsed —
- Dispatches: none yet.
- Owner interventions: 0.
- Observed usage: —

## Resume

- Next safe action: commit Epic 8 locally, then dispatch the independent Fable review of that commit.
- Status: ACTIVE
