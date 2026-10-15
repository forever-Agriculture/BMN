import { open, readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'

const skippedDirectories = new Set(['.git', 'node_modules', 'out', 'dist', 'release', 'coverage'])
const sourceExtensions = new Set([
  '.bash', '.cjs', '.env', '.js', '.json', '.mjs', '.sh', '.ts', '.tsx', '.yaml', '.yml', '.zsh'
])
const shellConfigurationFiles = new Set([
  '.bash_login', '.bash_profile', '.bashrc', '.profile', '.zlogin', '.zprofile', '.zshenv', '.zshrc'
])
const rootFiles = new Set(['.npmrc', 'package.json', 'pnpm-workspace.yaml'])
const sandboxAssignmentKeys = [
  ['chromium', 'Sandbox'].join(''),
  ['chromium', '_sandbox'].join(''),
  ['chromium', '-sandbox'].join(''),
  ['sand', 'box'].join('')
].join('|')
const falsyWords = [
  ['fal', 'se'].join(''),
  'null',
  'undefined',
  'NaN',
  'off',
  'no'
].join('|')
const disabledBoolean = ['fal', 'se'].join('')
const sandboxAssignment = new RegExp(
  `(?:^|[^\\w-])(?:"(?:${sandboxAssignmentKeys})"|'(?:${sandboxAssignmentKeys})'|(?:${sandboxAssignmentKeys}))\\s*[:=]\\s*`,
  'gim'
)
const falsyWord = new RegExp(`^(?:${falsyWords})`, 'i')
const quotedDisabledBoolean = new RegExp(`^(["'])${disabledBoolean}\\1`, 'i')
const numericLiteral = /^[+-]?(?:0[xX][0-9a-fA-F](?:_?[0-9a-fA-F])*n?|0[bB][01](?:_?[01])*n?|0[oO][0-7](?:_?[0-7])*n?|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?n?)/u

const forbidden = [
  {
    label: 'sandbox bypass command-line option',
    pattern: new RegExp(`(?:^|[^\\w-])(?:--)?${['no', 'sandbox'].join('-')}(?:$|[^\\w-])`, 'i')
  },
  {
    label: 'sandbox-disable wildcard option',
    pattern: new RegExp(`(?:^|[^\\w-])(?:--)?${['disable', '[\\w-]*sandbox[\\w-]*'].join('-')}(?:$|[^\\w-])`, 'i')
  },
  { label: 'sandbox bypass environment variable', pattern: ['ELECTRON', 'DISABLE', 'SANDBOX'].join('_') }
]

function hasLiteralTerminator(source, literalLength) {
  return /^(?:[ \t]*(?:$|[,;)}\]]|\/\/|\/\*|#)|\r?\n)/u.test(source.slice(literalLength))
}

function isZeroNumberLiteral(source) {
  const match = numericLiteral.exec(source)
  if (!match || !hasLiteralTerminator(source, match[0].length)) return false
  const normalized = match[0].replaceAll('_', '').replace(/^[+-]/u, '')
  try {
    return normalized.endsWith('n')
      ? BigInt(normalized.slice(0, -1)) === 0n
      : Number(normalized) === 0
  } catch {
    return false
  }
}

function hasFalsyLiteralAssignment(content) {
  sandboxAssignment.lastIndex = 0
  for (const match of content.matchAll(sandboxAssignment)) {
    const value = content.slice((match.index ?? 0) + match[0].length)
    if ((value.startsWith('""') || value.startsWith("''")) && hasLiteralTerminator(value, 2)) {
      return true
    }
    const quotedBoolean = quotedDisabledBoolean.exec(value)
    if (quotedBoolean && hasLiteralTerminator(value, quotedBoolean[0].length)) return true
    const negatedOne = /^!\s*1/u.exec(value)
    if (negatedOne && hasLiteralTerminator(value, negatedOne[0].length)) return true
    const word = falsyWord.exec(value)
    if (word && hasLiteralTerminator(value, word[0].length)) return true
    if (isZeroNumberLiteral(value)) return true
  }
  // Computed expressions and identifier values cannot be decided by a textual tripwire.
  return false
}

export function findSandboxDisablingText(content) {
  const findings = forbidden
    .filter((rule) =>
      typeof rule.pattern === 'string' ? content.includes(rule.pattern) : rule.pattern.test(content)
    )
    .map((rule) => rule.label)
  if (hasFalsyLiteralAssignment(content)) findings.push('disabled sandbox assignment')
  return findings
}

function isNamedExecutableOrConfig(name) {
  return (
    sourceExtensions.has(extname(name)) ||
    name === '.env' ||
    name.startsWith('.env.') ||
    shellConfigurationFiles.has(name)
  )
}

async function startsWithShebang(path) {
  const handle = await open(path, 'r')
  try {
    const prefix = Buffer.alloc(2)
    const { bytesRead } = await handle.read(prefix, 0, prefix.length, 0)
    return bytesRead === prefix.length && prefix.toString('utf8') === '#!'
  } finally {
    await handle.close()
  }
}

async function sourceFiles(path, isRoot = false) {
  const entries = await readdir(path, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) files.push(...(await sourceFiles(join(path, entry.name))))
      continue
    }
    const file = join(path, entry.name)
    if (
      isNamedExecutableOrConfig(entry.name) ||
      (isRoot && rootFiles.has(entry.name)) ||
      (extname(entry.name) === '' && await startsWithShebang(file))
    ) files.push(file)
  }
  return files
}

export async function scanForSandboxDisablingFlags(repoRoot) {
  const roots = ['apps', 'shared', 'scripts']
  const files = []
  for (const root of roots) {
    try {
      files.push(...(await sourceFiles(join(repoRoot, root))))
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error
    }
  }
  for (const rootFile of rootFiles) files.push(join(repoRoot, rootFile))

  const findings = []
  for (const file of files) {
    let content
    try {
      content = await readFile(file, 'utf8')
    } catch (error) {
      const isMissingRootFile =
        rootFiles.has(relative(repoRoot, file)) &&
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      if (isMissingRootFile) continue
      throw error
    }
    for (const rule of findSandboxDisablingText(content)) {
      findings.push({ file: relative(repoRoot, file), rule })
    }
  }
  return findings
}
