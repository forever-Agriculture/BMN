// MODULE: retired-references.mjs - Epic 71 (71.2 AC5), Story 80.20, Epic 123 (123.1 AC3): every place the repository still names
// the retired app, the second app retired in Epic 123 or one of three apps it no longer runs or never ran, against an allowlist per name
// Run it to list them: `node scripts/lib/retired-references.mjs`. scripts/tests/retired-references.test.mjs keeps each list
// and its allowlist the same, so a new reference fails until it is named here with its reason (and, for the further names, its class).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Built from parts, so this file names nothing it looks for.
const NAME = ['Cur', 'sor'].join('')
const ID = NAME.toLowerCase()
const PATTERNS = [
  new RegExp(`\\b${NAME}\\b`),
  new RegExp(`${ID}-agent`),
  new RegExp(`${ID}-support-final`),
  new RegExp(`~/\\.${ID}|\\.${ID}/`),
  new RegExp(`['"\`]${ID}['"\`]`),
  new RegExp(`\\b${ID.toUpperCase()}_`)
]

/** Where the retired app may still be named, and why. Every entry must still name it; a file no longer listed here must not. */
export const ALLOWED = {
  // The retirement line and the names it uses.
  'apps/desktop/bin/agents-roster.mjs': 'the retirement line, the tag and the retired program',
  'apps/desktop/bin/agents-roster.d.mts': 'the retired app type',
  'apps/desktop/bin/bmn-hook-runtime.mjs': 'bmn hook claude refuses a payload the retired app sends through Claude Code\'s hook files',
  'shared/protocol/src/agents-roster.ts': 'the retirement line on screens and the retired program',
  // Old records, read as they were saved.
  'shared/protocol/src/binding.ts': 'a binding saved before the retirement',
  'shared/protocol/src/companion.ts': 'hook rows and requests saved before the retirement',
  'apps/desktop/src/utility/conversation-binding.ts': 'a binding saved before the retirement, never resumed',
  'apps/desktop/src/utility/store-schema.ts': 'the migration that once allowed its bindings',
  'apps/desktop/src/utility/agent-history.ts': 'a history state saved before the retirement',
  'apps/desktop/src/renderer/src/session-presentation.ts': 'its name on old sessions, sets and requests',
  'apps/desktop/src/renderer/src/terminal-image-presentation.ts': 'xterm caret theme color keys in the image presentation signature',
  // This epic's docs and its before and after screens.
  'docs/agent-control.md': 'what the retirement means',
  'docs/features.md': 'the launcher note',
  'scripts/test/cursor-screens-visual.mjs': 'the screens before and after the retirement (Story 71.1, 71.3)',
  // Tests of the retirement message, the team file that still names it, and each old record.
  'apps/desktop/src/renderer/src/conversation-resume.test.ts': 'an old binding on screen',
  'apps/desktop/src/renderer/src/hook-events-dialog.test.ts': 'an old hook row',
  'apps/desktop/src/renderer/src/launch-template.test.ts': 'a form saved for it',
  'apps/desktop/src/renderer/src/roster-staging.test.ts': 'the team file proposal',
  'apps/desktop/src/renderer/src/session-presentation.test.ts': 'its name on an old session',
  'apps/desktop/src/renderer/src/team-rules-preferences.test.ts': 'the Team note and the agent page',
  'apps/desktop/src/renderer/src/tools-view.test.ts': 'a tool saved for it',
  'apps/desktop/src/utility/agent-history.test.ts': 'an old history state',
  'apps/desktop/src/utility/agents-check.test.ts': 'the check refusing it',
  'apps/desktop/src/utility/agents-guard.test.ts': 'the guard line',
  'apps/desktop/src/utility/agents-roster.test.ts': 'the team file warnings',
  'apps/desktop/src/utility/agents-rules.test.ts': 'the rules commands refusing it',
  'apps/desktop/src/utility/agents-skills.test.ts': 'the skills commands refusing it',
  'apps/desktop/src/utility/agents-tools.test.ts': 'the tools commands refusing it',
  'apps/desktop/src/utility/control-cli.test.ts': 'the hook commands refusing it',
  'apps/desktop/src/utility/control-server.test.ts': 'the guard report refusing it',
  'apps/desktop/src/utility/conversation-binding.test.ts': 'an old binding',
  'apps/desktop/src/utility/hook-event-history.test.ts': 'an old hook row in the saved log',
  'apps/desktop/src/utility/session-manager.test.ts': 'an old binding, never resumed',
  'apps/desktop/src/utility/store-schema.test.ts': 'the migration that once allowed its bindings',
  'apps/desktop/src/utility/telegram-cards.test.ts': 'an old request on its Telegram card',
  'shared/protocol/src/attention-prompt.test.ts': 'an old question card'
}

