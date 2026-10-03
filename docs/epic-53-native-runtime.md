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

These mechanisms are implemented, with native compilation and runtime acceptance
pending. `scripts/test/windows-pty-ownership.mjs` checks root/child/grandchild
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
