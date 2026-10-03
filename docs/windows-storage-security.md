# Windows storage security

BMN creates protected current-user-only application roots. Existing roots and every
ancestor/descendant are verified without rewriting ACLs. Unknown owners, identities,
links or permissions fail startup. The selected root itself remains strictly private.

Electron 44.3.0 uses Chromium 152.0.7977.78, whose network sandbox grants its
`lpacContentNetworkService` capability access to `Cache`, `Network` and
`Shared Dictionary`. BMN recognizes that capability only inside those exact
subtrees of the resolved data root. Config, state, runtime, database and other
application files retain the strict policy. Windows roots that alias or overlap
the data root are refused to prevent ambiguous policy selection. All requested
paths are compared using the same Windows .NET full-path normalization, including
8.3 aliases and trailing separators, before any root is created. Missing paths are
resolved from the nearest existing ancestor plus their missing components, so .NET
Framework cannot retain an unexpanded parent alias. Creation uses those same keys. Duplicate
requested roots remain visible to that preflight.

The capability SID is
`S-1-15-3-1024-395641907-2340533657-1796656376-1949871151-3167452726-3934347287-2361051074-3061173417`.
It is not a trusted owner or an ordinary user. Windows evaluates AppContainer
capability access in addition to traditional user/group access, requiring both.
See [Microsoft's AppContainer access model](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer).

The recognized additional Allow ACEs are precisely the observed Chromium forms:

| Applies to | Rights mask | Inheritance | Propagation |
| --- | --- | --- | --- |
| File or directory itself | `0x001301bf` (Modify, Synchronize) | None | None |
| Directory descendants template | `0xe0010000` (generic read/write/execute, delete) | ContainerInherit, ObjectInherit | InheritOnly |

Each item requires effective current-user FullControl. Duplicate or supplemental
owner Allow entries are accepted; owner Deny entries are refused. Directories
also require an owner FullControl entry inherited by files and directories without
NoPropagateInherit; direct and inherited access may be separate entries. Every other identity/mask/flag combination
is refused. Enumeration remains bounded to 10,000 items and 15 seconds.

Sources: Electron's [pinned dependencies](https://github.com/electron/electron/blob/v44.3.0/DEPS),
Chromium's [capability definition](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.78/content/public/browser/content_browser_client.cc)
and [network sandbox grants](https://chromium.googlesource.com/chromium/src/+/refs/tags/152.0.7977.78/content/browser/network_sandbox.cc).
The exact recursive masks were recorded by the synthetic
[native probe](https://github.com/forever-Agriculture/BMN/actions/runs/37067582915).

Implementation is not acceptance. The native regression exercises real sandboxed
Electron followed by strict and Chromium-aware verification and restart. Separate
negative fixtures must reject broadened permissions and misplaced capabilities
without mutation. Native second-account denial passed for ordinary tokens and
for actual capability-bearing AppContainers in
[run 37118862309](https://github.com/forever-Agriculture/BMN/actions/runs/37118862309)
on candidate `7fd12e8`, Windows Server 2025. The fixture verified the guest user,
AppContainer/package identity, capability and low integrity level inside each
receiver. Its capability-bearing positive control allowed read/write; a receiver
without the capability was denied that control. Both receivers received
`ERROR_ACCESS_DENIED` for strict storage, the accepted Chromium Cache fixture and
a low-integrity diagnostic copy with the same leaf ACL. Private content hashes
remained unchanged; generated account, user profile and AppContainer profile were
removed. The ordinary broker ran at medium integrity without elevation.

These are native Server 2025 results. Windows 11 laptop validation remains
**UNVERIFIED**, explicitly deferred by the owner to the release collaborator.
