// MODULE: foreground-process.test.ts - the foreground process's identity and folder against made-up /proc rows
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { foregroundProcessFolder, foregroundProcessIdentity } from './foreground-process'

const fs = vi.hoisted(() => ({ readFileSync: vi.fn(), readlinkSync: vi.fn(), statSync: vi.fn() }))
vi.mock('node:fs', () => fs)

function stat(pid: number, group: number, foreground: number, start: string, tty = 34817, state = 'S') {
  const fields = Array<string>(20).fill('0')
  fields[0] = state; fields[1] = '1'; fields[2] = String(group)
  fields[3] = '100'; fields[4] = String(tty); fields[5] = String(foreground); fields[19] = start
  return `${pid} (name with ) parentheses) ${fields.join(' ')}`
}

describe.skipIf(process.platform !== 'linux')('host foreground process identity', () => {
  let rows: Map<string, string>
  beforeEach(() => {
    rows = new Map([['/proc/100/stat', stat(100, 100, 200, '10')], ['/proc/200/stat', stat(200, 200, 200, '20')]])
    fs.readFileSync.mockReset().mockImplementation(path => {
      if (!rows.has(path)) throw new Error('unreadable')
      return rows.get(path)
    })
    fs.statSync.mockReset().mockReturnValue({ dev: 1n, ino: 2n })
  })

  it('distinguishes PID reuse and executable replacement, including names with parentheses', () => {
    const first = foregroundProcessIdentity(100)
    expect(first).toBe('34817:200:20:1:2')
    rows.set('/proc/200/stat', stat(200, 200, 200, '21'))
    expect(foregroundProcessIdentity(100)).not.toBe(first)
    rows.set('/proc/200/stat', stat(200, 200, 200, '20'))
    fs.statSync.mockReturnValue({ dev: 1n, ino: 3n })
    expect(foregroundProcessIdentity(100)).not.toBe(first)
  })

  it.each(['unreadable', 'stopped', 'different-tty', 'different-group', 'no-tty', 'shell'])('refuses %s process evidence', kind => {
    if (kind === 'unreadable') rows.delete('/proc/200/stat')
    if (kind === 'stopped') rows.set('/proc/200/stat', stat(200, 200, 200, '20', 34817, 'T'))
    if (kind === 'different-tty') rows.set('/proc/200/stat', stat(200, 200, 200, '20', 34818))
    if (kind === 'different-group') rows.set('/proc/200/stat', stat(200, 201, 200, '20'))
    if (kind === 'no-tty') rows.set('/proc/100/stat', stat(100, 100, 200, '10', 0))
    if (kind === 'shell') rows.set('/proc/200/stat', stat(200, 200, 200, '20').replace('(name with ) parentheses)', '(bash)'))
    expect(foregroundProcessIdentity(100)).toBeNull()
  })

  it('reads the folder of the process an identity names, and none once that process is another or gone', () => {
    fs.readlinkSync.mockReset().mockImplementation(path => {
      if (path !== '/proc/200/cwd') throw new Error('unreadable')
      return '/made/up/folder'
    })
    const identity = foregroundProcessIdentity(100) as string
    expect(foregroundProcessFolder(identity)).toBe('/made/up/folder')
    // The process id was given to another process: its start time differs.
    rows.set('/proc/200/stat', stat(200, 200, 200, '21'))
    expect(foregroundProcessFolder(identity)).toBeNull()
    rows.delete('/proc/200/stat')
    expect(foregroundProcessFolder(identity)).toBeNull()
    expect(foregroundProcessFolder('34817:0:20:1:2')).toBeNull()
    expect(foregroundProcessFolder('not an identity')).toBeNull()
  })

  it('refuses a foreground switch during its synchronous snapshot', () => {
    fs.statSync.mockImplementation(() => {
      rows.set('/proc/100/stat', stat(100, 100, 100, '10'))
      return { dev: 1n, ino: 2n }
    })
    expect(foregroundProcessIdentity(100)).toBeNull()
  })
})
