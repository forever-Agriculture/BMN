// MODULE: opencode-reader-child.test.mjs - Bounded lifetime, late creation and attribution with the one-argument native SDK contract
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createChildAccounting, readChildAccounting } from '../../apps/desktop/bin/opencode-child-accounting.mjs'
import { observeAsk } from '../../apps/desktop/bin/agents-team-run.mjs'
import { runReaderChild } from '../../apps/desktop/bin/opencode-reader-child.mjs'
import { singleReaderChild } from '../../apps/desktop/bin/opencode-project-reader.mjs'
const never = () => new Promise(() => {})
const tick = () => new Promise(resolve => setImmediate(resolve))
const fixture = () => {
  const events = [], interrupted = [], prompted = [], created = [], controller = new AbortController()
  const model = { providerID: 'synthetic', id: 'nondefault', variant: 'high' }
  const ctx = { session: {
    get: async () => ({ id: 'root', model }),
    create: async value => { created.push(value); return { id: 'child' } },
    prompt: async value => { prompted.push(value) },
    wait: async () => {},
    context: async () => [{ type: 'assistant', content: [{ type: 'text', text: 'child answer' }] }],
    interrupt: async value => { interrupted.push(value.sessionID) }
  } }
  const context = { id: 'call-synthetic', sessionID: 'root', signal: controller.signal, progress: async value => { events.push(value) } }
  const accounting = { begin() { return { identify() {}, terminated() {} } } }
  return { ctx, context, controller, model, events, interrupted, prompted, created, accounting }
}

test('a child preserves the parent model and publishes identity before any prompt', async () => {
  const f = fixture()
  f.ctx.session.prompt = async value => { assert.deepEqual(f.events, [{ sessionID: 'child', status: 'running' }]); f.prompted.push(value) }
  assert.deepEqual(await runReaderChild(f.ctx, f.context, { prompt: 'synthetic' }, singleReaderChild(), { accounting: f.accounting }), {content:'child answer',metadata:{sessionID:'child'}})
  assert.deepEqual(f.created, [{ parentID: 'root', title: 'BMN read-only child', agent: 'bmn-reader', model: f.model }])
  assert.deepEqual(f.interrupted, ['child'])
})

test('the explicit child deadline interrupts a stalled one-argument SDK wait without an outer timeout', async () => {
  const f = fixture(), admit = singleReaderChild(), start = Date.now()
  f.ctx.session.wait = never
  await assert.rejects(runReaderChild(f.ctx, f.context, { prompt: 'synthetic' }, admit, { accounting: f.accounting, timeoutMs: 40, cleanupMs: 30 }), /cancelled or exceeded/)
  assert(Date.now() - start < 1000); assert.deepEqual(f.interrupted, ['child'])
  assert.throws(() => admit('root'), /BMN read-only/)
})

test('parent cancellation interrupts the identified child and retains its attribution', async () => {
  const f = fixture()
  f.ctx.session.wait = async () => { setImmediate(() => f.controller.abort()); return never() }
  await assert.rejects(runReaderChild(f.ctx, f.context, { prompt: 'synthetic' }, singleReaderChild(), { accounting: f.accounting }), /cancelled or exceeded/)
  assert.deepEqual(f.interrupted, ['child']); assert.equal(f.events[0].sessionID, 'child')
})

test('late creation after deadline is attributed and interrupted without ever prompting', async () => {
  const f = fixture(); let create
  f.ctx.session.create = () => new Promise(resolve => { create = resolve })
  await assert.rejects(runReaderChild(f.ctx, f.context, { prompt: 'synthetic' }, singleReaderChild(), { accounting: f.accounting, timeoutMs: 20, cleanupMs: 30 }), /cancelled or exceeded/)
  create({ id: 'late-child' }); await tick(); await tick()
  assert.deepEqual(f.interrupted, ['late-child']); assert.deepEqual(f.prompted, [])
  assert.equal(f.events[0].sessionID, 'late-child')
})

test('an unconfirmed child interruption fails closed in the standalone helper', async () => {
  const f = fixture(); let fatal = 0
  f.ctx.session.wait = never; f.ctx.session.interrupt = never
  await assert.rejects(runReaderChild(f.ctx, f.context, { prompt: 'synthetic' }, singleReaderChild(), { accounting: f.accounting, timeoutMs: 20, cleanupMs: 20, fatal: () => { fatal++ } }), /interruption could not be confirmed/)
  assert.equal(fatal, 1)
})

// The native final event replaces progress; final results must preserve child identity too.
test('final child metadata survives completion and creation intent is persisted before dispatch', async () => {
  const f = fixture(), states = []
  const accounting = { begin(parent, call) { states.push(['intent',parent,call]); return { identify(id) { states.push(['identity',id]) }, terminated() { states.push(['terminated']) } } } }
  f.context.id='call-synthetic'
  f.ctx.session.create=async()=>{ assert.deepEqual(states,[['intent','root','call-synthetic']]); return {id:'child'} }
  const result=await runReaderChild(f.ctx,f.context,{prompt:'synthetic'},singleReaderChild(),{accounting})
  assert.deepEqual(result,{content:'child answer',metadata:{sessionID:'child'}})
  assert.deepEqual(states,[['intent','root','call-synthetic'],['identity','child'],['terminated']])
})