// Story 80.20: three more names, each with Story 80.1's pattern (plan/references/reference-80-slop-cleanup/retired-names.mjs) and
// the class 80.1 gave each line after reading it. An obsolete line is removed, never listed. Built from parts, like the name above.
const Z = ['G', 'LM'].join('')
const GEM = ['Gem', 'ini'].join('')
const AID = ['Ai', 'der'].join('')
const z = Z.toLowerCase()
const gem = GEM.toLowerCase()
const aid = AID.toLowerCase()
/** A name not preceded by a letter or digit, in any case: `.claude-x`, `x-5.3` and `X_ANSWER` count, `prefixx` does not. */
const standalone = (name, prefix = '') => new RegExp(`(?<![A-Za-z0-9])${prefix}${name}`, 'i')

const CURRENT = 'current behaviour'
const COMPATIBILITY = 'compatibility'
const EVIDENCE = 'evidence'
/** What a listed line may be: what BMN does today, an old record read as saved, or a record of a past measurement. */
export const CLASSES = Object.freeze([CURRENT, COMPATIBILITY, EVIDENCE])

const unknownApp = { class: CURRENT, reason: 'a test: an app or agent BMN does not know is refused' }
const rosterFixture = { class: CURRENT, reason: `a test fixture: ${Z} as the team's switched-off, public-only Z.ai agent (roster-example.md)` }
const hookTest = { class: CURRENT, reason: `a test of a hook from \`claude ${z}\`: its config folder, its model or its origin through api.z.ai` }
const folderTest = { class: CURRENT, reason: `a test of the \`.claude-${z}\` folder BMN learns and writes` }
const configFolder = { class: CURRENT, reason: `\`claude ${z}\`: a Claude Code config folder of its own (history label "${Z}"; context use only, no plan windows)` }
const secretFile = { class: CURRENT, reason: `the secret list: \`.claude-${z}/secret.env\` keeps that app's key while it is off (Epic 102 D4)` }
const originTable = (flag) => ({ class: CURRENT, reason: `the model origin table: such a model reads ${flag}` })

// Epic 123: the second retired app. Its own pattern, since its name is also a program the owner keeps and the judge's gateway.
const OC = ['Open', 'Code'].join('')
const oc = OC.toLowerCase()
const TAG = `${oc}-support-final`
const retirement = { class: CURRENT, reason: `the retirement: its line with the date and the tag ${TAG}, the retired app type and its program` }
const retiredAnswer = { class: CURRENT, reason: 'a command, hook or file of the retired app answers that it was retired, with the date and the tag, and changes nothing' }
const retiredTest = { class: CURRENT, reason: 'a test: a command, hook, team file or setup Undo of the retired app answers "retired" and changes nothing' }
const notOffered = { class: CURRENT, reason: 'a test: the retired app is no longer offered, listed, woken, guarded or run' }
const judge = { class: CURRENT, reason: `the judge's key reader (\`${oc} auth export\` at each call, Epic 123 D2) and Jev's gateway ${OC} Zen` }
const judgeTest = { class: CURRENT, reason: `a test of the judge: its key through a stand-in \`${oc} auth export\`, or its gateway ${OC} Zen` }
const isolation = { class: CURRENT, reason: `test isolation: ${OC}'s config root points into the test home, so no run reaches the owner's own ${OC} files` }
const oldRecord = { class: COMPATIBILITY, reason: 'a record saved before the retirement, read as saved and never acted on' }
const oldRecordTest = { class: COMPATIBILITY, reason: 'a test of a record saved before the retirement, read as saved and never acted on' }
const measured = { class: EVIDENCE, reason: `a measurement made while ${OC} was supported, kept with its date (its code is at the tag ${TAG})` }

