// MODULE: safe-config-write.mjs - backup, revision check and atomic write for agent config files, shared by bin/bmn and the utility process
import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join } from 'node:path'

/** A refusal with a stable code such as REVISION_CONFLICT; nothing was written when it is thrown. */
export class ConfigWriteError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const CliError = ConfigWriteError

/**
 * Absolute, but never through `resolve` or `join`: both collapse `..` as text, and a `..` has to
 * reach `linkTarget` intact or it is answered from where a link was written, not where it points.
 */
export function absoluteUncollapsed(path) {
  return isAbsolute(path) ? path : `${process.cwd()}/${path}`
}

/**
 * Temp file in the same folder, then rename: a crash mid-write leaves the old file intact. The
 * rename replaces whatever `path` names, so a symlinked settings file is resolved first and the
 * link itself survives, still pointing at the file that was updated. `verify` runs with the temp
 * written and the original still in place: it is the last chance to refuse rather than replace.
 */
/**
 * The file at the end of a symlink, followed even when it does not exist yet: a dotfiles repository
 * often links a settings file that is created later, and the harness reads the end of the link, so
 * that is the file BMN must write rather than the link it would otherwise replace.
 */
const MAX_LINK_HOPS = 10

export function linkTarget(path) {
  // Resolved the way the kernel resolves a path: one component at a time, following each symlink as
  // it is met, so `..` after a symlink steps back from where the link landed and not from where it
  // was written. Neither `resolve()` nor `realpathSync()` can be used here - both collapse `..` as
  // text first, which lands on a different file and would overwrite whatever happens to be there.
  // Made absolute by concatenation, never by `resolve`/`join`, which would collapse the `..` in the
  // given path itself before a single link had been read.
  let pending = absoluteUncollapsed(path).split('/').filter((part) => part !== '')
  let out = ''
  let hops = 0
  while (pending.length > 0) {
    const part = pending.shift()
    if (part === '.') continue
    if (part === '..') {
      out = out.slice(0, out.lastIndexOf('/'))
      continue
    }
    const next = `${out}/${part}`
    let link
    try {
      link = readlinkSync(next)
    } catch (error) {
      // A component that is not a link is simply itself, and one that is not there at all is a
      // directory the install will create. Only a `..` after a missing component is unanswerable:
      // where it steps back to depends on what that component would have been.
      if (error.code === 'ENOENT' && pending.includes('..')) {
        throw new CliError('UNRESOLVED_LINK', `${path} leads through ${next}, which does not exist; resolve it by hand`)
      }
      out = next
      continue
    }
    hops += 1
    if (hops > MAX_LINK_HOPS) {
      throw new CliError(
        'TOO_MANY_LINKS', `${path} passes through more than ${MAX_LINK_HOPS} symlinks; resolve it by hand`
      )
    }
    const target = isAbsolute(link) ? link : `${out}/${link}`
    pending = [...target.split('/').filter((part) => part !== ''), ...pending]
    out = ''
  }
  return out === '' ? '/' : out
}

export function writeAtomically(path, text, verify) {
  const target = linkTarget(path)
  const temporary = join(dirname(target), `.${basename(target)}.bmn-${process.pid}.tmp`)
  try {
    // A fresh machine has no ~/.codex yet, and that is the machine this command is for.
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(temporary, text, { mode: 0o600 })
    try {
      // chmod, not a second write: the mode option applies only when the file is created.
      chmodSync(temporary, statSync(target).mode & 0o777)
    } catch {
      // A new file keeps the restrictive mode above; a hook file names the owner's own machine.
    }
    verify?.(target)
    renameSync(temporary, target)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file is already gone, or was never created.
    }
    throw error
  }
  return target
}

/** The bytes on disk now, or null when the file is gone; used to refuse an overwrite of somebody else's edit. */
export function currentText(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * A JSON number literal as an exact decimal: sign, digits and a power of ten, with trailing zeros
 * removed so `1.0`, `1` and `1e0` all come out the same. Comparing these compares the numbers two
 * spellings denote, which is the only question worth asking about a rewrite.
 */
function decimalParts(token) {
  const parsed = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token)
  if (parsed === null) return null
  const [, sign, whole, fraction = '', exponent = '0'] = parsed
  let digits = `${whole}${fraction}`.replace(/^0+(?=\d)/, '')
  let scale = BigInt(exponent) - BigInt(fraction.length)
  while (digits.length > 1 && digits.endsWith('0')) {
    digits = digits.slice(0, -1)
    scale += 1n
  }
  return digits === '0' ? { sign: '', digits: '0', scale: 0n } : { sign, digits, scale }
}

/**
 * Numbers `install` would write back as a different number. It reserializes the file, and
 * `JSON.stringify` does not promise the digits it was handed: `18446744073709551615` comes out as
 * `18446744073709552000`, `1000000000000000128` as `1000000000000000100`, `9007199254740993.0` as
 * `9007199254740992`, and `1e400` as `null`. Each is a silent edit to a value BMN was not asked to
 * touch, in a file it had just called fine.
 *
 * So the comparison is between the literal in the file and the literal the writer would emit, as
 * exact decimals. `1.0` becoming `1` is the same number and is allowed; the rest are not. Judging
 * this from the shape of the token was the previous version of this guard, and it was wrong in
 * both directions.
 *
 * Node hands the reviver the literal source from 21 on. `bin/bmn` runs under whatever node the
 * machine has, so where that is missing this finds nothing and `install` behaves as it always did
 * - it is a guard on a rare file, never something `check` depends on.
 */