test('a failed durable intent refuses child creation', async () => {
 const f=fixture()
 const accounting={begin(){throw new Error('synthetic persistence failure')}}
 await assert.rejects(runReaderChild(f.ctx,f.context,{prompt:'synthetic'},singleReaderChild(),{accounting}),/persistence failure/)
 assert.deepEqual(f.created,[])
})


test('durable intent and identity survive reload; unresolved creation remains incomplete', async () => {
 const directory=mkdtempSync(join(tmpdir(),'bmn-child-accounting-'))
 try {
  const accounting=createChildAccounting(directory), f=fixture()
  f.ctx.session.create=async()=>{throw new Error('synthetic lost response')}
  await assert.rejects(runReaderChild(f.ctx,f.context,{prompt:'synthetic'},singleReaderChild(),{accounting}),/lost response/)
  assert.deepEqual(readChildAccounting(directory,'root'),{complete:false,children:[],reason:'child creation has not conclusively settled'})
  assert.throws(()=>createChildAccounting(directory).begin('root','other-call'),/EEXIST/)
  const pending=createChildAccounting(directory).begin('another-root','another-call')
  pending.identify('known-child')
  assert.equal(readChildAccounting(directory,'another-root').complete,false)
  pending.terminated()
  assert.deepEqual(readChildAccounting(directory,'another-root'),{complete:true,children:[{session:'known-child',parent:'another-root',role:'bmn-reader'}]})
  for(const filename of (await import('node:fs')).readdirSync(directory))assert.equal(statSync(join(directory,filename)).mode&0o777,0o600)
 } finally {rmSync(directory,{recursive:true,force:true})}
})

test('late child identity is durable after cancellation and never prompts', async () => {
 const directory=mkdtempSync(join(tmpdir(),'bmn-child-late-'))
 try {
  const f=fixture();let create
  f.ctx.session.create=()=>new Promise(resolve=>{create=resolve})
  await assert.rejects(runReaderChild(f.ctx,f.context,{prompt:'synthetic'},singleReaderChild(),{accounting:createChildAccounting(directory),timeoutMs:20,cleanupMs:30}),/cancelled or exceeded/)
  assert.equal(readChildAccounting(directory,'root').complete,false)
  create({id:'late-child'});await tick();await tick()
  assert.deepEqual(readChildAccounting(directory,'root'),{complete:true,children:[{session:'late-child',parent:'root',role:'bmn-reader'}]})
  assert.deepEqual(f.prompted,[])
 } finally {rmSync(directory,{recursive:true,force:true})}
})

test('usage includes a ledger-only child once and retains unresolved accounting', () => {
 const directory=mkdtempSync(join(tmpdir(),'bmn-child-usage-'))
 try {
  const info=(id,parent,input)=>({id,parent,model:{id:'synthetic-model',provider:'fixture',variant:'high'},tokens:{input,output:1,reasoning:0,cache_read:0},reported_cost:0})
  writeFileSync(join(directory,'events.jsonl'),JSON.stringify({type:'text',sessionID:'parent',part:{text:'synthetic answer'}})+'\n')
  const record={version:1,info:info('parent',null,3),discovery:{complete:false,reason:'child creation has not conclusively settled'},subagents:[{session:'child',parent:'parent',role:'bmn-reader',info:info('child','parent',5)}]}
  writeFileSync(join(directory,'session-info.json'),JSON.stringify(record))
  let result=observeAsk(directory,'opencode',{model:'synthetic-model',provider:'fixture',effort:'high'})
  assert.equal(result.subagents.length,1);assert.equal(result.usage.input_tokens,8);assert.equal(result.usage.complete,false)
  assert.match(result.usage.incomplete_reason,/creation/)
  const event={type:'tool_use',sessionID:'parent',part:{tool:'bmn_subagent',state:{status:'completed',metadata:{metadata:{sessionID:'child'}}}}}
  writeFileSync(join(directory,'events.jsonl'),[event,event].map(e=>JSON.stringify(e)).join('\n')+'\n')
  record.discovery={complete:true};writeFileSync(join(directory,'session-info.json'),JSON.stringify(record))
  result=observeAsk(directory,'opencode',{model:'synthetic-model',provider:'fixture',effort:'high'})
  assert.equal(result.subagents.length,1);assert.equal(result.usage.input_tokens,8);assert.equal(result.usage.complete,true)
  delete record.subagents[0].info
  writeFileSync(join(directory,'session-info.json'),JSON.stringify(record))
  result=observeAsk(directory,'opencode',{model:'synthetic-model',provider:'fixture',effort:'high'})
  assert.equal(result.usage.complete,false);assert.equal(result.subagents[0].parent,'parent')
 } finally {rmSync(directory,{recursive:true,force:true})}
})
