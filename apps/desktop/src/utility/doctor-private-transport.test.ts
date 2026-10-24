// MODULE: doctor-private-transport.test.ts - Real private context transport and one aggregate process budget
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { boundedProcess, sandboxProcess } from '../../bin/doctor-adapters.mjs'

const folders: string[] = []
afterEach(() => { for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }) })

it('keeps a private context off argv, environment and projected stdout through the actual sandbox', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'bmn-private-doctor-')); folders.push(folder)
  const home = join(folder, 'home'); mkdirSync(home)
  const context = JSON.stringify({ profileKey: '0123456789abcdef'.repeat(4) })
  const program = `const fs=require('node:fs');const input=fs.readFileSync(0,'utf8');const key=JSON.parse(input).profileKey;const leaked=JSON.stringify([process.argv,process.env]).includes(key);process.stdout.write(JSON.stringify({state:'passed',problems:[],leaked}));process.stderr.write(JSON.stringify({schema:1,tag:'a'.repeat(64),keyRead:key.length===64}))`
  const result = await sandboxProcess(home, process.execPath, ['-e', program], { PATH: '/usr/bin:/bin' }, { privateInput: context })
  expect(result.failure).toBeNull()
  expect(result.code).toBe(0)
  expect(JSON.parse(result.stdout)).toEqual({ state: 'passed', problems: [], leaked: false })
  expect(JSON.parse(result.privateOutput!)).toEqual({ schema: 1, tag: 'a'.repeat(64), keyRead: true })
  expect(result.stdout).not.toContain('profileKey')
  expect(result.stdout).not.toContain('0123456789abcdef')
  expect(result.privateOutput).not.toContain('0123456789abcdef')
})

it('counts the private return stream against the same bound and publishes no partial stream on overflow', async () => {
  const result = await boundedProcess(process.execPath, ['-e', `require('node:fs').readFileSync(0);process.stdout.write('PUBLIC');process.stderr.write('x'.repeat(4096))`],
    { environment: {}, privateInput: '{}', outputBytes: 128, timeoutMs: 2000 })
  expect(result.failure).toBe('overflow')
  expect(result.stdout).toBe('')
  expect(result.privateOutput).toBe('')
})

it('leaves unrelated doctor stderr discarded when no private channel is requested', async () => {
  const result = await boundedProcess(process.execPath, ['-e', `process.stdout.write('PUBLIC');process.stderr.write('DIAGNOSTIC')`], { environment: {} })
  expect(result.stdout).toBe('PUBLIC')
  expect(result).not.toHaveProperty('privateOutput')
})

it('returns neither stream after a timed-out private worker', async () => {
  const result = await boundedProcess(process.execPath, ['-e', `require('node:fs').readFileSync(0);process.stdout.write('PUBLIC');process.stderr.write('PRIVATE');setInterval(()=>{},1000)`],
    { environment: {}, privateInput: '{}', timeoutMs: 300 })
  expect(result.failure).toBe('timeout')
  expect(result.stdout).toBe(''); expect(result.privateOutput).toBe('')
})
