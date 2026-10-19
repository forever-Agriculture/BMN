// MODULE: retired-references.mjs - Epic 71 (71.2 AC5), Story 80.20: every place the repository still names the retired app, or
// one of three more apps it no longer runs or never ran, against a short allowlist per name
// Run it to list them: `node scripts/lib/retired-references.mjs`. scripts/tests/retired-references.test.mjs keeps each list
// and its allowlist the same, so a new reference fails until it is named here with its reason (and, for the three, its class).
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
  'apps/desktop/src/utility/session-manager.ts': 'a binding saved before the retirement, never resumed or looked for',
  'apps/desktop/src/utility/store-schema.ts': 'the migration that once allowed its bindings',
  'apps/desktop/src/utility/agent-history.ts': 'a history state saved before the retirement',
  'apps/desktop/src/renderer/src/session-presentation.ts': 'its name on old sessions, sets and requests',
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
const originTable = (flag) => ({ class: CURRENT, reason: `the model origin table: such a model reads ${flag}` })

/** Each further name: its pattern, why it is still named, and where: file -> its class and its reason. */
export const NAMED = {
  [Z]: {
    status: 'switched off on the team, not retired (dev-auto references/models.md:10, owner 2026-09-30; Epic 80, owner 2026-10-19)',
    patterns: [standalone(z, '(?:chat)?')],
    allowed: {
      'apps/desktop/bin/bmn-hooks.mjs': configFolder,
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