/** Each further name: its pattern, why it is still named, and where: file -> its class and its reason. */
export const NAMED = {
  [Z]: {
    status: 'switched off on the team, not retired (dev-auto references/models.md:10, owner 2026-09-30; Epic 80, owner 2026-10-19)',
    patterns: [standalone(z, '(?:chat)?')],
    allowed: {
      'apps/desktop/bin/bmn-hooks.mjs': configFolder,
      'apps/desktop/bin/native-rules.mjs': secretFile,
      'apps/desktop/bin/secret-list.mjs': secretFile,
      'apps/desktop/src/utility/command-guard-never.test.ts': secretFile,
      'apps/desktop/src/utility/native-rules.test.ts': secretFile,
      'apps/desktop/src/renderer/src/plan-use-view.tsx': configFolder,
      'apps/desktop/src/renderer/src/session-presentation.ts': configFolder,
      'apps/desktop/src/utility/agent-history.ts': configFolder,
      'apps/desktop/src/utility/companion-service.ts': configFolder,
      'shared/protocol/src/companion.ts': configFolder,
      'shared/protocol/src/model-origin.ts': originTable('🇨🇳'),
      'shared/protocol/src/model-origin.test.ts': originTable('🇨🇳'),
      'docs/agent-control.md': { class: CURRENT, reason: `the model origin rule: Z.ai serves ${Z} behind Claude model names` },
      'docs/agent-history.md': configFolder,
      'docs/features.md': { class: CURRENT, reason: `the model origin flag, and \`claude ${z}\` getting the history limit as its own setting` },
      'docs/usage-sources.md': { class: EVIDENCE, reason: `Story 37.1's measurement of \`claude ${z}\` (2026-09-28), and the one current line it set: no plan windows` },
      'apps/desktop/src/main/agent-history-self-test.ts': folderTest,
      'apps/desktop/src/main/self-test/runner.ts': folderTest,
      'apps/desktop/src/utility/agent-history.test.ts': folderTest,
      'apps/desktop/src/utility/database-archive-purge.test.ts': folderTest,
      'apps/desktop/src/renderer/src/session-presentation.test.ts': hookTest,
      'apps/desktop/src/utility/companion-service.test.ts': hookTest,
      'apps/desktop/src/utility/control-cli.test.ts': hookTest,
      'apps/desktop/src/utility/control-server.test.ts': hookTest,
      'apps/desktop/src/utility/test-fixtures/agents/roster-example.md': rosterFixture,
      'apps/desktop/src/main/agents-approval.test.ts': rosterFixture,
      'apps/desktop/src/main/agents-ipc.test.ts': rosterFixture,
      'apps/desktop/src/renderer/src/model-suggestions.test.ts': rosterFixture,
      'apps/desktop/src/renderer/src/roster-staging.test.ts': rosterFixture,
      'apps/desktop/src/renderer/src/team-rules-preferences.test.ts': rosterFixture,
      'apps/desktop/src/utility/agents-check.test.ts': rosterFixture,
      'apps/desktop/src/utility/agents-project-choices.test.ts': rosterFixture,
      'apps/desktop/src/utility/agents-research.test.ts': rosterFixture,
      'apps/desktop/src/utility/agents-roster.test.ts': rosterFixture,
      'apps/desktop/src/utility/agents-rules.test.ts': rosterFixture,
      'apps/desktop/src/utility/agents-team-ask.test.ts': rosterFixture,
      'scripts/test/agents-rules-visual.mjs': rosterFixture,
      'scripts/test/button-screens.mjs': rosterFixture
    }
  },
  [GEM]: {
    status: 'never supported as an agent app; what is left names a command or a model family BMN still meets',
    patterns: [standalone(gem)],
    allowed: {
      'scripts/test/away-skills-decode.mjs': { class: CURRENT, reason: 'the Away evidence decoder detects unapproved provider commands' },
      'apps/desktop/bin/agents-team-inputs.mjs': { class: CURRENT, reason: `\`~/.${gem}\` is a credential location: never an ask input or project` },
      'apps/desktop/src/renderer/src/session-presentation.ts': { class: CURRENT, reason: `the tag a session running \`${gem}\` gets; it runs as a plain terminal` },
      'docs/features.md': { class: CURRENT, reason: 'the launcher note: the commands BMN tags, and which of them it integrates' },
      'shared/protocol/src/model-origin.ts': originTable('🇺🇸'),
      'shared/protocol/src/model-origin.test.ts': originTable('🇺🇸'),
      'apps/desktop/src/utility/agents-rules.test.ts': unknownApp,
      'apps/desktop/src/utility/control-cli.test.ts': unknownApp,
      'apps/desktop/src/utility/control-server.test.ts': unknownApp,
      'apps/desktop/src/utility/store-schema.test.ts': unknownApp,
      'shared/protocol/src/attention-prompt.test.ts': unknownApp
    }
  },
  [AID]: {
    status: 'never supported as an agent app; a session running its command is still tagged',
    patterns: [standalone(aid)],
    allowed: {
      'apps/desktop/src/renderer/src/session-presentation.ts': { class: CURRENT, reason: `the tag a session running \`${aid}\` gets; it runs as a plain terminal` },
      'docs/features.md': { class: CURRENT, reason: 'the launcher note: the commands BMN tags, and which of them it integrates' }
    }
  },
  [OC]: {
    status: `retired 2026-11-20 (Epic 123, owner's go 2026-11-19); BMN's support for it is kept at the git tag ${TAG}`,
    patterns: [standalone(oc)],
    allowed: {
      '.gitignore': { class: CURRENT, reason: `keeps the project folder \`${oc}\` makes out of git: the owner still has the program` },
      // The retirement and what answers for it.
      'apps/desktop/bin/agents-roster.mjs': retirement,
      'apps/desktop/bin/agents-roster.d.mts': retirement,
      'shared/protocol/src/agents-roster.ts': retirement,
      'apps/desktop/bin/agents-rules.mjs': retiredAnswer,
      'apps/desktop/bin/bmn-hooks.mjs': retiredAnswer,
      'apps/desktop/src/main/self-test/runner.ts': { class: CURRENT, reason: 'the self-test of the retirement: its hook, team file and setup Undo answer "retired", and nothing starts' },
      'apps/desktop/src/main/agent-history-self-test.ts': { class: CURRENT, reason: `the self-test plants an ${OC} store and program and checks BMN neither lists nor runs them` },
      'scripts/test/electron-self-test.mjs': { class: CURRENT, reason: `the self-test check of the retirement, and ${OC}'s config root inside the test home` },
      'scripts/test/start-installs-live.mjs': { class: CURRENT, reason: `a live test: BMN writes nothing into an ${OC} folder at start, and Health lists no row for it` },
      'scripts/test/agents-rules-visual.mjs': { class: CURRENT, reason: `a screen test: no rules row for the retired app, and the judge's key through a stand-in \`${oc} auth export\`` },
      'scripts/test/session-messages.mjs': retiredTest,
      'scripts/test/away-wake-live.mjs': { class: CURRENT, reason: `points to the tag ${TAG}, which keeps its two removed scenarios` },
      'scripts/test/health-screens-visual.mjs': { class: CURRENT, reason: 'why the audit fixture moved its tool findings to Codex' },
      'scripts/test/live-panel-layout.mjs': { class: CURRENT, reason: `why the launcher check picks Codex, and ${OC}'s config root inside the test home` },
      'apps/desktop/src/utility/agents-check.test.ts': retiredTest,
      'apps/desktop/src/utility/agents-guard.test.ts': retiredTest,
      'apps/desktop/src/utility/agents-roster.test.ts': retiredTest,
      'apps/desktop/src/utility/agents-rules.test.ts': retiredTest,
      'apps/desktop/src/utility/agents-team-ask.test.ts': retiredTest,
      'apps/desktop/src/utility/control-cli.test.ts': retiredTest,
      'apps/desktop/src/utility/control-server.test.ts': retiredTest,
      'scripts/tests/setup-config-write.test.mjs': retiredTest,
      'scripts/tests/setup-tool-defaults.test.mjs': retiredTest,
      'apps/desktop/src/renderer/src/team-rules-preferences.test.ts': notOffered,
      'apps/desktop/src/renderer/src/launch-template.test.ts': notOffered,
      'apps/desktop/src/renderer/src/update-restart-dialog.test.ts': notOffered,
      'apps/desktop/src/utility/agent-away-notices.test.ts': notOffered,
      'apps/desktop/src/utility/agent-briefs.test.ts': notOffered,
      'apps/desktop/src/utility/agents-context.test.ts': notOffered,
      'apps/desktop/src/utility/agents-research.test.ts': notOffered,
      'apps/desktop/src/utility/command-guard.test.ts': notOffered,
      'apps/desktop/src/utility/message-wake.test.ts': notOffered,
      'apps/desktop/src/utility/turn-changes-recorder.test.ts': notOffered,
      'apps/desktop/src/utility/turn-marks.test.ts': notOffered,
      'apps/desktop/src/utility/agents-source-search.test.ts': { class: CURRENT, reason: 'a test: the source search no longer holds the modules Epic 123 removed' },
      'shared/protocol/src/agent-brief.test.ts': notOffered,
      'scripts/tests/bmn-cpu.test.mjs': notOffered,
      // The judge keeps its key reader and its gateway (Epic 123 D2).
      'apps/desktop/bin/agents-judge.mjs': judge,
      'apps/desktop/src/renderer/src/judge-page.tsx': judge,
      'apps/desktop/src/renderer/src/roster-staging.ts': judge,
      'apps/desktop/src/renderer/src/setup-team-staging.ts': judge,
      'skills/jev-judge/SKILL.md': judge,
      'apps/desktop/src/utility/agents-judge.test.ts': judgeTest,
      'apps/desktop/src/main/agents-ipc.test.ts': judgeTest,
      'apps/desktop/src/renderer/src/judge-page.test.ts': judgeTest,
      'apps/desktop/src/renderer/src/roster-staging.test.ts': judgeTest,
      'apps/desktop/src/utility/agents-called.test.ts': judgeTest,
      'shared/protocol/src/model-origin.test.ts': judgeTest,
      // Where the owner's program keeps things: never an ask input, and passed through to his own shells unchanged.
      'apps/desktop/bin/agents-team-inputs.mjs': { class: CURRENT, reason: `an ${OC} sign-in or store is a credential location: never an ask input or project` },
      'apps/desktop/src/utility/agents-team-places.test.ts': { class: CURRENT, reason: `a test: an ${OC} store is a place an ask never reads` },
      'apps/desktop/src/utility/session-manager.test.ts': { class: CURRENT, reason: `a test: the owner's environment, ${OC}'s settings included, reaches a shell he starts unchanged` },
      'scripts/test/away-skills-decode.mjs': { class: CURRENT, reason: `the Away evidence decoder detects unapproved provider commands, \`${oc} run\` among them` },
      'scripts/test/quick-look-live.mjs': { class: CURRENT, reason: `a made-up config file named as ${OC} names its own, to test that Quick Look masks its key` },
      'docs/development.md': isolation,
      'scripts/measure/calibration-environment.mjs': isolation,
      'scripts/qa/bench-lib.mjs': isolation,
      'scripts/qa/bench-recorder.py': isolation,
      'scripts/smoke/packaged.mjs': isolation,
      'scripts/test/archive-purge-files.mjs': isolation,
      'scripts/test/brain-map-visual.mjs': isolation,
      'scripts/test/brain-page-visual.mjs': isolation,
      'scripts/test/browser-accounts-ui.mjs': isolation,
      'scripts/test/draft-delivery.mjs': isolation,
      'scripts/tests/calibration-environment.test.mjs': isolation,
      'scripts/tests/qa-bench.test.mjs': isolation,
      'apps/desktop/src/main/doctor-startup-round.test.ts': isolation,
      'apps/desktop/src/main/setup-defaults-routing.test.ts': isolation,
      'apps/desktop/src/utility/doctor-item-continuity.test.ts': isolation,
      'apps/desktop/src/utility/doctor-location-only-recovery.test.ts': isolation,
      'apps/desktop/src/utility/doctor-recovery-round.test.ts': isolation,
      'apps/desktop/src/utility/doctor-profile.test.ts': isolation,
      // Old records, read as they were saved.
      'apps/desktop/bin/defaults-ownership.mjs': oldRecord,
      'apps/desktop/bin/doctor-leftover-results.mjs': oldRecord,
      'apps/desktop/bin/doctor-locations.mjs': oldRecord,
      'apps/desktop/bin/doctor-results.mjs': oldRecord,
      'apps/desktop/bin/doctor-state.mjs': oldRecord,
      'apps/desktop/bin/doctor-text.mjs': oldRecord,
      'apps/desktop/bin/setup-recovery.mjs': oldRecord,
      'apps/desktop/bin/setup-skill-records.mjs': oldRecord,
      'apps/desktop/src/renderer/src/doctor-health.tsx': oldRecord,
      'apps/desktop/src/renderer/src/main.tsx': oldRecord,
      'apps/desktop/src/renderer/src/session-presentation.ts': oldRecord,
      'apps/desktop/src/utility/agent-history.ts': oldRecord,
      'apps/desktop/src/utility/conversation-binding.ts': oldRecord,
      'apps/desktop/src/utility/database-away-wake-store.ts': oldRecord,
      'apps/desktop/src/utility/store-schema.ts': { class: COMPATIBILITY, reason: 'the migration that once allowed its bindings' },
      'shared/protocol/src/away-night.ts': oldRecord,
      'shared/protocol/src/binding.ts': oldRecord,
      'shared/protocol/src/companion.ts': oldRecord,
      'shared/protocol/src/doctor.ts': oldRecord,
      'shared/protocol/src/workspace.ts': oldRecord,
      'apps/desktop/src/renderer/src/auto-test-words.test.ts': oldRecordTest,
      'apps/desktop/src/renderer/src/doctor-health.test.ts': oldRecordTest,
      'apps/desktop/src/renderer/src/hook-events-dialog.test.ts': oldRecordTest,
      'apps/desktop/src/renderer/src/session-messages-dialog.test.ts': oldRecordTest,
      'apps/desktop/src/renderer/src/session-presentation.test.ts': oldRecordTest,
      'apps/desktop/src/renderer/src/team-asks.test.ts': oldRecordTest,
      'apps/desktop/src/renderer/src/tools-view.test.ts': oldRecordTest,
      'apps/desktop/src/renderer/src/turn-changes-dialog.test.ts': oldRecordTest,
      'apps/desktop/src/renderer/src/turn-changes-presentation.test.ts': oldRecordTest,
      'apps/desktop/src/utility/agents-tools.test.ts': oldRecordTest,
      'apps/desktop/src/utility/away-wake.test.ts': oldRecordTest,
      'apps/desktop/src/utility/conversation-binding.test.ts': oldRecordTest,
      'apps/desktop/src/utility/doctor-continuity-pipeline.test.ts': oldRecordTest,
      'apps/desktop/src/utility/doctor-hooks-contract.test.ts': oldRecordTest,
      'apps/desktop/src/utility/doctor-locations.test.ts': oldRecordTest,
      'apps/desktop/src/utility/doctor-predicate-continuity.test.ts': oldRecordTest,
      'apps/desktop/src/utility/doctor-reader-round.test.ts': oldRecordTest,
      'apps/desktop/src/utility/doctor-results.test.ts': oldRecordTest,
      'apps/desktop/src/utility/doctor-runtime.test.ts': oldRecordTest,
      'apps/desktop/src/utility/doctor-text.test.ts': oldRecordTest,
      'apps/desktop/src/utility/remote-answer.test.ts': oldRecordTest,
      'apps/desktop/src/utility/store-schema.test.ts': oldRecordTest,
      'apps/desktop/src/utility/telegram-cards.test.ts': oldRecordTest,
      'shared/protocol/src/attention-prompt.test.ts': oldRecordTest,
      'shared/protocol/src/away-night.test.ts': oldRecordTest,
      'shared/protocol/src/protocol.test.ts': oldRecordTest,
      // Docs: the retired section, and measurements kept with their dates.
      'docs/agent-control.md': { class: CURRENT, reason: 'the retired section: what the retirement means, the tag, and the judge\'s key reader' },
      'docs/agent-history.md': { class: CURRENT, reason: 'BMN no longer reads or deletes its sessions, since the retirement' },
      'docs/features.md': { class: CURRENT, reason: 'the launcher note: the commands BMN tags, the retired one marked so' },
      'docs/remote-answers.md': measured,
      'docs/survival-matrix.md': measured,
      'docs/turn-changes.md': measured,
      'docs/usage-sources.md': measured,
      'scripts/test/cursor-screens-visual.mjs': { class: EVIDENCE, reason: 'Epic 71\'s before-and-after screens, made with a team file that named it' },
      [`scripts/test/${oc}-screens-visual.mjs`]: { class: EVIDENCE, reason: `Epic 123's before-and-after screens (123.2), made on a team file and records from before the retirement` }
    }
  }
}

