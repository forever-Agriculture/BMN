// MODULE: brain-store.ts - Transactional note history, import identity and cheap local search
import { createHash, randomUUID } from 'node:crypto'
import type { DatabaseConnection } from './database-initialization'
import { initializeBrain } from './brain-schema'
import { brainSection } from '../../bin/brain-markdown.mjs'
import {brainAttachmentReferences} from './brain-attachment-references'
export interface BrainAttachmentBinding {reference:string;path:string;hash:string|null;size:number|null;state:'captured'|'missing'|'ambiguous'|'unknown'|'legacy'}
export interface BrainAttachmentInput {state:'complete'|'unproven';bindings:BrainAttachmentBinding[]}
type AttachmentInput=(content:BrainContent,source:string|null)=>BrainAttachmentInput

export type BrainStatus = 'active' | 'archived' | 'withdrawn'
export interface BrainContent {
  title: string
  kind: string
  origin: string
  scope: string
  markdown: string
  source_time?: string
  superseded_by?: string | null
}
export interface BrainNote extends BrainContent {
  id: string
  import_source?: string | null
  revision: number
  status: BrainStatus
  session: string
  checksum: string
  recorded_at: string
  source_time: string
  superseded_by: string | null
}
export interface BrainImport extends BrainContent { source: string; status: 'active' | 'archived' }
export interface BrainLink { kind: 'note' | 'project'; target: string; resolved: string | null }
export class BrainError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'BrainError' }
}
export const brainHash = (text: string): string => createHash('sha256').update(text).digest('hex')
export const normalizeBrainTitle = (title: string): string => title.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('und')
const HEAD = `SELECT n.id, n.import_source, v.* FROM brain_note n JOIN brain_version v
  ON v.note=n.id AND v.revision=n.head_revision`
