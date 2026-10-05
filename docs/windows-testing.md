# Testing BMN on Windows

This is for a person checking a Windows build by hand. It needs no developer tools.
Windows support is new: anything not listed as checked in the
[parity checklist](epic-53-parity.md) is unverified, and your results are what
verify it.

## Get the build

1. Open the repository's **Actions** tab, choose the latest **Linux and Windows build**
   run for the commit you were asked to test, and download the artifact
   `bmn-windows-x64-<commit>` (you must be signed in to GitHub). It is kept 14 days.
2. Unzip it. It holds `BMN-<commit>-setup.exe` and a `win-unpacked` folder.
3. Use a **standard** (not administrator) Windows 11 account, ideally one with no
   personal data you care about. WSL is not needed and not yet supported.

The installer and program are unsigned. Windows may show "Windows protected your PC":
choose **More info → Run anyway** only for a file you downloaded from this repository's
run. Do not turn off Defender or SmartScreen.

Install with `BMN-<commit>-setup.exe` (per user, into `%LOCALAPPDATA%\Programs\BMN`, with
a Start menu shortcut), or run `win-unpacked\BMN.exe` directly without installing.

## What to try

Note what you expected, what happened, and a screenshot when something looks wrong.

1. **Start and quit.** BMN opens; a second launch focuses the open window; quitting
   and reopening keeps your sessions and settings.
2. **Terminal sessions.** Open PowerShell and Command Prompt sessions. Type, paste,
   resize the window, split panes, press Ctrl+C on a running command, scroll back.
   Run something with a lot of output in a narrow pane, for example
   `1..200 | % { "line $_" }`, and check the prompt comes back by itself.
3. **Agents.** If you use Claude Code, Codex, Cursor CLI or OpenCode, start one inside a
   BMN session. Check its hooks under Preferences → Local agent control → Harness hooks,
   and install missing ones with `bmn hooks install <agent>` in a session (it shows the
   change and asks first). Then confirm that an agent waiting for you shows up in BMN,
   and that resuming a conversation works.
4. **The `bmn` command.** Inside a session, `bmn --help` works. Preferences → Local agent
   control shows *Listening: Yes* and an *Endpoint file*.
5. **Files.** Click file paths printed in the terminal (with spaces, accents, other drive
   letters, network shares). Use Open, Show in Folder and Save As on shared files. Save
   over a file another program has open (for example an open Excel workbook): BMN should
   say the file is in use rather than fail silently.
6. **Notifications.** BMN's desktop notifications appear. Turn notifications off for BMN in
   Settings › System › Notifications, trigger one, and check Preferences says it did not appear.
7. **Voice.** Dictate into a session. Unplug or disable the microphone while recording:
   BMN should stop and say so.
8. **Backup.** Preferences → export a backup and verify it.
9. **Uninstall** (installed build only). Settings › Apps › BMN › Uninstall, keeping data;
   then reinstall and check your sessions are still there.

## What to report

For each problem: the artifact name (it contains the commit), `winver` output, the steps,
what you expected and what happened, and screenshots. BMN keeps its data in
`%LOCALAPPDATA%\BMN` (`config`, `data`, `state`); do not send those folders without
checking them first, since they can hold your own terminal output.
