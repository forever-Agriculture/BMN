# WSL session protocol (Story 53.5, preparatory)

**Status: preparatory component, not wired to BMN.** Nothing here launches WSL, runs as root or carries credentials. It fixes the wire format, the launch schema and the two state machines before the native measurement round, so they can be tested on Linux now. `profileComplete` stays `false` (see [the parity record](epic-53-parity.md)). The design follows the consultant-agreed WSL plan (`.dev-auto` run log, 2026-10-05 14:18Z): binary length-delimited frames over the redirected stdin/stdout of `wsl.exe --distribution <selected> --user root --exec <trusted helper>`, separate channels, and a root side that accepts only provisioning and lifecycle operations.

Two implementations share one set of test vectors:
- `scripts/lib/wsl-session-protocol.mjs`: the native relay's side (encodes launch, input, resize and stop; decodes the guest's frames; tracks one session).
- `scripts/lib/wsl-session-protocol.py`: the guest helper's side (decodes the native frames and validates the launch; encodes ready, output, exit and error).
- `scripts/test/fixtures/wsl-session-protocol-vectors.json`: frames, malformed streams, launch messages and both sessions' expected events. `scripts/tests/wsl-session-protocol.test.mjs` runs every vector through both implementations, whole, byte by byte and in uneven pieces.

## Frames

Every frame is an 8-byte header and a payload:

| Bytes | Field | Rule |
| --- | --- | --- |
| 0 | version | `1` |
| 1 | channel | `0` control, `1` terminal, `2` resize; `3` (bridge) and `4` (file transfer) are reserved and refused until they are designed and reviewed |
| 2–3 | reserved | `0` |
| 4–7 | payload length | unsigned, big-endian; control and terminal at most 65,536 bytes; resize exactly 4 |

A decoder checks the header before it buffers any payload, so it never holds more than one header and one largest payload (65,544 bytes). An unknown version, channel, reserved bit or length fails at once with `PROTOCOL`. End of input inside a frame is `PROTOCOL` (truncated). Larger terminal output is split into several frames.

Terminal bytes are only ever payload. A terminal payload that happens to contain a valid control frame is delivered as terminal bytes and changes nothing; control never travels as escape sequences.

