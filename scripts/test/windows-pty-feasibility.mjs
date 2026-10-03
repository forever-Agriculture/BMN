// Story 53.2 feasibility: observe real ConPTY bytes before selecting a native route.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
assert.equal(process.platform, 'win32')
const requireApp = createRequire(join(repo, 'apps/desktop/package.json'))
const root = mkdtempSync(join(tmpdir(), 'bmn-conpty-spike-'))
try {
  const worker = join(root, 'host.cjs')
  const fixture = join(root, 'terminal.cjs')
  const sequences = {
    sixel: '\x1bPq"1;1;1;1#0;2;100;0;0#0~\x1b\\',
    osc52: '\x1b]52;c;c3ludGhldGlj\x07',
    osc9: '\x1b]9;synthetic\x07',
    osc777: '\x1b]777;notify;BMN;synthetic\x07',
    osc99: '\x1b]99;i=synthetic;fixture\x07',
    mouse: '\x1b[?1000h\x1b[?1006h',
    bracketedPaste: '\x1b[?2004h'
  }
  const input = '\x1b[<0;4;5M\x1b[<0;4;5m\x1b[200~synthetic paste\x1b[201~'
  writeFileSync(fixture, `const fs=require('node:fs'); const trace=${JSON.stringify(join(root, 'child-trace.json'))};
process.on('uncaughtException',error=>{fs.writeFileSync(trace,JSON.stringify({stage:'error',name:error.name,code:error.code,message:error.message}));process.exit(1)});
process.on('exit',code=>{if(!fs.existsSync(trace))fs.writeFileSync(trace,JSON.stringify({stage:'exit',code}))});
fs.writeFileSync(trace,JSON.stringify({stage:'entered',stdinTTY:process.stdin.isTTY,stdoutTTY:process.stdout.isTTY}));
const sequences=${JSON.stringify(sequences)};
process.stdin.setRawMode(true); process.stdin.resume();
process.stdout.on('resize',()=>process.stdout.write('BMN_RESIZE:'+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n'));
process.stdin.on('data',data=>{ process.stdout.write('BMN_INPUT_HEX:'+data.toString('hex')+'\\r\\n'); if(data.includes(3)){process.stdout.write('BMN_CTRL_C\\r\\n');process.exit(0);} });
for(const value of Object.values(sequences)) process.stdout.write(value);
process.stdout.write('\\x1b[2J\\x1b[HBMN_REPAINT\\r\\nBMN_READY\\r\\n');
setTimeout(()=>process.exit(2),15000);\n`)
  writeFileSync(worker, `const fs=require('node:fs'); const {createRequire}=require('node:module');
const pty=createRequire(${JSON.stringify(join(repo, 'apps/desktop/package.json'))})('node-pty');
if(!/^windows-filetime:[0-9]+$/.test(pty.queryProcessStartIdentity(process.pid)))throw new Error('Patched native ownership capability unavailable');
const [node,fixture,resultPath]=process.argv.slice(2);
const sequences=${JSON.stringify(sequences)}, input=${JSON.stringify(input)};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function run(useConptyDll){
 let output='',exit;const started=Date.now();
 const terminal=pty.spawn(node,[fixture],{name:'xterm-256color',cols:80,rows:24,cwd:${JSON.stringify(root)},env:{...process.env},useConpty:true,useConptyDll});
 terminal.onData(data=>{output+=data});terminal.onExit(value=>{exit=value});
 const waitFor=async(predicate,limit=5000)=>{const end=Date.now()+limit;while(!predicate()&&Date.now()<end&&!exit)await sleep(25);return predicate()};
 try{
  await waitFor(()=>output.includes('BMN_READY'));
  terminal.resize(101,37); terminal.write(input);
  await waitFor(()=>output.includes('BMN_INPUT_HEX:'));
  terminal.write('\\x03'); await waitFor(()=>exit!==undefined);
  return {route:useConptyDll?'bundled':'built-in',outputBase64:Buffer.from(output).toString('base64'),features:Object.fromEntries(Object.entries(sequences).map(([k,v])=>[k,output.includes(v)])),ready:output.includes('BMN_READY'),repaint:output.includes('BMN_REPAINT'),resize:output.includes('BMN_RESIZE:101x37'),inputHex:[...output.matchAll(/BMN_INPUT_HEX:([0-9a-f]+)/g)].map(m=>m[1]).join(''),expectedInputHex:Buffer.from(input).toString('hex'),ctrlC:output.includes('BMN_CTRL_C'),exit,elapsedMs:Date.now()-started};
 }finally{if(!exit){terminal.kill();await waitFor(()=>exit!==undefined,3000)}}
}
(async()=>{const results=[];for(const mode of [true]){try{results.push(await run(mode))}catch(error){results.push({route:mode?'bundled':'built-in',error:String(error)})}}
fs.writeFileSync(resultPath,JSON.stringify({platform:process.platform,versions:process.versions,os:require('node:os').version(),results},null,2));process.exit(0)})().catch(error=>{console.error(error);process.exit(1)});\n`)
  const receiptPath = join(root, 'result.json')
  const child = spawn(requireApp('electron'), [worker, process.execPath, fixture, receiptPath], {
    cwd: repo, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('ConPTY spike host timed out')) }, 60000)
    child.once('error', error => { clearTimeout(timer); reject(error) })
    child.once('exit', code => { clearTimeout(timer); resolve(code) })
  })
  assert.equal(code, 0, stderr)
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  receipt.hostStderr = stderr
  try { receipt.childTrace = JSON.parse(readFileSync(join(root, 'child-trace.json'), 'utf8')) } catch { receipt.childTrace = null }
  receipt.fullFeatureRoutes = receipt.results.filter(result => result.features && Object.values(result.features).every(Boolean) && result.ready && result.repaint && result.resize && result.ctrlC && result.exit?.exitCode === 0 && result.inputHex === result.expectedInputHex + '03').map(result => result.route)
  mkdirSync(join(repo, 'test-results'), { recursive: true })
  writeFileSync(join(repo, 'test-results/windows-pty-feasibility.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify(receipt))
  assert.ok(receipt.fullFeatureRoutes.length > 0, 'No full-feature ConPTY route demonstrated; retain evidence and resolve before Story 53.3')
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }) }
