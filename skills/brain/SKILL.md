---
name: brain
description: Read or capture lasting cross-project memory through bmn brain when the owner asks to note, remember or recall something, or a recorded personal decision is needed. Project facts stay in their project records.
---
# Brain

Use `bmn brain` only. The old `~/brain` vault is a read-only archive after the owner's switch;
`~/brain/files/` remains the attachment folder. Before the switch, BMN refuses brain writes.
Only the owner's own “Switch to the BMN brain…” palette action and confirmation may start cutover. No agent, CLI, script, reboot or update may start or authorize it. Keep the real master, skill and timers unchanged until then.

Search only when the task needs a past decision or durable cross-project fact. Do not search
on every message, duplicate project context or inject memory into sessions. No brain questions
for the owner: decide within the existing authority and record uncertainty.

- `bmn brain search "words"`: at most 10 titles, one-line summaries and scores; archives need `--archived`.
- `bmn brain read "title or id"`: whole note with revision, origin, date and scope.
  Add `--section "heading"` for one part or `--links` for links/backlinks.
- Save lasting personal preferences, his words, people, machine rules, cross-project lessons,
  or ideas/research without a project home. Preserve his wording and cite the source/date.
- Before creating, search for its existing home. At most 3 new notes per live BMN session; prefer edits.
- Create: `bmn brain write "title" --revision 0 --text-file FILE --kind decision --scope all`.
- Edit: read first, then `bmn brain edit ID --revision N --text-file FILE`.
  A stale revision means read again and reconcile; never overwrite a newer decision blindly.
- `bmn brain withdraw ID --revision N` keeps history; `restore` appends a restoration.
  No routine delete; Epic 128 reserves named hard deletion to the owner.

Never store secrets, project facts, duplicated repository content, handoffs, transcripts,
run state, progress or daily logs. Projects keep their own plan, docs and rules; the Project map
links to those homes. Scope is `all` or `group:one,two` for a real cross-project group.
Reads work with BMN closed; writes need a live BMN session and the completed owner-held switch.
Save, search, import, export and backup call no model. Backup/export failures appear in Health.