Control payloads are UTF-8 JSON objects with exactly the keys listed below. Resize payloads are two big-endian 16-bit numbers, columns then rows (columns 2–1000, rows 1–1000, the session manager's own limits).

## Launch (native to guest, first frame only)

```json
{ "type": "launch", "protocol": 1, "profileVersion": "restricted-1",
  "sessionNonce": "<32 lowercase hex>",
  "distribution": { "id": "{<registration GUID, lowercase>}", "name": "<1–64 of A–Z a–z 0–9 . _ ->" },
  "project": { "id": "<1–64 of A–Z a–z 0–9 _ ->" },
  "shell": { "argv": ["/bin/bash", "-l"] },
  "cwd": "/home/project",
  "environment": { "TERM": "xterm-sixel-256color", "LANG": "C.UTF-8" },
  "size": { "cols": 80, "rows": 24 } }
```

- The registration identity is the distribution's registry GUID, separate from its display name, so a renamed or replaced registration is detected rather than silently selected.
- `shell.argv` is the literal argument vector: 1–64 strings, each without NUL and at most 4,096 UTF-8 bytes, the first an absolute normalized path. It is never a command string.
- `cwd` and `argv[0]` are absolute normalized Linux paths: no NUL, no empty, `.` or `..` segment, at most 4,096 bytes.
- `environment` admits only `TERM`, `COLORTERM`, `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `LC_COLLATE`, `LC_NUMERIC`, `LC_TIME`, `TZ`, `NO_COLOR`, `FORCE_COLOR` and `CLICOLOR`, each value without NUL and at most 4,096 bytes. No credential travels here; a session's scoped credential will have its own channel once the bridge is designed and reviewed.
- Any other key, type or value fails with `PROTOCOL` and names the field.

## The guest's session

| State | Accepts | Then |
| --- | --- | --- |
| awaiting launch | a valid `launch` | running |
| running | terminal input, resize, `{"type":"stop"}` | stop: stopping |
| stopping | terminal input and resize are dropped | |

Anything else fails the session with `PROTOCOL`. End of input before a launch aborts with nothing to undo; end of input while running or stopping tears the session down, exactly as Stop does.

## The native side's session

| State | Accepts | Then |
| --- | --- | --- |
| awaiting ready | `ready` carrying this session's nonce; `error` | running; failed |
| running | terminal output, `exit` carrying the nonce, `error` | exited; failed |

```json
{ "type": "ready", "sessionNonce": "…", "profileVersion": "restricted-1", "leasedUid": 1000001 }
{ "type": "exit", "sessionNonce": "…", "payload": { "code": 0, "signal": null }, "cleanupConfirmed": true }
{ "type": "error", "sessionNonce": "…", "code": "LEASE_UNAVAILABLE", "detail": "…" }
```

Output before `ready` is `PROTOCOL`; a nonce that is not this session's is `AUTH`. End of input before `ready` is `EXEC_FAILED`; end of input while running, without an `exit`, is `CLEANUP_UNCONFIRMED`.

A session's receipt is complete only with a matching `ready`, a matching `exit` whose `cleanupConfirmed` is `true`, and no failure. Every other receipt is incomplete, and no incomplete receipt can count toward `profileComplete`.

## Failures and helper exit codes

`exit.payload` is the shell's own result; the helper's failures are separate. Codes the guest can report, with the helper's process exit code for each: `UNSUPPORTED_PROFILE` 69, `INTERNAL` 70 (the prototype's existing internal-failure code), `EXEC_FAILED` 71, `STORAGE_RECOVERY` 74, `LEASE_UNAVAILABLE` 75, `PROTOCOL` 76, `AUTH` 77, `ROOT_DENIED` 78, `CLEANUP_UNCONFIRMED` 79. `WSL_MISSING` and `DISTRO_CHANGED` are found on the Windows side and never come from the guest. Any other helper exit code reads as `INTERNAL`.

## Discovery and distribution-qualified paths

`scripts/lib/wsl-discovery.mjs` holds the native side's pure decisions for AC1 and AC3, tested in `scripts/tests/wsl-discovery.test.mjs`:
- **Registrations.** A fixed, read-only Windows PowerShell command lists this user's registrations from the registry (`HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss`) as JSON: identity (the key's GUID, lowercased), name, WSL version, state, base path and the default. Entries that cannot be a usable registration are listed with the reason, never dropped silently. Names that differ only in letter case are marked ambiguous, because WSL compares names without case. `wsl.exe --version` is parsed for its versions; a label it cannot find (another display language) is null, not a failure.
- **Start and resume** use only the registration the session recorded, never the default. WSL missing (`WSL_MISSING`), a removed, renamed, replaced (same name, new identity) or ambiguous registration (`DISTRO_CHANGED`), and a WSL 1 registration (`UNSUPPORTED_PROFILE`) each fail with a message that says what to do and that Windows sessions are not affected.
- **Paths** are qualified by registration identity, so the same Linux path in two distributions never collides. A path is confined to an authorized root lexically: another distribution, a sibling with the root's name as a prefix, and any `.` or `..` segment are refused. `\\wsl$\<name>\…` and `\\wsl.localhost\<name>\…` map to exactly one registration; an unknown or ambiguous name fails instead of guessing, and device forms are refused. Links and reparse points are resolved at open time under held handles in a later slice; this lexical step does not replace that.

## Network destinations (profile gate P6)

`scripts/lib/wsl-egress-policy.mjs` is the session's network mediator's destination policy, tested in `scripts/tests/wsl-egress-policy.test.mjs`. The mediator resolves names itself and asks about every address it would use; it then connects only to the addresses an allowed decision lists, and a redirect or a new resolution is a new decision.
- Only TCP to ports 1–65535 is offered. UDP, LAN and VPN destinations stay closed until the owner decides them.
- Every answer for a hop must be a public address that is not this computer; one forbidden answer refuses the whole hop, so a rebinding answer cannot ride along with a public one.
- Addresses are literal only, in one canonical form: shorthand, octal, hexadecimal and integer IPv4 forms, names, brackets and zone indexes are refused rather than reinterpreted. IANA special-purpose ranges are never public (a few globally reachable assignments inside them are refused too). IPv4-mapped, NAT64 and 6to4 addresses are judged by the IPv4 address they carry, and IPv6 outside `2000::/3` is reserved.
- This computer's own addresses, public and hairpin ones included, are refused in every form that carries them.

## Not covered yet

The bridge and file-transfer channels, credentials, durable storage, egress, terminfo and the Windows relay are later slices of the plan; each needs its own measurement, and the bridge its own review. Nothing here is native evidence: WSL, ConPTY and two-registration behaviour remain **UNVERIFIED**.
