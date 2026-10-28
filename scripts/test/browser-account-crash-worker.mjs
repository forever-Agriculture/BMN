// MODULE: browser-account-crash-worker.mjs - Disposable process for actual SIGKILL publication and RAM-secret recovery checks.
import { createInterface } from 'node:readline'
import { existsSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { BrowserAccountsStore } from '../../apps/desktop/bin/browser-accounts-store.mjs'
import { AccountBrowserRelay } from '../../apps/desktop/bin/browser-account-relay.mjs'

const reader = createInterface({ input: process.stdin })
const input = await new Promise(ok => reader.once('line', line => ok(JSON.parse(line))))
const store = new BrowserAccountsStore()
const keepAlive = setInterval(() => {}, 1000)
if (input.step === 'relay') {
  const relay = new AccountBrowserRelay({ store, allowed: true })
  const picked = await relay.tool('browser_account_pick', { name: input.id })
  if (picked.isError) throw new Error('Crash relay account pick failed')
  const typed = await relay.tool('browser_type', { target: '[name=password]', text: 'BMN_PASSWORD' })
  if (typed.isError) throw new Error('Crash relay secret entry failed')
  process.stdout.write(JSON.stringify({ checkpoint: 'relay', folder: relay.lease.folder }) + '\n')
} else {
  const lease = await store.checkout(input.id, { checkpoint: async (step, lease) => {
    if (step !== input.step) return
    process.stdout.write(JSON.stringify({ checkpoint: step, folder: lease.folder,
      claimed: existsSync(join(dirname(lease.folder), '.claims', basename(lease.folder) + '.json')) }) + '\n')
    await new Promise(ok => reader.once('line', ok))
  } })
  writeFileSync(join(lease.profile, 'publication-proof'), input.proof, { mode: 0o600 })
  await store.publish(lease, { state: 'Signed in' }, { checkpoint: async step => {
    if (step !== input.step) return
    process.stdout.write(JSON.stringify({ checkpoint: step, folder: lease.folder }) + '\n')
    await new Promise(ok => reader.once('line', ok))
  } })
  store.discard(lease)
  process.stdout.write('{"checkpoint":"complete"}\n')
  clearInterval(keepAlive); reader.close()
}
