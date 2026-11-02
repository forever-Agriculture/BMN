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

/** Whether a word of a command names a listed file: under the home folder or, as a whole word, relative to where it runs. */
export function namesSecretFile(word) {
  const relative = underHome(word) ?? (word.startsWith('/') ? null : tidy(word))
  return relative !== null && (isSecretFile(relative) || wildcardMatchesSecret(relative))
}

/** Whether a word names a folder under the home folder, or the home folder, that holds a listed file. */
export function namesFolderOfSecret(word) {
  const relative = underHome(word)
  if (relative === null) return false
  if (relative === '') return true
  return EXAMPLES.some((example) => example.startsWith(`${relative}/`))
}