/**
 * Folders whose files are other projects' or generated, never this repository's own text; and the lockfile, whose
 * integrity hashes can hold any three letters after a `+` or `/`.
 */
const SKIPPED = /^(plan|\.dev-auto|node_modules)\/|(^|\/)pnpm-lock\.yaml$|\.(png|jpe?g|ico|icns|woff2?|ttf)$/

/** Each line naming the retired app (or, given `patterns`, another name), in every file git tracks under `root`. */
export function findReferences(root, patterns = PATTERNS) {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
  const found = []
  for (const file of files) {
    if (SKIPPED.test(file)) continue
    let text
    try {
      text = readFileSync(resolve(root, file), 'utf8')
    } catch {
      continue
    }
    text.split('\n').forEach((line, index) => {
      if (patterns.some((pattern) => pattern.test(line))) found.push({ file, line: index + 1, text: line.trim() })
    })
  }
  return found
}

/** Files that name it without an entry, and entries that no longer name it (`allowed`: one name's file -> entry). */
export function compareWithAllowed(found, allowed = ALLOWED) {
  const named = new Set(found.map((entry) => entry.file))
  return {
    unexpected: [...named].filter((file) => !Object.hasOwn(allowed, file)).sort(),
    stale: Object.keys(allowed).filter((file) => !named.has(file)).sort()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  let failures = 0
  for (const [name, { patterns, allowed }] of [[NAME, { patterns: PATTERNS, allowed: ALLOWED }], ...Object.entries(NAMED)]) {
    const found = findReferences(root, patterns)
    for (const entry of found) console.log(`${name}: ${entry.file}:${entry.line}: ${entry.text}`)
    const { unexpected, stale } = compareWithAllowed(found, allowed)
    for (const file of unexpected) console.log(`NOT ALLOWED (${name}): ${file}`)
    for (const file of stale) console.log(`STALE ENTRY (${name}): ${file}`)
    console.log(`${name}: ${found.length} lines in ${new Set(found.map((entry) => entry.file)).size} files; ${unexpected.length} not allowed, ${stale.length} stale`)
    failures += unexpected.length + stale.length
  }
  process.exitCode = failures === 0 ? 0 : 1
}
