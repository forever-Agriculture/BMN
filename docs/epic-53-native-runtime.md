# Epic 53 native Windows runtime decisions

## ConPTY route

Use the ConPTY DLL bundled with pinned `node-pty@1.1.0`, currently
`third_party/conpty/1.23.251008001`. Do not choose the OS-bundled implementation for
BMN sessions: the measured Windows Server 2025 implementation drops Sixel output.

[Native feasibility run 37107328784](https://github.com/forever-Agriculture/BMN/actions/runs/37107328784)
on candidate `1adfc9d` exercised both routes through Electron 44.3.0's native
node-pty addon and a real interactive Node process. The bundled route passed:

- Exact Sixel and OSC 52, 9, 777 and 99 output.
- Mouse reporting and bracketed-paste mode output, with exact corresponding input bytes.
- Resize to 101×37 with a child-side size notification, repaint output, Ctrl+C
  delivery and observed exit code zero.

The OS route passed the same checks except Sixel. Captured bytes, OS/build and
runtime versions are in the CI artifact `windows-pty-feasibility`. This is a
representative byte-fidelity feasibility result, not final GUI image/scaling/IME
acceptance or native PowerShell/cmd lifecycle proof. Those checks remain in 53.2
and 53.7; unavailable real-laptop checks are recorded separately.

The bundled DLL and OpenConsole sidecar are already selected by the Windows
packaging helper. Keep their upstream license notices and pinned version. No
passthrough flag or unsupported console feature was required for the passing
route. An Electron/node-pty/ConPTY update must rerun this matrix.

## Process ownership

The maintained `patches/node-pty@1.1.0.patch` adds an unnamed, non-inheritable
Job Object with kill-on-last-handle-close and atomic `PROC_THREAD_ATTRIBUTE_JOB_LIST`
assignment at process creation. The utility owns the job; ordinary descendants
inherit it. Stop terminates that job without enumerating or reopening PIDs. A
retained shell handle supplies its creation FILETIME and actual exit code; the
waiter confirms the job has no active processes before publishing success.
Errors retain the existing interrupted/exit-unconfirmed semantics.

The Windows addon accepts only bundled ConPTY and reports a patch capability
version. Its two native pipes have protected current-user DACLs, random names,
first-instance protection and remote-client rejection. Output reaches JavaScript
through a private worker MessagePort with one outstanding 64 KiB chunk and stream
backpressure; the former third named relay pipe is removed. Console closure runs
off the JS thread while output drains. The pinned DLL exports
`ConptyClosePseudoConsole`, but not the timeout variant declared by its header;
no nonexistent API is assumed.

Native compilation and the ownership fixture passed on candidate `503ae3b` in
[run 37113018112](https://github.com/forever-Agriculture/BMN/actions/runs/37113018112).
The standard-handle repair in `33deab2` subsequently passed the entire byte
matrix and ownership fixture in [run 37113576528](https://github.com/forever-Agriculture/BMN/actions/runs/37113576528).
[Run 37114828953](https://github.com/forever-Agriculture/BMN/actions/runs/37114828953)
on `ea76f6c` also passed heavy output, paused Stop (25 ms), eight immediate-exit
races, and actual input/output pipe denial for a separate ordinary account with
owner-access positive controls.
`scripts/test/windows-pty-ownership.mjs` checks root/child/grandchild/OpenConsole
termination using retained observer handles for natural exit, Stop and host crash,
plus silent/immediate shells and an unrelated live sentinel. Further acceptance
includes cmd/PowerShell, pipe denial, creation failures, overhead and race stress.
Local manager regressions failed against the original adapter and pass with the
owned-job adapter; the affected 282-test Linux/manager suite passed.

Jobs contain ordinary descendants, not work deliberately delegated through
services, elevation brokers or scheduled tasks. No elevated helper or service is
required. Atomic assignment requires Windows 10 or newer and fails closed if an
enclosing job prevents it. See Microsoft's
[process creation attributes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)
and [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

The owner explicitly chose strict ownership of **all** launched processes after
being warned that newly launched GUI apps (including a fresh editor/browser) can
be terminated on terminal exit, with possible unsaved-work loss. Normal exit,
Stop and host crash therefore close the whole owned tree. An already-running
external application reached through its own broker remains outside that tree.

## Launch arguments and batch commands

On Windows, the Arguments field uses Windows CRT quoting: double quotes group
spaces, and backslashes stay literal except immediately before a double quote.
Native executables receive those arguments as data, including `%`, `^`, `&`,
embedded quotes and trailing backslashes. The selected session environment supplies
case-insensitive PATH/PATHEXT lookup; relative PATH entries never search BMN's cwd.

The owner approved a separate **Batch command (cmd syntax)** launch type. Its field
is explicitly command text: Command Prompt interprets variables, pipes, redirection
and batch syntax. Saved sessions and templates retain this mode through the existing
`cmd.exe /d /v:off /s /c` launch shape with one command-text argument. Arbitrary
`.cmd`/`.bat` files require this mode because their bodies can reinterpret arguments.

Unmodified Node wrappers generated by `cmd-shim@8.0.0`, without extra shebang
arguments or setup commands, use a native Node executable and the wrapper's script
entrypoint directly. Their arguments remain literal. Modified or unknown wrappers
are rejected in Program mode with an instruction to use Batch command mode.
Agent cards use fixed commands in a persistent native shell, retaining its prompt
after the agent exits. Runtime launch acceptance is in
`scripts/test/windows-launch-smoke.mjs`; implementation alone does not close it.