export function rewrittenNumbers(text) {
  const changed = []
  try {
    JSON.parse(text, function compareToken(key, value, context) {
      const source = context?.source
      if (typeof value !== 'number' || typeof source !== 'string') return value
      const before = decimalParts(source)
      const after = Number.isFinite(value) ? decimalParts(JSON.stringify(value)) : null
      if (before === null || after === null || before.sign !== after.sign
        || before.digits !== after.digits || before.scale !== after.scale) {
        changed.push(source)
      }
      return value
    })
  } catch {
    return []
  }
  return changed
}

/** The indent the file already uses, so installing changes the hooks and not every other line. */
export function jsonIndent(text) {
  const match = /\n([ \t]+)"/.exec(text)
  if (match === null) return 2
  return match[1].startsWith('\t') ? '\t' : match[1].length
}

/**
 * Replaces a config file only if it still holds `expectedText` (null: it must not exist), keeping a
 * copy of any existing file at `<path>.bmn-backup-<ISO time>` first. The check runs twice: before the
 * backup and again with the replacement staged, so the window for another writer is one rename.
 * `beforeCommit` is a test seam that runs between the two checks.
 */
export function writeConfigSafely(path, expectedText, nextText, { beforeCommit, now = () => new Date() } = {}) {
  const unchanged = () => {
    if (currentText(path) !== expectedText) {
      throw new ConfigWriteError('REVISION_CONFLICT', `${path} changed while BMN was reading it; nothing was written`)
    }
  }
  unchanged()
  let backup = null
  if (expectedText !== null) {
    backup = `${path}.bmn-backup-${now().toISOString()}`
    copyFileSync(path, backup)
  }
  const target = writeAtomically(path, nextText, () => {
    beforeCommit?.()
    unchanged()
  })
  return { target, backup }
}

/**
 * The directory that really holds a path's entry, every link on the way followed. Where the last
 * folders do not exist yet, the nearest one that does is resolved and the rest appended, so a link
 * above a folder BMN has still to create is bound as well.
 */
function holdingDirectory(path) {
  let existing = dirname(path)
  const missing = []
  for (;;) {
    try {
      return join(realpathSync(existing), ...missing)
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(existing) === existing) throw error
      missing.unshift(basename(existing))
      existing = dirname(existing)
    }
  }
}

/**
 * What a path holds right now, without following a final symbolic link: a regular file with its
 * bytes, a link with its target text, or nothing; and `directory`, the real directory holding that
 * entry. Epic 60 records this before every write so a rollback can put back exactly what was
 * there, a link as a link, and so a plan stops being valid when a link on the way to the file
 * starts pointing somewhere else (R60-NFR2).
 */
export function pathState(path) {
  const directory = holdingDirectory(path)
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (error.code === 'ENOENT') return { kind: 'missing', directory }
    throw error
  }
  if (stat.isSymbolicLink()) return { kind: 'link', target: readlinkSync(path), directory }
  if (!stat.isFile()) throw new ConfigWriteError('NOT_A_FILE', `${path} is not a regular file or a symbolic link`)
  return { kind: 'file', text: readFileSync(path, 'utf8'), mode: stat.mode & 0o777, directory }
}

/** Whether two states of one path are the same entry in the same real directory. */
export function sameState(a, b) {
  return a.kind === b.kind && a.target === b.target && a.text === b.text && a.directory === b.directory
}

/** Where a write to `path` would really land, given its state: the path with every link before its last part followed. */
export function resolvedPath(path, state) {
  return join(state.directory, basename(path))
}

/**
 * Epic 60's write for files outside BMN (R60-NFR2): the caller has shown the diff and had it
 * approved; this refuses when the path no longer holds `expected` (a pathState), stages the new
 * bytes beside the path, checks again with them staged, then renames over the path. A rename
 * replaces a symbolic link's own entry and never writes through it to the file it points at,
 * unlike `writeAtomically`. The result is read back. `beforeCommit` is a test seam between checks.
 */
export function replaceFileSafely(path, expected, nextText, { beforeCommit, mode = 0o600 } = {}) {
  const unchanged = () => {
    const now = pathState(path)
    if (!sameState(now, expected)) {
      throw new ConfigWriteError('REVISION_CONFLICT', `${path} changed while BMN was reading it; nothing was written`)
    }
  }
  unchanged()
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${basename(path)}.bmn-${process.pid}-${Date.now()}.tmp`)
  try {
    writeFileSync(temporary, nextText, { mode: expected.kind === 'file' ? expected.mode : mode, flag: 'wx' })
    if (expected.kind === 'file') chmodSync(temporary, expected.mode)
    beforeCommit?.()
    unchanged()
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Already renamed into place, or never created.
    }
    throw error
  }
  const after = pathState(path)
  if (after.kind !== 'file' || after.text !== nextText) {
    throw new ConfigWriteError('READBACK_FAILED', `${path} does not hold what BMN wrote; check it by hand`)
  }
  return after
}

/** Puts a recorded pathState back: a file's bytes, a link as a link, or removes what was missing. */
export function restorePathState(path, state) {
  const directory = dirname(path)
  if (state.kind === 'missing') {
    try {
      unlinkSync(path)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    return
  }
  mkdirSync(directory, { recursive: true })
  const temporary = join(directory, `.${basename(path)}.bmn-${process.pid}-${Date.now()}.tmp`)
  try {
    if (state.kind === 'link') symlinkSync(state.target, temporary)
    else writeFileSync(temporary, state.text, { mode: state.mode ?? 0o600, flag: 'wx' })
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // Never created.
    }
    throw error
  }
}
