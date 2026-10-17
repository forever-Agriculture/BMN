// MODULE: retired-references.mjs - Epic 71 (71.2 AC5): every place the repository still names the retired app, against a short allowlist
// Run it to list them: `node scripts/lib/retired-references.mjs`. scripts/tests/retired-references.test.mjs keeps the list
// and the allowlist the same, so a new reference fails until it is named here with its reason.
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
  'apps/desktop/bin/bmn': 'bmn hook claude refuses a payload the retired app sends through Claude Code\'s hook files',
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

/** Folders whose files are other projects' or generated, never this repository's own text. */
const SKIPPED = /^(plan|\.dev-auto|node_modules)\/|\.(png|jpe?g|ico|icns|woff2?|ttf)$/

/** Each line naming the retired app, in every file git tracks under `root`. */
export function findReferences(root) {
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
      if (PATTERNS.some((pattern) => pattern.test(line))) found.push({ file, line: index + 1, text: line.trim() })
    })
  }
  return found
}

/** Files that name it without an entry, and entries that no longer name it. */
export function compareWithAllowed(found, allowed = ALLOWED) {
  const named = new Set(found.map((entry) => entry.file))
  return {
    unexpected: [...named].filter((file) => !Object.hasOwn(allowed, file)).sort(),
    stale: Object.keys(allowed).filter((file) => !named.has(file)).sort()
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
  const found = findReferences(root)
  for (const entry of found) console.log(`${entry.file}:${entry.line}: ${entry.text}`)
  const { unexpected, stale } = compareWithAllowed(found)
  for (const file of unexpected) console.log(`NOT ALLOWED: ${file}`)
  for (const file of stale) console.log(`STALE ENTRY: ${file}`)
  console.log(`${found.length} lines in ${new Set(found.map((entry) => entry.file)).size} files; ${unexpected.length} not allowed, ${stale.length} stale`)
  process.exitCode = unexpected.length + stale.length === 0 ? 0 : 1
}
