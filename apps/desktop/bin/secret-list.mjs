// MODULE: secret-list.mjs - Epic 102: BMN's one list of the owner's credential files, read by the guard and the rules BMN installs in the apps

/** Paths under the home folder. `*` stands for any name in that folder; `.ssh/id_*` leaves out `.pub`. */
export const SECRET_FILES = [
  '.ssh/id_*',
  '.codex/auth.json',
  '.claude/.credentials.json',
  '.config/keepassxc/master.keyx',
  'Documents/KeePass/*',
  '.config/gh/hosts.yml',
  '.aws/credentials',
  '.netrc',
  '.git-credentials',
  '.claude-glm/secret.env'
]

/** A name standing for what a `*` of the list can be, so that a word with a wildcard of its own can be tried against the list. */
const EXAMPLES = SECRET_FILES.map((entry) => entry.replace('*', 'x'))

const wildcard = (pattern) => new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')}$`)
const LISTED = SECRET_FILES.map(wildcard)

/** Whether a path under the home folder is on the list. */
export const isSecretFile = (relative) => !(relative.startsWith('.ssh/') && relative.endsWith('.pub')) && LISTED.some((pattern) => pattern.test(relative))

/** `~`, `$HOME`, `${HOME}`, `/home/NAME` or `/root` at the start of a path, however the word goes on (`@~/x`, `--file=~/x`, `file:///home/n/x`). */
const HOME = /(?<![\w.~/-])(?:~|\$HOME|\$\{HOME\}|\/+home\/[^/\s:=@'"]+|\/+root)(?=\/|$)/

/** Drop `.`, `..` and repeated or trailing slashes; `..` above the start ends where it started. */
const tidy = (path) => {
  const parts = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/')
}

/** The path under the home folder that a shell word names, as a string (`''` is the home folder itself), or null. */
export function underHome(word) {
  const found = HOME.exec(word)
  return found === null ? null : tidy(word.slice(found.index + found[0].length))
}

const wildcardMatchesSecret = (relative) => /[*?]/.test(relative) && !relative.endsWith('.pub') &&
  EXAMPLES.some((example) => wildcard(relative).test(example))

/**
 * Epic 137: BMN's own owner keys, by file name wherever they sit: `owner.token` beside the control socket (under the
 * runtime folder, outside the home folder) and the Telegram bot's token in BMN's config folder. Only the guard holds them;
 * the apps' own rules do not list them.
 */
export const BMN_KEY_NAMES = ['owner.token', 'telegram-bot.token']

/** The folders that hold a key: the control folder and BMN's config folder, current or legacy. */
const KEY_FOLDER = /(^|\/)((bmn|ai-terminal)\/control|\.config\/(bmn|ai-terminal))$/

/** Whether a word names one of BMN's owner keys: by its name, or a wildcard in the key's own folder (or none) that takes it. */
export function namesBmnKey(word) {
  const path = tidy(word)
  const slash = path.lastIndexOf('/')
  const name = path.slice(slash + 1)
  if (BMN_KEY_NAMES.includes(name)) return true
  if (!/[*?]/.test(name) || (slash !== -1 && !KEY_FOLDER.test(path.slice(0, slash)))) return false
  return BMN_KEY_NAMES.some((key) => wildcard(name).test(key))
}

/** Whether a word of a command names a listed file: under the home folder or, as a whole word, relative to where it runs. */
export function namesSecretFile(word) {
  if (namesBmnKey(word)) return true
  const relative = underHome(word) ?? (word.startsWith('/') ? null : tidy(word))
  return relative !== null && (isSecretFile(relative) || wildcardMatchesSecret(relative))
}

/** Whether a word names a folder that holds a listed file or a BMN key: under the home folder, the home folder, or BMN's runtime or control folder. */
export function namesFolderOfSecret(word) {
  if (KEY_FOLDER.test(tidy(word)) || /(^|\/)run\/user\/\d+\/(bmn|ai-terminal)$/.test(tidy(word))) return true
  const relative = underHome(word)
  if (relative === null) return false
  if (relative === '') return true
  return EXAMPLES.some((example) => example.startsWith(`${relative}/`))
}
