# MODULE: qa-checklist.md - BMN regression flows for a scoped manual QA pass
# BMN regression checklist

Derived from Epic 98's 39-scenario inventory across 13 feature areas. These are checks to select in a QA brief, not past results or permission to act. Run only on the named build, disposable state and authorized accounts. Use the real UI for interactions; never edit code, fixtures or databases. A missing fixture, native picker, phone, audio or agent route is BLOCKED or NOT RUN, with its reason, never a pass inferred from source or unit tests.

The lead verifies machine-only boundaries such as process cleanup, backup contents and lifetime isolation with their acceptance gates. A manual QA reports the part it actually observed and keeps the remaining gap explicit. Existing screenshots, old claims and this checklist do not prove the candidate.

| ID | Feature area | Flow | Expected result |
| --- | --- | --- | --- |
| S01.1 | First run | Open Setup from palette | Setup remains reachable; no sign-in/installer runs |
| S01.2 | First run | Skip setup and reopen it | ordinary terminal stays usable; skip is durable |
| S01.3 | First run | Inspect missing agent readiness | honest not-installed/sign-in-unknown state; bash still works |
| S02.1 | Workspaces and sessions | Create and rename a workspace | sidebar shows the saved name |
| S02.2 | Workspaces and sessions | Create/edit a bash session | exact command and cwd shown; no agent inherited |
| S02.3 | Workspaces and sessions | Stop/archive/undo/restore a session | running archive refused; stopped item can restore without starting |
| S03.1 | Terminal and panes | Type into bash and find printed text | input targets selected terminal and find does not resize it |
| S03.2 | Terminal and panes | Split and switch panes | selected sessions remain correctly labelled and keyboard focus follows |
| S03.3 | Terminal and panes | Toggle focus mode and terminal font | layout returns; terminal remains usable |
| S04.1 | Process lifecycle and resume | Stop a running bash | exit confirmed; controls match stopped state |
| S04.2 | Process lifecycle and resume | Start a stopped session again | fresh incarnation starts exactly once |
| S04.3 | Process lifecycle and resume | Inspect resume and close choices | bash does not falsely offer agent resume; close choices are explicit |
| S05.1 | Agent attention, progress and handoffs | Open Needs you and progress views | empty or synthetic records labelled truthfully |
| S05.2 | Agent attention, progress and handoffs | Open handoff/draft destination picker | destination is explicit; cancel types nothing |
| S05.3 | Agent attention, progress and handoffs | Exercise a synthetic agent question and its answer; require an authorized agent fixture | the exact synthetic question is answered once; missing real-agent coverage stays explicit |
| S06.1 | Team and rules | Open Team and roles | unapproved synthetic profile grants nothing |
| S06.2 | Team and rules | Open Rules and inspect missing master | missing/unapproved state is honest; no real file touched |
| S06.3 | Team and rules | Save rules against a prepared conflict and verify the changed target is preserved | atomic guarded writes preserve changed targets |
| S07.1 | Tools and skills | Open Skills and available actions | empty/error states usable and honest |
| S07.2 | Tools and skills | Open Tools | tools, states and available actions are readable; apply only in authorized disposable profiles |
| S07.3 | Tools and skills | Apply/undo tools and skills in disposable profiles; exercise prepared conflict/foreign targets | changed/foreign targets refused, only synthetic profiles |
| S08.1 | Files and references | Open synthetic README in Quick look | correct root and text displayed |
| S08.2 | Files and references | Find project file through palette | only synthetic project matches; action opens correct file |
| S08.3 | Files and references | Send a synthetic paste/save/handoff and exercise a prepared stale target | target identity checked and uncertain writes not replayed |
| S09.1 | Voice | Open Voice settings | engine/model status shown honestly |
| S09.2 | Voice | Use Speak without a model | opens actionable settings; no microphone or download |
| S09.3 | Voice | Approve vocabulary and exercise synthetic silence without pasting text | bounded vocabulary; silence pastes nothing |
| S10.1 | Telegram | Open Notifications with Telegram off | disabled status; no bot token present or requests sent |
| S10.2 | Telegram | Answer synthetic question/permission cards through the authorized phone fixture | the answer reaches only the exact current question or permission and has an honest receipt |
| S10.3 | Telegram | Inspect missing-token validation | cannot enable/send with missing credentials; no real message |
| S11.1 | Backups | Open Data backup controls | export destination remains explicit |
| S11.2 | Backups | Export a synthetic backup through the UI; lead gate verifies its contents | manifest, database and files agree; secrets and turn copies are excluded |
| S11.3 | Backups | Inspect restore availability | manual export only, no invented built-in restore |
| S12.1 | Customization | Change theme and identity | selected theme persists and controls stay readable |
| S12.2 | Customization | Open palette and navigate with keyboard | Escape restores focus; selected command targets current context |
| S12.3 | Customization | Inspect Data retention choices | the no-expiry/current value persists; no stored data is deleted |
| S13.1 | Privacy and storage | Inspect Health paths and control status | only bench roots/socket shown |
| S13.2 | Privacy and storage | Lead gate: verify private-bus and protected-path separation with lifetime checks | no owner paths or bus touched; a filesystem/network sandbox requires separate escape proof |
| S13.3 | Privacy and storage | Stop bench and verify cleanup | all recorded processes gone; disposable roots deleted; evidence retained |
