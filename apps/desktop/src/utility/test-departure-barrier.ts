// MODULE: test-departure-barrier.ts - hold one synthetic departure screen read after its claim, before the unchanged final proof
import { randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

export function testDepartureBarrier(argv: readonly string[], env: NodeJS.ProcessEnv, stateRoot: string):
  ((sessionId: string, incarnationId: string) => Promise<void>) | undefined {
  if (!argv.includes('--bmn-test-host') || env.BMN_TEST_DEPARTURE_BARRIER !== '1' || !isAbsolute(stateRoot)) return undefined
  const directory = join(stateRoot, 'departure-proof-test')
  let used = false
  return async (sessionId, incarnationId) => {
    if (used) return
    used = true
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) throw new Error('Departure test barrier is not private')
    const token = randomUUID()
    const held = { sessionId, incarnationId, token, pid: process.pid, at: new Date().toISOString() }
    const temporary = join(directory, token + '.tmp')
    await writeFile(temporary, JSON.stringify(held) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, join(directory, 'held.json'))
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      try {
        const release = join(directory, 'release')
        const file = await lstat(release)
        if (!file.isFile() || file.isSymbolicLink() || file.size > 80) throw new Error('Invalid departure test release')
        if ((await readFile(release, 'utf8')).trim() === token) {
          await writeFile(join(directory, 'released.json'), JSON.stringify({ ...held, at: new Date().toISOString() }) + '\n', { mode: 0o600 })
          return
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('Departure test barrier timed out; idle proof refused')
  }
}
