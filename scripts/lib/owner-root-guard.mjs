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

/**
 * Fails when a run added, removed or modified anything under the owner's real roots.
 * `runFolders` names folders whose children each belong to one piece of other sessions' work: a team ask run, or the
 * kept versions of one plan board. A child already there before the check began belongs to work some other session
 * started; that session keeps writing inside it meanwhile, so those writes are not the run's. A leak would start a new
 * child, which still fails (updates of 2026-11-07, a Q-Automations ask, and 2026-11-17, a B2Buster plan board).
 */
export function assertOwnerRootsUnchanged(before, after, phase, { runFolders = [] } = {}) {
  // The owner's roots hold hundreds of thousands of entries; Sets keep the comparison linear.
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  const earlierRuns = before.map((entry) => entry.split('\t')).filter(([path, kind]) =>
    kind === 'dir' && runFolders.some((folder) => path.startsWith(`${folder}/`) && !path.slice(folder.length + 1).includes('/'))
  ).map(([path]) => path)
  const outsideRun = (path) => earlierRuns.some((run) => path === run || path.startsWith(`${run}/`))
  const changed = [
    ...before.filter((entry) => !afterSet.has(entry)),
    ...after.filter((entry) => !beforeSet.has(entry))
  ].map((entry) => entry.split('\t')[0]).filter((path) => !outsideRun(path))
  if (changed.length > 0) {
    throw new Error(`real XDG roots changed ${phase}; changed: ${[...new Set(changed)].slice(0, 10).join(', ')}`)
  }
}
