# Telegram and agent integration: investigation notes

Recorded 2026-10-02 after the Epics 50–52 work. These notes preserve open questions
and regression checks; they do not establish that every item is a BMN defect.
The behavioral candidate is `a990552`, following `1aa6728`.

## Possible product issues and remaining verification

| Item | What is established | What would settle it |
| --- | --- | --- |
| A phone selection says “Nothing sent” after a Codex async question | An actual phone selection failed and the owner answered on the laptop. Producer attribution was populated. Later tool completions fit a reproduced callback-epoch defect, but the exact production refusal reason was not retained. `a990552` repairs other-request hook invalidation for the Codex ordinary-message route; baseline regression tests failed before the repair and passed afterward. | On the installed repair, open a synthetic native async question, allow another tool to complete and the turn to Stop, then tap its option. Observe the addressed native continuation once. Capture the exact refusal category if it fails; do not assume every refusal has this cause. |
| A native question disappears after SessionEnd | The original withdrawal incident's cause remains **UNCONFIRMED**. Actual isolated Claude evidence shows that a delayed, validated A SessionEnd preserves B's native question in the same incarnation. That does not certify the entire Codex lifecycle matrix. | Capture bounded event timestamps, incarnation, native tool reference and producer generation for question opening, start/resume/switch, compaction and shutdown. Distinguish legitimate current shutdown from an old conversation's event. |
| Manual Other does not continue the intended agent on the phone | Isolated Claude shell tests proved manual option and Other continuations, permission replies off/on, and duplicate refusal. The installed owner-phone manual Other path remains **UNVERIFIED**: earlier “Continue test” taps were options, and a plain follow-up to a completed native card was an ordinary reply. | Tap **Other…**, then reply `hello` to that same manual card. Check its correlated submission and actual native continuation. An option tap or ordinary text reply cannot substitute for this check. |
| A resumed Codex conversation lacks a current producer | Fresh direct and shell Codex starts produced genuine identities and manual records. One isolated resume attempt reached its 90-second startup boundary without a producer; no new decisions were created. This establishes a test boundary, not a production resume defect. | Inspect the actual resume UI and supported invocation before further trials. Require a genuine current-incarnation SessionStart/producer; historical resume metadata alone cannot authorize manual input. |

If a phone refusal recurs, record the installed commit and exact phone feedback,
then correlate request revision, card message, incarnation and producer before
investigating the write boundary. Use synthetic questions for reproduction. Keep
diagnostics to bounded identity/category metadata; exclude tokens, environment
dumps and private question or transcript contents.

## Regressions to preserve

- Other-key hook events must not invalidate a queued Codex async ordinary-message
  answer. Same-key, unscoped and native screen-dialog invalidation must still work.
- A native blocker or attention mutation arriving during asynchronous preparation
  must prevent the final PTY write. The repaired generation/pending guard has
  regression coverage for completed, pending and entry-time mutation cases, with
  zero refused writes and one safe retry.
- A shell-launched agent's lightweight live producer is separate from its durable
  resume binding. A refusal to relabel the shell is not proof that live attribution
  failed.
- Current-producer compaction and genuine shutdown need separate checks. Retain
  the passing Claude compaction, switch, old-card refusal and shutdown evidence;
  do not extend its verdict to unexercised Codex cases.

## Test harness pitfalls already observed

| Pitfall | How to avoid misdiagnosing it |
| --- | --- |
| Waiting for SessionStart before any first Codex prompt stalled the fixture | A positional no-tool readiness prompt successfully initialized a genuine SessionStart/producer/Stop. Inspect the current rendered viewport; a brand header or old scrollback does not prove onboarding is complete. |
| Folder trust and hook trust are separate | Trust only the displayed private test folder and the exact generated hooks. Claude screen-reader and normal UI inputs differ; an unrecognized selection marker is an inconclusive startup check. Preserve native trust and permissions. |
| Copying only the Codex executable breaks tool execution | The isolated executable also needed its adjacent `codex-code-mode-host`. The captured ENOENT was a fixture dependency failure, not a BMN caller defect. |
| Looking for `prompt.route` misses a real async question | The stored protocol uses `prompt.shape = 'async-choice'`; `answerRoute()` derives `codex-message`. |
| Matching an absent internal title prevents fake-bot callbacks | Native cards render question text, which can omit the internal title prefix. Bind the captured send, message ID and button token to the request before checking callback receipt. |
| Comparing a native button to a bare option label fails early | A native button can read `1 · Label`. Validate the documented rendered format and selected option, then prove the connector actually received the callback. |
| A model gets a toy token transformation wrong | One Codex response omitted a character when reversing the synthetic token, despite an exact correlated native user message and a new assistant response. Keep the failed transformation assertion distinct from delivery evidence. A terminal echo is never native consumption proof. |

The last native-consumer fixture did not certify callbacks or consumption: its
numbered-button assertion failed before callback verification, and normal Claude
startup did not establish a visibly selected YES. Preserve these as harness gaps,
not confirmed product failures.

## Workflow and evidence reminders

BMN and the canonical dev-auto caller share the addressed-message, ownership and
approval contracts. Full unattended reliability remains unverified. Confusing
test instructions, stale send counters and repeated fixture setup mistakes added
avoidable owner attention and time; they are distinct from product defects.

Count confirmed outbound test cards separately from local requests. Reserve
uncertain sends conservatively; a missing stored mapping cannot refund one.
At this checkpoint the original six-card allowance is exhausted, and the separate
two-card approval remains unused, conditional on the repaired desktop being
installed. These are historical run limits, not standing permission for future
tests. Ask only for a genuinely changed scope or a new test allowance.

Local detailed evidence is under `.dev-auto/evidence/epics-50-52/` and is not
committed. Start with `finish/acceptance-matrix.json`, the `native-*` receipts,
`finish/b2buster-phone-incident.json`, and `resume-installed/phone-budget.json`.
Temporary provider profiles and credential copies were removed after the tests.
Passing checks cover 775 affected tests plus typecheck, lint and build; source,
isolated connector/PTY, native consumer, installed build and owner-phone evidence
remain separate gates.

Use `pnpm run update:desktop` after the pushed change. It builds the latest clean
`origin/main` after packaged BMN exits; a queued update is not an installed update.
Do not package over an open BMN or force-close unrelated sessions for a test.
