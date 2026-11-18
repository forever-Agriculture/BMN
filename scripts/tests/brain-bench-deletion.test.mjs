// MODULE: brain-bench-deletion.test.mjs - Bound deletion, foreign replacements and durable crash phases
import {resolve} from 'node:path'
import {it,expect} from 'vitest'
import {probeBrainBenchDeletion} from '../test/brain-bench-deletion-probe.mjs'
it.skipIf(process.platform!=='linux')('recovers actual bench deletion crashes and preserves foreign entries at both race boundaries',()=>{const result=probeBrainBenchDeletion(resolve(import.meta.dirname,'../..'));expect(result.ok).toBe(true);expect(result.results).toHaveLength(7)},15_000)
