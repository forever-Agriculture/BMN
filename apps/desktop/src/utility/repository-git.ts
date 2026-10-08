import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { maskSecrets } from './secret-mask'

const execute = promisify(execFile)

/** No inherited Git overrides, shell, optional locks or unbounded output. */
export async function repositoryGit(directory: string, argv: string[], maxBuffer = 256 * 1024): Promise<string> {
  const result = await execute('git', ['-C', directory, ...argv], {
    timeout: 2_000, maxBuffer, encoding: 'utf8', windowsHide: true,
    env: {
      PATH: process.env.PATH, HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
      LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0'
    }
  })
  return result.stdout
}

export function repositoryGitError(error: unknown): string {
  const failure = error as { code?: string | number; killed?: boolean; signal?: string; stderr?: string }
  if (failure.code === 'ENOENT') return 'Git is not installed'
  if (failure.killed || failure.signal === 'SIGTERM' || failure.code === 'ETIMEDOUT') return 'Git inspection timed out'
  if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'Git output exceeded the read bound'
  // eslint-disable-next-line no-control-regex -- remove terminal controls from locally supplied text
  const detail = failure.stderr?.trim().split('\n')[0]?.replace(/[\x00-\x1f\x7f]/gu, ' ')
  return detail ? `Git failed: ${maskSecrets(detail).slice(0, 400)}` : error instanceof Error ? maskSecrets(error.message).slice(0, 400) : 'Git inspection failed'
}
