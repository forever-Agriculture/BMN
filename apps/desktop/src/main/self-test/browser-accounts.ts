// MODULE: browser-accounts.ts - Disposable-test hands target the production controller's exact sign-in Page.
import { realpathSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { AccountSignIn } from '../../../bin/browser-accounts-engine.mjs'

interface Hands {
  id: string
  username: string
  password: string
  code: string
}

export function attachBrowserAccountHands(events: NodeJS.EventEmitter, controller: AccountSignIn, environment: NodeJS.ProcessEnv): void {
  const root = environment.BMN_BROWSER_ACCOUNTS_TEST_ROOT
  const origin = environment.BMN_BROWSER_ACCOUNTS_TEST_ORIGIN
  if (!root || !origin) return
  const runtime = environment.XDG_RUNTIME_DIR
  const address = new URL(origin)
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || !address.port || address.origin !== origin
    || realpathSync(root) !== resolve(root) || !root.includes('/.dev-auto/evidence/')
    || environment.HOME !== join(root, 'home') || environment.BMN_DATA_HOME !== join(root, 'data')
    || environment.BMN_CONFIG_HOME !== join(root, 'home/config/bmn')
    || environment.BMN_STATE_HOME !== join(root, 'home/state/bmn')
    || !runtime?.startsWith(`/run/user/${process.getuid?.()}/b97-`)
    || realpathSync(runtime) !== runtime || statSync(runtime).uid !== process.getuid?.() || (statSync(runtime).mode & 0o077))
    throw new Error('Browser account hands require disposable roots and a loopback fixture.')
  events.on('bmn-test:browser-account-hands', (input: Hands, respond: (result: unknown) => void) => {
    const deadline = Date.now() + 25_000
    let settled = false
    const finish = (result: unknown): void => {
      if (settled) return
      settled = true; clearTimeout(timer); respond(result)
    }
    const timer = setTimeout(() => finish({ ok: false, code: 'HANDS_TIMEOUT' }), 25_000)
    const remaining = (): number => {
      if (settled || Date.now() >= deadline) throw new Error('Test hands deadline expired.')
      return Math.max(1, deadline - Date.now())
    }
    void (async () => {
      // New-account opens use a Symbol until the account receives its id.
      await Promise.all(controller.pending.values())
      remaining()
      const session = controller.sessions.get(input.id)
      if (!session || session.page.isClosed()) return { ok: false, code: 'NO_SESSION' }
      const page = session.page
      if (new URL(page.url()).origin !== origin) throw new Error('Unexpected sign-in origin.')
      const beforeFields = await page.locator('input[type=password]').count()
      if (beforeFields !== 1) throw new Error('Expected one logged-out sign-in page.')
      await page.locator('[name=user]').fill(input.username, { timeout: remaining() })
      await page.locator('[name=password]').fill(input.password, { timeout: remaining() })
      await page.locator('[name=code]').fill(input.code, { timeout: remaining() })
      await page.getByRole('button', { name: 'Sign in', exact: true }).click({ timeout: remaining() })
      await page.waitForURL(`${origin}/same/app`, { timeout: remaining() })
      await page.getByRole('heading', { name: 'Signed in', exact: true }).waitFor({ timeout: remaining() })
      remaining()
      if (controller.sessions.get(input.id) !== session) throw new Error('Sign-in page ownership changed.')
      const afterFields = await page.locator('input[type=password]').count()
      if (afterFields !== 0) throw new Error('Sign-in did not complete.')
      return { ok: true, beforeFields, afterFields, path: new URL(page.url()).pathname }
    })().then(finish, () => finish({ ok: false, code: 'HANDS_FAILED' }))
  })
}
