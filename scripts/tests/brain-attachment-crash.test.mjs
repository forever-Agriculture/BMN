// MODULE: brain-attachment-crash.test.mjs - Durable objects before commit, complete bindings after commit
import {resolve} from 'node:path'
import {it,expect} from 'vitest'
import {probeBrainAttachmentCrashes} from '../test/brain-attachment-crash-probe.mjs'
it.skipIf(process.platform!=='linux')('keeps revision bindings coherent through actual worker kills, changed assets, restart and scratch restore',()=>{const result=probeBrainAttachmentCrashes(resolve(import.meta.dirname,'../..'));expect(result.ok).toBe(true);expect(result.results).toHaveLength(2)},20_000)
