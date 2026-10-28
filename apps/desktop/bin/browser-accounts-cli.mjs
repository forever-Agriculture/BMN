// MODULE: browser-accounts-cli.mjs - Explicit owner commands for saved browser accounts; passwords never enter argv.
import { createInterface } from 'node:readline/promises'
import { stdin, stdout } from 'node:process'
import { BrowserAccountsStore } from './browser-accounts-store.mjs'
import { AccountSignIn } from './browser-accounts-engine.mjs'

export async function hiddenInput(label) {
  if (!stdin.isTTY) throw new Error('Marking an account requires a terminal with hidden input.')
  stdout.write(label); stdin.setRawMode(true); stdin.resume()
  try {
    return await new Promise((ok, no) => {
      let value = ''
      const onData = chunk => {
        for (const char of chunk.toString()) {
          if (char === '\r' || char === '\n') { stdin.off('data', onData); ok(value); return }
          if (char === '\u0003' || char === '\u0004') { stdin.off('data', onData); no(new Error('Cancelled')); return }
          if (char === '\u007f') value = value.slice(0, -1)
          else if (char >= ' ') value += char
        }
      }
      stdin.on('data', onData)
    })
  } finally { stdin.setRawMode(false); stdin.pause(); stdout.write('\n') }
}
export async function runBrowserCommand(argv) {
  if (argv[0] === 'server') {
    // This entry is emitted per app by Tools; run-owned tools always use anonymous Playwright instead.
    const { runAccountBrowser } = await import('./browser-account-relay.mjs')
    return runAccountBrowser(argv[1])
  }
  const [part, command, name, ...rest] = argv
  if (part !== 'accounts' || !['list', 'add', 'sign-in', 'remove', 'mark', 'unmark'].includes(command)) {
    stdout.write('Usage: bmn browser accounts list|add NAME --url URL|sign-in NAME|remove NAME|mark NAME|unmark NAME\n'); return 2
  }
  const store = new BrowserAccountsStore()
  try {
    if (command === 'list') { stdout.write(JSON.stringify(store.list(), null, 2) + '\n'); return 0 }
    if (!name) throw new Error('Name an account.')
    if (command === 'remove') { await store.remove(store.find(name)); return 0 }
    if (command === 'unmark') { await store.unmark(store.find(name)); return 0 }
    if (command === 'mark') {
      const id = store.find(name), meta = store.metadata(id)
      stdout.write(`Sign-in origins: ${meta.signInOrigins.join(', ')}\n`)
      const username = await hiddenInput('User name: '), password = await hiddenInput('Password: '), authenticator = await hiddenInput('Authenticator key (optional): ')
      await store.mark(id, { username, password, ...(authenticator ? { authenticator } : {}) }); return 0
    }
    const signIn = new AccountSignIn(store)
    const urlAt = rest.indexOf('--url')
    if (command === 'add' && (urlAt < 0 || !rest[urlAt + 1])) throw new Error('Give the start page with --url URL.')
    const row = await signIn.begin(command === 'add' ? { name, url: rest[urlAt + 1] } : { id: store.find(name) })
    stdout.write('Finish signing in the window. Press Enter when done, or type cancel.\n')
    const reader = createInterface({ input: stdin, output: stdout })
    try {
      const answer = await reader.question('')
      if (signIn.sessions.has(row.id)) await signIn.finish(row.id, answer.trim().toLowerCase() === 'cancel')
      stdout.write(JSON.stringify(store.list().find(r => r.id === row.id) || { cancelled: true }) + '\n')
    } finally { reader.close(); await signIn.close() }
    return 0
  } catch (error) { process.stderr.write(`${error.code || 'BROWSER_ERROR'}: ${error.code ? error.message : 'Browser account action failed. Check the start page, account name and system keyring.'}\n`); return 1 }
}
