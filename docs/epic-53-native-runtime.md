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

Implementation pending. The pinned addon retains the shell process handle but
has no Job Object. The Windows adapter must acquire tree ownership before the
child can run, retain creation-time identity and terminate only the owned tree.
Abrupt utility-host death must close the owning job and stop children/grandchildren.
Source review or a database interrupted label does not establish this behavior;
standard-user/native runtime checks are required.