function fail(code: string, message: string): never { throw new BrainError(code, message) }
function validateContent(content: BrainContent, imported = false): void {
  for (const key of ['title','kind','origin','scope','markdown'] as const) {
    if (typeof content[key] !== 'string') fail('INVALID_ARGUMENT', `Brain ${key} must be text`)
  }
  if (!normalizeBrainTitle(content.title) || content.title.length > 500) fail('INVALID_ARGUMENT', 'Brain title must contain 1–500 characters')
  if (!content.kind.trim() || !content.origin.trim()) fail('INVALID_ARGUMENT', 'Brain kind and origin are required')
  if (Buffer.byteLength(content.markdown) > 1024 * 1024) fail('INVALID_ARGUMENT', 'Brain notes may be at most 1 MiB; split the note')
  if (!imported && content.scope !== 'all') {
    const members = content.scope.startsWith('group:') ? content.scope.slice(6).split(',').map(s => s.trim()).filter(Boolean) : []
    if (new Set(members).size < 2) fail('PROJECT_HOME', 'Project facts belong in that project’s plan or rules file; brain scope is all or group:<two-or-more-projects>')
  }
  if (content.source_time && !Number.isFinite(Date.parse(content.source_time))) fail('INVALID_ARGUMENT', 'Brain source date must be an ISO timestamp')
}
export class BrainStore {
  private attachmentInput:AttachmentInput|undefined
  configureAttachments(input:AttachmentInput):void{this.attachmentInput=input}
  private observeAttachments(content:BrainContent,source:string|null):BrainAttachmentInput{
    if(this.attachmentInput)return this.attachmentInput(content,source)
    const possible=brainAttachmentReferences(content.markdown).some(row=>/^(?:files\/|\.\.\/files\/|~\/brain\/files\/)/.test(row.address)||row.wiki&&/\.[a-z0-9]+(?:#.*)?$/i.test(row.address)&&!/[.]md(?:#.*)?$/i.test(row.address))
    return {state:possible?'unproven':'complete',bindings:[]}
  }
  private priorAttachments(id:string,revision:number):BrainAttachmentInput{
    const coverage=this.database.prepare('SELECT state FROM brain_attachment_coverage WHERE note=? AND revision=?').get(id,revision) as {state:'complete'|'unproven'}|undefined
    const bindings=this.database.prepare('SELECT reference,path,hash,size,state FROM brain_attachment WHERE note=? AND revision=? ORDER BY reference').all(id,revision) as BrainAttachmentBinding[]
    return {state:coverage?.state??'unproven',bindings}
  }
  constructor(readonly database: DatabaseConnection, initialize = true) { if (initialize) initializeBrain(database) }
  isOpen(): boolean { return (this.database.prepare("SELECT value FROM brain_meta WHERE key='write_door'").get() as {value: string}).value === 'open' }
  /** Called by the owner-authorized cutover service, never exposed as a session command. */
  setWriteDoor(open: boolean): void { this.database.prepare("UPDATE brain_meta SET value=? WHERE key='write_door'").run(open ? 'open' : 'closed') }
  private writeAllowed(session: string): void {
    if (!session.trim()) fail('UNAUTHORIZED', 'Brain writes require a live BMN session')
    if (!this.isOpen()) fail('CUTOVER_PENDING', 'The brain is read-only until the owner switches in BMN’s command palette')
  }
  read(name: string, options: { section?: string; links?: boolean } = {}): BrainNote & { links?: BrainLink[]; backlinks?: BrainLink[] } {
    const rows = this.database.prepare(HEAD + ' WHERE n.id=? OR n.normalized_title=?').all(name, normalizeBrainTitle(name)) as BrainNote[]
    const exact = rows.find(row => row.id === name)
    if (!exact && rows.length > 1) fail('AMBIGUOUS', 'Several imported notes have that title; read by note id')
    const note: (BrainNote & { links?: BrainLink[]; backlinks?: BrainLink[] }) | undefined = exact ?? rows[0]
    if (!note) fail('NOT_FOUND', 'Brain note not found')
    if (options.section !== undefined) {
      const section = brainSection(note.markdown, options.section)
      if (section === null) fail('NOT_FOUND', 'Brain section not found')
      note.markdown = section
    }
    if (options.links) {
      note.links = this.database.prepare('SELECT kind,target,resolved FROM brain_link WHERE note=?').all(note.id) as BrainLink[]
      note.backlinks = this.database.prepare('SELECT kind,note AS target,resolved FROM brain_link WHERE resolved=?').all(note.id) as BrainLink[]
    }
    return note
  }
  history(name: string): BrainNote[] { const n=this.read(name); return this.database.prepare('SELECT note AS id,* FROM brain_version WHERE note=? ORDER BY revision').all(n.id) as BrainNote[] }
  list(): BrainNote[] { return this.database.prepare(HEAD + ' ORDER BY n.id').all() as BrainNote[] }
  currentNotes():BrainNote[]{return this.database.prepare(HEAD+' WHERE n.import_source IS NULL OR EXISTS(SELECT 1 FROM brain_import_current c WHERE c.note=n.id) ORDER BY n.id').all() as BrainNote[]}
  currentImportSet():{source:string;note:string}[]{return this.database.prepare('SELECT source,note FROM brain_import_current ORDER BY source').all() as {source:string;note:string}[]}
  create(content: BrainContent, session: string, allocatedId?:string): BrainNote {
    validateContent(content)
    return this.database.transaction(() => {
      this.writeAllowed(session)
      const duplicate=this.database.prepare('SELECT id FROM brain_note WHERE normalized_title=?').get(normalizeBrainTitle(content.title)) as {id:string} | undefined
      if (duplicate) fail('DUPLICATE_TITLE', `That brain title exists; edit note ${duplicate.id}`)
      const count=(this.database.prepare('SELECT count FROM brain_session_created WHERE session=?').get(session) as {count:number} | undefined)?.count ?? 0
      if (count >= 3) fail('SESSION_LIMIT', 'This session created 3 brain notes; edit an existing note')
      const id=allocatedId??randomUUID()
      if(!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id))fail('INVALID_ARGUMENT','Invalid private note identity')
      this.database.prepare("INSERT INTO brain_note VALUES (?,0,'active',?,NULL)").run(id,normalizeBrainTitle(content.title))
      this.append(id,0,content,'create','active',session)
      this.database.prepare('INSERT INTO brain_session_created VALUES (?,1) ON CONFLICT(session) DO UPDATE SET count=count+1').run(session)
      this.resolveLinks()
      return this.read(id)
    })()
  }
  edit(name: string, revision: number, content: BrainContent, session: string): BrainNote {
    validateContent(content)
    return this.change(name,revision,session,(note) => {
      const duplicate=this.database.prepare('SELECT id FROM brain_note WHERE normalized_title=? AND id<>?').get(normalizeBrainTitle(content.title),note.id)
      if (duplicate && normalizeBrainTitle(content.title)!==normalizeBrainTitle(note.title)) fail('DUPLICATE_TITLE','That brain title exists; edit the existing note')
      return this.append(note.id,revision,content,'edit',note.status,session)
    })
  }
  withdraw(name: string, revision: number, session: string): BrainNote {
    return this.change(name,revision,session,n=>this.append(n.id,revision,n,'withdraw','withdrawn',session))
  }
  restore(name: string, revision: number, session: string): BrainNote {
    return this.change(name,revision,session,n=>{
      const previous=this.database.prepare("SELECT status FROM brain_version WHERE note=? AND status!='withdrawn' ORDER BY revision DESC LIMIT 1").get(n.id) as {status: BrainStatus} | undefined
      this.append(n.id,revision,n,'restore',previous?.status ?? 'active',session)
    })
  }
  delete(): never { return fail('DELETE_FORBIDDEN', 'Brain deletion is reserved for the owner’s named request in Epic 128; withdraw the note instead') }
  private change(name: string, revision: number, session: string, change: (n: BrainNote)=>void): BrainNote {
    if (!Number.isSafeInteger(revision) || revision<1) fail('INVALID_ARGUMENT','Read the brain note and supply its revision')
    return this.database.transaction(() => {
      this.writeAllowed(session)
      const note=this.read(name)
      if (note.revision!==revision) fail('STALE_REVISION',`Brain revision is ${note.revision}; read again before editing`)
      change(note); this.resolveLinks(); return this.read(note.id)
    })()
  }
  private append(id: string, previous: number, content: BrainContent, action: string, status: BrainStatus, session: string, observed?:BrainAttachmentInput): void {
    const revision=previous+1; const now=new Date().toISOString()
    const source=(this.database.prepare('SELECT import_source FROM brain_note WHERE id=?').get(id) as {import_source:string|null}).import_source
    // Admission and stale-revision checks already ran in this same transaction.
    // Objects become durable first; every revision and binding then commits together.
    const capture=observed??(['withdraw','restore','import-archive'].includes(action)?this.priorAttachments(id,previous):this.observeAttachments(content,source))
    if(new Set(capture.bindings.map(row=>row.reference)).size!==capture.bindings.length)fail('INVALID_ARGUMENT','Duplicate authored attachment binding')
    this.database.prepare(`INSERT INTO brain_version(note,revision,action,title,kind,origin,session,scope,superseded_by,markdown,checksum,recorded_at,source_time,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id,revision,action,content.title,content.kind,content.origin,session,content.scope,content.superseded_by ?? null,content.markdown,brainHash(content.markdown),now,content.source_time ?? now,status)
    this.database.prepare('INSERT INTO brain_attachment_coverage VALUES(?,?,?)').run(id,revision,capture.state)
    const bind=this.database.prepare('INSERT INTO brain_attachment(note,revision,reference,path,hash,size,state) VALUES(?,?,?,?,?,?,?)')
    for(const row of capture.bindings)bind.run(id,revision,row.reference,row.path,row.hash,row.size,row.state)
    const advanced=this.database.prepare('UPDATE brain_note SET head_revision=?,status=?,normalized_title=? WHERE id=? AND head_revision=?').run(revision,status,normalizeBrainTitle(content.title),id,previous)
    if (Number(advanced.changes)!==1) fail('STALE_REVISION','Brain changed; read again before editing')
    this.project(id,content,status)
  }
  private project(id: string, content: BrainContent, status: BrainStatus): void {
    this.database.prepare('DELETE FROM brain_link WHERE note=?').run(id)
    for (const match of content.markdown.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
      this.database.prepare("INSERT OR IGNORE INTO brain_link VALUES (?,'note',?,NULL)").run(id,match[1]!.trim())
    }
    for (const match of content.markdown.matchAll(/\]\((?:<([^>]+)>|([^)\s]+))(?:\s+(?:"[^"]*"|'[^']*'))?\)/g)) {
      const target=match[1]??match[2]!
      if (/^(?:~\/|\/)/.test(target)) this.database.prepare("INSERT OR IGNORE INTO brain_link VALUES (?,'project',?,NULL)").run(id,target)
    }
    this.database.prepare('DELETE FROM brain_search WHERE note=?').run(id)
    if (status!=='withdrawn') this.database.prepare('INSERT INTO brain_search VALUES (?,?,?)').run(id,content.title,content.markdown)
  }
  private resolveLinks(): void {
    const notes=this.list();const titles=new Map<string,Set<string>>()
    const sources=new Map((this.database.prepare('SELECT id,import_source FROM brain_note').all() as {id:string;import_source:string|null}[]).map(n=>[n.id,n.import_source]))
    for (const n of notes) {
      const source=sources.get(n.id)?.replace(/^vault:/,'').replace(/\.md$/i,'')
      for (const title of new Set([n.title, n.title.split('/').at(-1) ?? n.title, ...(source?[source]:[])])) {
        const key=normalizeBrainTitle(title.replace(/\.md$/i,''));const ids=titles.get(key) ?? new Set<string>();ids.add(n.id);titles.set(key,ids)
      }
    }
    for (const link of this.database.prepare("SELECT note,target FROM brain_link WHERE kind='note'").all() as {note:string;target:string}[]) {
      const ids=titles.get(normalizeBrainTitle(link.target.replace(/\.md$/i,''))) ?? new Set<string>()
      this.database.prepare("UPDATE brain_link SET resolved=? WHERE note=? AND kind='note' AND target=?").run(ids.size===1?[...ids][0]!:null,link.note,link.target)
    }
  }
  /** Only the trusted import operation calls this; origin text never grants import privileges. */
  importNotes(notes: BrainImport[]): { imported: number; unchanged: number; withdrawn: number } {
    if (this.isOpen()) fail('IMPORT_CLOSED','Re-import is available only before the cutover')
    const sources=new Set<string>()
    for (const n of notes) {validateContent(n,true);if(!n.source || sources.has(n.source))fail('INVALID_ARGUMENT','Import sources must be unique');sources.add(n.source)}
    return this.database.transaction(() => {
      let imported=0,unchanged=0,withdrawn=0
      this.database.exec('DELETE FROM brain_import_current')
      for (const content of notes) {
        const previous=this.database.prepare('SELECT id FROM brain_note WHERE import_source=?').get(content.source) as {id:string}|undefined
        const id=previous?.id ?? randomUUID(); const head=previous ? this.read(id) : undefined
        const observed=this.observeAttachments(content,content.source)
        const bindingsMatch=head&&JSON.stringify(this.priorAttachments(id,head.revision))===JSON.stringify(observed)
        if (head?.status==='withdrawn') {
          if(head.checksum!==brainHash(content.markdown)||!bindingsMatch)fail('TOMBSTONE_CONFLICT','An imported source changed after withdrawal; preserve history and resolve it before importing')
          this.database.prepare('INSERT INTO brain_import_current VALUES(?,?)').run(content.source,id)
          withdrawn++;continue
        }
        if (head && bindingsMatch && head.checksum===brainHash(content.markdown) && head.title===content.title && head.status===content.status && head.scope===content.scope && head.kind===content.kind && head.superseded_by===(content.superseded_by ?? null) && (content.source_time===undefined || head.source_time===content.source_time)) {this.database.prepare('INSERT INTO brain_import_current VALUES(?,?)').run(content.source,id);unchanged++;continue}
        if (!previous) this.database.prepare('INSERT INTO brain_note VALUES (?,0,?,?,?)').run(id,content.status,normalizeBrainTitle(content.title),content.source)
        this.append(id,head?.revision ?? 0,{...content,origin:'import'},'import',content.status,'import',observed)
        this.database.prepare('INSERT INTO brain_import_current VALUES(?,?)').run(content.source,id);imported++
      }
      // A replacement batch may omit a formerly selected source. Keep its text and
      // history in the archive, while an explicit withdrawal remains a tombstone.
      for (const head of this.list()) {
        if (head.import_source && !sources.has(head.import_source) && head.status === 'active') {
          this.append(head.id, head.revision, head, 'import-archive', 'archived', 'import')
        }
      }
      // Wipe replaceable projections only. Identity, all versions and tombstones survive.
      this.rebuildProjections()
      return {imported,unchanged,withdrawn}
    })()
  }
  rebuildProjections():void {
    this.database.transaction(()=>{
      this.database.exec('DELETE FROM brain_link; DELETE FROM brain_search;')
      for(const note of this.list())this.project(note.id,note,note.status)
      this.resolveLinks()
    })()
  }
  search(query: string, archived=false): {id:string; title:string; summary:string; score:number}[] {
    query=query.trim();if(!query)return []
    const statuses=archived ? "('active','archived')" : "('active')"
    let rows: Array<{id:string;title:string;markdown:string;score:number}>
    if ([...query].length>=3) {
      const expression='"'+query.replaceAll('"','""')+'"'
      rows=this.database.prepare(`SELECT n.id,v.title,v.markdown,bm25(brain_search,0,5,1) AS score
        FROM brain_search JOIN brain_note n ON n.id=brain_search.note
        JOIN brain_version v ON v.note=n.id AND v.revision=n.head_revision
        WHERE brain_search MATCH ? AND n.status IN ${statuses} ORDER BY score,n.id LIMIT 10`).all(expression) as typeof rows
    } else {
      const needle=query.toLocaleLowerCase('und')
      rows=(this.database.prepare(HEAD+` WHERE n.status IN ${statuses} ORDER BY v.title,n.id`).all() as BrainNote[])
        .filter(n=>(n.title+'\n'+n.markdown).toLocaleLowerCase('und').includes(needle)).slice(0,10).map(n=>({...n,score:0}))
    }
    return rows.map(n=>({id:n.id,title:n.title,summary:n.markdown.replace(/\s+/gu,' ').slice(0,180),score:n.score}))
  }
}
