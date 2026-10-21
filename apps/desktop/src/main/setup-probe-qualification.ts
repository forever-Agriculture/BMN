// MODULE: setup-probe-qualification.ts - Disposable synthetic-secret, hook and MCP probe qualification
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SetupApp } from '@bmn/protocol'
import { disposableSetupEnvironment, projectSetupSignIn, setupProbeArguments } from './setup-readiness'
import { runSetupProcess } from './setup-process'

const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`
const json = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value), { mode: 0o600 })
const jwt = (value: unknown): string => `${Buffer.from('{"alg":"RS256","typ":"JWT"}').toString('base64url')}.${Buffer.from(JSON.stringify(value)).toString('base64url')}.SYNTHsig${randomBytes(12).toString('hex')}`

/** Only synthetic profiles are seeded. Real credentials are never opened by this module. */
export async function qualifySetupProbe(
  app: SetupApp, program: string, source: NodeJS.ProcessEnv, run: typeof runSetupProcess = runSetupProcess
): Promise<boolean> {
  const root = mkdtempSync(join(tmpdir(), 'bmn-setup-qualify-'))
  const marker = join(root, 'started')
  const secrets = Array.from({ length: 5 }, (_, i) => `sk-${i === 0 ? 'ant-api03' : 'proj'}-SYNTH${randomBytes(24).toString('hex')}`)
  const leaking = (text: string): boolean => secrets.some(secret => {
    const body = secret.split('SYNTH')[1]!
    return [secret, body.slice(0, 8), body.slice(-8)].some(needle => text.includes(needle))
  })
  const options = (env: NodeJS.ProcessEnv, folder: string) => ({ env, cwd: join(folder, 'work') })
  const clean = (): void => { rmSync(marker, { force: true }) }
  try {
    const empty = join(root, 'empty'), seeded = join(root, 'seeded')
    const emptyEnv = disposableSetupEnvironment(empty, source.PATH)
    const env = disposableSetupEnvironment(seeded, source.PATH)
    const script = join(root, 'mcp.cjs')
    writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)},'started');setTimeout(()=>{},20000)\n`)
    const hook = `${quote(process.execPath)} ${quote(script)}`
    const node = process.execPath
    if (app === 'claude') {
      mkdirSync(join(env.HOME!, '.claude'), { recursive: true })
      json(join(env.HOME!, '.claude/.credentials.json'), { claudeAiOauth: { accessToken: secrets[1], refreshToken: secrets[2],
        expiresAt: 4102444800000, scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'], subscriptionType: 'max' } })
      json(join(env.HOME!, '.claude.json'), { hasCompletedOnboarding: true, primaryApiKey: secrets[0],
        oauthAccount: { emailAddress: 'synthetic@example.invalid', accountUuid: '00000000-0000-4000-8000-000000000001', organizationUuid: '00000000-0000-4000-8000-000000000002' },
        mcpServers: { bmn_setup_probe: { type: 'stdio', command: node, args: [script] } } })
      json(join(env.HOME!, '.claude/settings.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook, timeout: 5 }] }] } })
    } else if (app === 'codex') {
      mkdirSync(join(env.HOME!, '.codex'), { recursive: true })
      const idToken = jwt({ email: 'synthetic@example.invalid', exp: 4102444800, 'https://api.openai.com/auth': {
        chatgpt_plan_type: 'pro', chatgpt_account_id: '00000000-0000-4000-8000-000000000001', chatgpt_user_id: 'user-synthetic' } })
      const accessToken = jwt({ exp: 4102444800, scp: ['openid'], SYNTH: randomBytes(16).toString('hex') })
      secrets.push(idToken, accessToken)
      json(join(env.HOME!, '.codex/auth.json'), { auth_mode: 'chatgpt', OPENAI_API_KEY: secrets[0],
        tokens: { id_token: idToken, access_token: accessToken, refresh_token: secrets[2], account_id: '00000000-0000-4000-8000-000000000001' },
        last_refresh: '2026-10-20T00:00:00Z' })
      writeFileSync(join(env.HOME!, '.codex/config.toml'), `[mcp_servers.bmn_setup_probe]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(script)}]\n`)
      json(join(env.HOME!, '.codex/hooks.json'), { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: hook, timeout: 5 }] }] } })
    } else {
      mkdirSync(join(env.XDG_DATA_HOME!, 'opencode'), { recursive: true })
      mkdirSync(join(env.XDG_CONFIG_HOME!, 'opencode/plugins'), { recursive: true })
      json(join(env.XDG_DATA_HOME!, 'opencode/auth.json'), { anthropic: { type: 'api', key: secrets[0] },
        openai: { type: 'oauth', access: secrets[1], refresh: secrets[2], expires: 4102444800000 } })
      json(join(env.XDG_CONFIG_HOME!, 'opencode/opencode.json'), { mcp: { servers: {
        bmn_setup_probe: { type: 'local', command: [node, script] }
      } } })
      writeFileSync(join(env.XDG_CONFIG_HOME!, 'opencode/plugins/bmnfake.js'),
        `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'plugin');export default async()=>({});\n`)
    }
    // Positive leak control: every seeded token and a substantial fragment must be detectable.
    if (!secrets.every(secret => leaking(secret))) return false
    const test = async (profile: string, environment: NodeJS.ProcessEnv, ready: boolean): Promise<boolean> => {
      clean()
      let used = environment, scratch: string | undefined
      if (app === 'opencode') {
        scratch = mkdtempSync(join(root, 'isolated-'))
        used = disposableSetupEnvironment(scratch, source.PATH)
        used.XDG_DATA_HOME = environment.XDG_DATA_HOME
      }
      try {
        const result = await run(program, setupProbeArguments(app), options(used, scratch ?? profile))
        return result.failure === null && !existsSync(marker) && !leaking(result.output) &&
          projectSetupSignIn(app, result).signIn === (ready ? 'ready' : 'signed-out')
      } finally { if (scratch) rmSync(scratch, { recursive: true, force: true }) }
    }
    if (!await test(empty, emptyEnv, false) || !await test(seeded, env, true)) return false
    // The environment-only form is checked for apps whose cleared probe may observe it.
    if (app !== 'opencode' && !await test(seeded, { ...env, ANTHROPIC_API_KEY: secrets[0], OPENAI_API_KEY: secrets[3], CLAUDE_CODE_OAUTH_TOKEN: secrets[4] }, true)) return false
    if (app === 'codex') {
      json(join(env.HOME!, '.codex/auth.json'), { auth_mode: 'apikey', OPENAI_API_KEY: secrets[3] })
      if (!await test(seeded, env, true)) return false
    }
    // The fake server/plugin must actually be reachable, so a missing marker above proves something.
    clean()
    const control = app === 'codex' ? ['exec', '--skip-git-repo-check', 'say ok'] : ['mcp', 'list']
    await run(program, control, options({ ...env, ANTHROPIC_API_KEY: secrets[0], OPENAI_API_KEY: secrets[3] }, seeded))
    return existsSync(marker) && readdirSync(root).length > 0
  } catch { return false }
  finally { rmSync(root, { recursive: true, force: true }) }
}
