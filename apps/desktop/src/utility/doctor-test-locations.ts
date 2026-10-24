// MODULE: doctor-test-locations.ts - Independent manual use of the compact public coordinates, after private verification
import { lstatSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { DoctorLocator } from '../../../../shared/protocol/src/doctor'

/** Test the owner's manual lookup separately from the scanner that produced the coordinates. */
export function manualLocation(value: DoctorLocator | undefined, roots: Record<string, string>): string | null {
  if (value?.status !== 'located' || value.acquisition !== 4) return null
  const same = (path: string, wanted: { device: string; inode: string }, follow = false): boolean => {
    const stat = (follow ? statSync : lstatSync)(path, { bigint: true })
    return String(stat.dev) === wanted.device && String(stat.ino) === wanted.inode
  }
  const child = (folder: string, wanted: { device: string; inode: string }): string | null => {
    const matches = readdirSync(folder).map(name => join(folder, name)).filter(path => same(path, wanted))
    return matches.length === 1 ? matches[0]! : null
  }
  try {
    let folder = roots[value.root]
    if (!folder) return null
    if (value.route === undefined && same(folder, value.object) && same(dirname(folder), value.parent, true)) return folder
    for (const step of value.route ?? []) { const next = child(folder, step); if (!next) return null; folder = next }
    if (!same(folder, value.parent, true)) return null
    return child(folder, value.object)
  } catch { return null }
}
