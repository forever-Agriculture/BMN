<!-- MODULE: report.md - Epic 100.2: the brief/report contract and its checker -->
# QA brief and report

Use version 1 of [schema.json](schema.json): `$defs.brief` for the input and `$defs.report` for
the output. Unknown fields at any level are errors. Text must be trimmed nonempty; this check
does not determine whether a statement is true or meaningful. Empty collections are allowed
where there is nothing to record. Both documents are validated before their bindings are checked.

The brief's `revision`, `target` and `mode` must match the report exactly. `revision` is the
candidate's immutable commit/build identity; `target` identifies the running instance. `scope`
has `included` and `excluded` lists. `accounts` contains aliases and `test-full` or `look-only`
permissions, never sign-in material. `prior_findings`, when present, contains each full `finding`
and its repair `disposition`; the report retains every prior finding with its current status.
Keep the earlier category, severity, prerequisites, reproduction steps/counts, expectation, actual
observation and impact intact. Record current observations in `retest`; a changed defect gets a new ID.
Only IDs supplied in `prior_findings` may be resolved or carry `retest`; newly observed defects
stay open on this frozen candidate, including intermittent failures.
Keep excluded inputs out of the brief as the skill's input contract says.

The report contains:

| Field | Content |
| --- | --- |
| `account_context` | `signed_out`, overall `observed_restrictions`, and `used_accounts` with each alias, matching brief permission and observed restrictions; quick modes are signed out |
| `goal_check` | `status` (achieved/partly/not achieved/uncertain), `execution` (started/not started), `steps`, `observations`; uncertain also needs `question` |
| `criteria` | One entry per brief ID: `status`, `steps`, `observations`, `evidence`, `finding_ids`; PASS/FAIL require steps, every FAIL links an open finding |
| `findings` | ID, category, severity, prerequisites, steps, expected, actual, impact, reproduction `{attempts, observed}`, evidence names and open/resolved status |
| `findings[].retest` | Required for resolved findings: current steps, observations and `regression_gaps` |
| `debrief` | Confidence high/medium/low, summary and notes (charters, questions, out-of-scope observations) |
| `untested_areas` | Material gaps, including each BLOCKED/NOT RUN criterion as `ID: reason` |
| `audit_summary` | Required if an account was used in session mode: `complete`, `observed_traffic`, `gaps`; an incomplete audit needs a gap explanation |
| `verdict` | NO-GO for non-achieved/uncertain goal, mandatory non-PASS or open blocker/major; otherwise GO WITH ISSUES for open minor, otherwise GO |

Goal steps may be empty only for `execution: "not started"`, which requires uncertain and an
explanation. Reproduction counts are integers with `1 ≤ observed ≤ attempts`. Evidence names
are relative paths inside the local run: no absolute paths, URL, backslash or `.`/`..` segment.
An empty evidence list is allowed for a nonvisual observation; it does not establish visual proof.

Optional BLOCKED/NOT RUN can coexist with GO if disclosed. Optional FAIL needs an open finding;
its actual severity controls the verdict. Repair claims cannot resolve a current FAIL.

Check locally:

```sh
bmn qa report check REPORT --brief BRIEF
# Same validator, from this installed skill directory:
node check.mjs REPORT --brief BRIEF
```

Exit 0 means structurally consistent, including a valid NO-GO report; exit 1 names invalid fields
or contradictions; exit 2 is usage. This command reads files only and needs no BMN socket. It does
not prove the build was tested, enforce account permissions, waive acceptance or publish evidence.
