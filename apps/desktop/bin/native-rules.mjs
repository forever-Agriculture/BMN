// MODULE: native-rules.mjs - Epic 102: the rules BMN keeps in the apps' own configuration, so "never" holds with BMN's hook broken or absent
//
// A floor, not the guard: each app reads its rules literally, so only the usual forms are refused here (the docs say which);
// the guard's parser stays the fuller check. BMN adds its rows beside the owner's and changes none of his.
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { SECRET_FILES } from './secret-list.mjs'

const CONTAINER_TOOLS = ['docker', 'podman']
const PRUNED = ['system', 'image', 'container', 'volume', 'network', 'builder', 'buildx']

/** D5's commands, each also after `sudo`: only what the owner already said never to run. */
const NEVER = [...CONTAINER_TOOLS.flatMap((tool) => PRUNED.map((what) => `${tool} ${what} prune`)), 'prime-select nvidia']
export const NEVER_COMMANDS = [...NEVER, ...NEVER.map((command) => `sudo ${command}`)]

/**
 * The private keys in `~/.ssh`, by name: Claude's `!` carve-out does not apply to `~/` rules, so `id_*` would take the `.pub`
 * files too. A key is `id_*`, or any file with a `.pub` beside it; nothing is opened.
 */
export function privateKeyNames(home) {
  let names
  try {
    names = readdirSync(join(home, '.ssh'))
  } catch {
    return []
  }
  const present = new Set(names)
  return names.filter((name) => !name.endsWith('.pub') && (name.startsWith('id_') || present.has(`${name}.pub`))).sort()
}

/** The whole secret list as literal paths under the home folder, private keys by name; a `*` stands only for a folder's files. */
export function secretPaths(home) {
  return SECRET_FILES.flatMap((entry) => (entry === '.ssh/id_*' ? privateKeyNames(home).map((name) => `.ssh/${name}`) : [entry]))
}

/** Claude's `permissions.deny` rows BMN keeps: refused in every mode, and evaluated before any allow row. */
export function claudeDenyRows(home) {
  return [
    ...NEVER_COMMANDS.map((command) => `Bash(${command}:*)`),
    ...secretPaths(home).map((path) => `Read(~/${path.replace(/\/\*$/, '/**')})`)
  ]
}

/** The rows of `deny` that BMN would add to this settings object; null when its `permissions` cannot take them. */
export function missingClaudeRows(data, home) {
  const permissions = data?.permissions
  if (permissions !== undefined && (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions))) return null
  if (permissions?.deny !== undefined && !Array.isArray(permissions.deny)) return null
  const have = new Set(permissions?.deny ?? [])
  return claudeDenyRows(home).filter((row) => !have.has(row))
}

/** The settings with BMN's rows after his, every other key and row left where it was. */
export function withClaudeRows(data, rows) {
  if (rows.length === 0) return data
  const permissions = data.permissions ?? {}
  return { ...data, permissions: { ...permissions, deny: [...(permissions.deny ?? []), ...rows] } }
}

/** Codex's rules file BMN owns whole: removing the file removes the rules. */
export const CODEX_RULES_FILE = 'bmn-guard.rules'
const list = (words) => `[${words.map((word) => JSON.stringify(word)).join(', ')}]`
export const CODEX_RULES = [
  '# Written by BMN (Epic 102); `bmn hooks install` rewrites it, and deleting the file removes these rules.',
  ...['', 'sudo'].flatMap((before) => {
    const start = before === '' ? [] : [`${JSON.stringify(before)}, `]
    return [
      `prefix_rule(pattern=[${start.join('')}${list(CONTAINER_TOOLS)}, ${list(PRUNED)}, "prune"], decision="forbidden")`,
      `prefix_rule(pattern=[${start.join('')}"prime-select", "nvidia"], decision="forbidden")`
    ]
  }),
  ''
].join('\n')

export const codexRulesPath = (codexHome) => join(codexHome, 'rules', CODEX_RULES_FILE)

/** What a Codex teammate may not read (Story 102.7): the secret list and GnuPG's private keys, private keys named at each ask's start. */
export function codexDeniedPaths(home) {
  return [...secretPaths(home).map((path) => join(home, path.replace(/\/\*$/, ''))), join(home, '.gnupg/private-keys-v1.d')]
}

/**
 * Codex's own permission profile for an ask (beta; measured in `codex exec` on 0.166.0, plan/references/102): read-only, and
 * these paths denied to the shell and its sub-agents through a link or not, while Codex itself still signs in. `-c` items, in
 * place of `--sandbox read-only`, which would conflict with it. A Codex that refuses them fails the ask: it never runs without.
 */
export const CODEX_ASK_PROFILE = 'bmn_ask'
export function codexAskProfile(home) {
  const denied = codexDeniedPaths(home).map((path) => `${JSON.stringify(path)}="deny"`).join(',')
  return ['-c', `default_permissions="${CODEX_ASK_PROFILE}"`, '-c', `permissions.${CODEX_ASK_PROFILE}={extends=":read-only",filesystem={${denied}}}`]
}

/** The listed credential stores, in the words a teammate's record and `--features` say them. */
export const CODEX_DENIED_WORDS = '~/.ssh private keys, ~/.codex/auth.json, ~/.claude/.credentials.json, ~/.config/keepassxc/master.keyx, ~/Documents/KeePass, ~/.config/gh/hosts.yml, ~/.aws/credentials, ~/.netrc, ~/.git-credentials, ~/.claude-glm/secret.env, ~/.gnupg/private-keys-v1.d'
