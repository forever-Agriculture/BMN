export function assertOwnerRootsAbsent(ownerRoots, phase, exists) {
  const present = ownerRoots.filter((path) => exists(path))
  if (present.length > 0) {
    throw new Error(`real XDG roots must be absent ${phase}; found: ${present.join(', ')}`)
  }
}

/** Lists every file, symlink and directory under the real roots without following links. */
export function fingerprintOwnerRoots(ownerRoots, { existsSync, lstatSync, readdirSync }) {
  const entries = []
  const visit = (path) => {
    const stats = lstatSync(path)
    entries.push(`${path}\t${stats.isDirectory() ? 'dir' : stats.size}\t${stats.mtimeMs}`)
    if (stats.isDirectory()) for (const name of readdirSync(path).sort()) visit(`${path}/${name}`)
  }
  for (const root of ownerRoots) if (existsSync(root)) visit(root)
  return entries
}

/** Fails when a run added, removed or modified anything under the owner's real roots. */
export function assertOwnerRootsUnchanged(before, after, phase) {
  // The owner's roots hold hundreds of thousands of entries; Sets keep the comparison linear.
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  const changed = [
    ...before.filter((entry) => !afterSet.has(entry)),
    ...after.filter((entry) => !beforeSet.has(entry))
  ].map((entry) => entry.split('\t')[0])
  if (changed.length > 0) {
    throw new Error(`real XDG roots changed ${phase}; changed: ${[...new Set(changed)].slice(0, 10).join(', ')}`)
  }
}
