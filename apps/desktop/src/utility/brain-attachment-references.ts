// MODULE: brain-attachment-references.ts - Real Markdown links and Obsidian embeds, excluding literal examples
import { parser } from '@lezer/markdown'
type Node=ReturnType<typeof parser.parse>['topNode']
export interface BrainAttachmentReference {address:string;wiki:boolean}
export function brainAttachmentReferences(markdown:string):BrainAttachmentReference[] {
  const tree=parser.parse(markdown),references=new Map<string,string>(),result:BrainAttachmentReference[]=[],masked=markdown.split('')
  const label=(text:string):string=>text.trim().replace(/\s+/gu,' ').toLocaleLowerCase('und')
  const hide=(from:number,to:number):void=>{for(let i=from;i<to;i++)if(masked[i]!=='\n'&&masked[i]!=='\r')masked[i]=' '}
  const front=/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/u.exec(markdown)
  if(front)hide(0,front[0].length)
  const definitions=(node:Node):void=>{
    if(node.name==='LinkReference'){
      const name=node.getChild('LinkLabel'),url=node.getChild('URL')
      if(name&&url)references.set(label(markdown.slice(name.from+1,name.to-1)),markdown.slice(url.from,url.to))
    }
    for(let child=node.firstChild;child;child=child.nextSibling)definitions(child)
  }
  definitions(tree.topNode)
  const visit=(node:Node):void=>{
    if(['FencedCode','CodeBlock','InlineCode','HTMLBlock','CommentBlock','ProcessingInstructionBlock'].includes(node.name)){hide(node.from,node.to);return}
    if(front&&node.name!=='Document'&&node.from<front[0].length)return
    if(node.name==='Link'||node.name==='Image'){
      const url=node.getChild('URL'),name=node.getChild('LinkLabel'),marks=node.getChildren('LinkMark')
      const address=url?markdown.slice(url.from,url.to):references.get(label(name?markdown.slice(name.from+1,name.to-1):markdown.slice(marks[0]?.to??node.from,marks[1]?.from??node.to)))
      if(address)result.push({address:address.replace(/^<|>$/g,''),wiki:false})
    }
    for(let child=node.firstChild;child;child=child.nextSibling)visit(child)
  }
  visit(tree.topNode)
  for(const match of masked.join('').matchAll(/(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)){
    const before=markdown.slice(0,match.index),slashes=/\\+$/.exec(before)?.[0].length??0
    if(slashes%2===1)continue
    if(match[1]||/(?:^|\/)files\//.test(match[2]!))result.push({address:match[2]!,wiki:true})
  }
  return result
}
/** Where each real attachment address sits in the text (inline and reference-style link destinations, wiki targets), never in code. */
export interface BrainAttachmentSpan {from:number;to:number;address:string;wiki:boolean}
export function brainAttachmentSpans(markdown:string):BrainAttachmentSpan[] {
  const tree=parser.parse(markdown),spans:BrainAttachmentSpan[]=[],masked=markdown.split('')
  const hide=(from:number,to:number):void=>{for(let i=from;i<to;i++)if(masked[i]!=='\n'&&masked[i]!=='\r')masked[i]=' '}
  const front=/^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/u.exec(markdown)
  if(front)hide(0,front[0].length)
  const visit=(node:Node):void=>{
    if(['FencedCode','CodeBlock','InlineCode','HTMLBlock','CommentBlock','ProcessingInstructionBlock'].includes(node.name)){hide(node.from,node.to);return}
    if(front&&node.name!=='Document'&&node.from<front[0].length)return
    if(node.name==='Link'||node.name==='Image'||node.name==='LinkReference'){
      const url=node.getChild('URL')
      if(url)spans.push({from:url.from,to:url.to,address:markdown.slice(url.from,url.to).replace(/^<|>$/g,''),wiki:false})
    }
    for(let child=node.firstChild;child;child=child.nextSibling)visit(child)
  }
  visit(tree.topNode)
  for(const match of masked.join('').matchAll(/(!?)\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]*)?\]\]/g)){
    const before=markdown.slice(0,match.index),slashes=/\\+$/.exec(before)?.[0].length??0
    if(slashes%2===1)continue
    const from=match.index+match[1]!.length+2
    spans.push({from,to:from+match[2]!.length,address:match[2]!,wiki:true})
  }
  return spans.sort((a,b)=>a.from-b.from)
}

