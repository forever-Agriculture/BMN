// MODULE: brain-search.test.ts - Synthetic scale bound and bilingual substring fallback
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { describe,it,expect } from 'vitest'
import type { DatabaseConnection } from './database-initialization'
import { BrainStore } from './brain-store'
const SQLite=createRequire(import.meta.url)('better-sqlite3') as new(path:string)=>DatabaseConnection
describe('brain search scale',()=>{
 it('puts known targets in the top five of ten bounded rows and meets the 5,000-note timing budget',()=>{
  const store=new BrainStore(new SQLite(':memory:'))
  try{
   store.importNotes(Array.from({length:5000},(_,i)=>({source:`synthetic/${i}.md`,title:`Synthetic ${i}`,kind:'fact',origin:'import',scope:'all',markdown:`A synthetic fixture about topic-${i}. Українська пам’ять: тема-${i}.`,status:'active' as const})))
   const times:number[]=[]
   for(let i=0;i<200;i++){
    const start=performance.now();const rows=store.search(`topic-${i*23}`);times.push(performance.now()-start)
    expect(rows.slice(0,5).some(n=>n.title===`Synthetic ${i*23}`)).toBe(true);expect(rows.length).toBeLessThanOrEqual(10)
   }
   const p95=times.sort((a,b)=>a-b)[Math.ceil(times.length*.95)-1]!
   console.log(JSON.stringify({notes:5000,queries:200,p95Ms:p95,budgetMs:200}))
   expect(p95).toBeLessThan(200)
   expect(store.search('УК').length).toBe(10)
   expect(store.search('Українська')).toHaveLength(10)
  }finally{store.database.close()}
 },30_000)
})
