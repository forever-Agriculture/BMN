// MODULE: browser-keyring.mjs - Secret Service access without prompts, secret argv/environment or a clear-text fallback.
import { spawn, spawnSync } from 'node:child_process'
import { browserLaunchHelper, processIdentity } from './browser-process.mjs'

// Gio is provided by Ubuntu's python3-gi. Values travel over private pipes and D-Bus, never process arguments.
const CLIENT = String.raw`
import sys,json
from gi.repository import Gio,GLib
try:
 r=json.load(sys.stdin)
 b=Gio.bus_get_sync(Gio.BusType.SESSION,None)
 def call(path,iface,method,args=None):
  return b.call_sync('org.freedesktop.secrets',path,iface,method,args,None,Gio.DBusCallFlags.NONE,5000,None).unpack()
 def locked(path):
  return call(path,'org.freedesktop.DBus.Properties','Get',GLib.Variant('(ss)',('org.freedesktop.Secret.Collection','Locked')))[0]
 root='/org/freedesktop/secrets';service='org.freedesktop.Secret.Service'
 collection=call(root,service,'ReadAlias',GLib.Variant('(s)',('default',)))[0]
 if collection=='/' or locked(collection):raise Exception('locked')
 attrs={'application':'bmn-browser','account':r['account'],'kind':r['kind']}
 unlocked,locked_items=call(root,service,'SearchItems',GLib.Variant('(a{ss})',(attrs,)))
 if locked_items:raise Exception('locked')
 if r['op']=='delete':
  for p in unlocked:
   if call(p,'org.freedesktop.Secret.Item','Delete')[0]!='/':raise Exception('prompt')
  result=None
 else:
  session=call(root,service,'OpenSession',GLib.Variant('(sv)',('plain',GLib.Variant('s',''))))[1]
  try:
   if r['op']=='get':
    result=None if not unlocked else json.loads(bytes(call(unlocked[0],'org.freedesktop.Secret.Item','GetSecret',GLib.Variant('(o)',(session,)))[0][2]).decode())
   elif r['op']=='set':
    props={'org.freedesktop.Secret.Item.Label':GLib.Variant('s','BMN browser account'),'org.freedesktop.Secret.Item.Attributes':GLib.Variant('a{ss}',attrs)}
    secret=(session,[],list(json.dumps(r['value']).encode()),'application/json')
    item,prompt=call(collection,'org.freedesktop.Secret.Collection','CreateItem',GLib.Variant('(a{sv}(oayays)b)',(props,secret,True)))
    if prompt!='/':raise Exception('prompt')
    result=True
   else:raise Exception('operation')
  finally:call(session,'org.freedesktop.Secret.Session','Close')
 print(json.dumps({'ok':True,'value':result}))
except Exception:
 print(json.dumps({'ok':False,'code':'KEYRING_LOCKED'}))
`

export class BrowserAccountError extends Error {
  constructor(code, message) { super(message); this.code = code }
}
export const keyringLocked = () => new BrowserAccountError('KEYRING_LOCKED', 'Keyring locked. Unlock your system keyring and try again.')
export function keyringCall(op, account, kind, value, { environment = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/python3', ['-c', CLIENT], { env: environment, stdio: ['pipe', 'pipe', 'ignore'] })
    const identity = child.pid ? processIdentity(child.pid) : null
    let output = ''
    const timer = setTimeout(() => {
      if (identity?.ticks) spawnSync('/usr/bin/python3', [browserLaunchHelper(), '--terminate'], {
        env: environment, input: JSON.stringify({ owner: processIdentity(), child: identity }), stdio: ['pipe', 'ignore', 'ignore']
      })
      reject(keyringLocked())
    }, 15_000)
    child.on('error', () => { clearTimeout(timer); reject(keyringLocked()) })
    child.stdout.on('data', chunk => { if (output.length < 1024 * 1024) output += chunk })
    child.stdin.on('error', () => {})
    child.on('close', code => {
      clearTimeout(timer)
      try { const result = JSON.parse(output); if (code !== 0 || !result.ok) throw keyringLocked(); resolve(result.value) }
      catch { reject(keyringLocked()) }
    })
    child.stdin.end(JSON.stringify({ op, account, kind, ...(value === undefined ? {} : { value }) }))
  })
}
