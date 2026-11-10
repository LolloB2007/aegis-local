// Aegis v2.1: explicit, consented Markdown memory, separate from read-only vault.
// Absolutely no automatic creation of personal, daily, or system-prompt notes.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expandHome, inUserHome } from './store.mjs';

export const MEMORY_MUTATIONS = new Set([
  'memory_note_create','memory_remember','memory_todo_add','memory_todo_done',
  'memory_routine_add','memory_journal_add','memory_forget'
]);
export const MEMORY_READS = new Set(['memory_show','memory_search','memory_note_list']);
const SCOPE_FILES = Object.freeze({
  persistent:'Persistent memory.md',
  todo:'To-Do List.md',
  routines:'Routine Tasks.md',
  journal:'Daily'
});
const ROOT_RELATIVE = 'Documents/Obsidian/aegis';
const MAX_NOTE = 180000;
const within=(root,file)=>file===root||file.startsWith(root+path.sep);
const dateKey=(now=new Date())=>[
  now.getFullYear(),String(now.getMonth()+1).padStart(2,'0'),
  String(now.getDate()).padStart(2,'0')].join('-');
export const dailyNotePath = (now=new Date())=>'Daily/'+dateKey(now)+'.md';

function plain(value,label,max=650) {
  if(typeof value!=='string')throw new Error(label+' must be text.');
  const x=value.trim();
  if(!x||x.length>max||/[\u0000-\u001f\u007f]/.test(x))
    throw new Error('Invalid '+label+'. Provide a short, single-line value.');
  return x;
}
function relativeNote(value) {
  const item=plain(value,'Markdown note path',240).replaceAll('\\','/');
  const segments=item.split('/');
  if(!item.endsWith('.md')||path.posix.isAbsolute(item)||segments.length>4||
     segments.some(x=>!x||x==='.'||x==='..'||x.startsWith('.'))||
     segments.some(x=>/[:*?"<>|]/.test(x)))
    throw new Error('Use a non-hidden relative Markdown path ending in .md, up to four segments.');
  return segments.join('/');
}
export function memoryIntent(input) {
  const s=String(input||'').trim();
  let m;
  // Legacy natural-language memory command now uses v2.1's explicit approval
  // workflow and the single Aegis-owned Persistent memory.md note.
  if((m=/^(?:please\s+)?remember\s+that\s+(.+)$/i.exec(s)))
    return {intent:'memory_remember',args:{text:m[1]}};
  if((m=/^(?:please\s+)?(?:create (?:an? )?aegis (?:markdown )?note|create aegis md file)\s*:\s*(.+)$/i.exec(s)))
    return {intent:'memory_note_create',args:{path:m[1]}};
  if(/^(?:please\s+)?(?:start (?:my )?(?:aegis )?(?:daily|today's) note|create today's aegis note)$/i.test(s))
    return {intent:'memory_note_create',args:{path:dailyNotePath()}};
  if(/^(?:please\s+)?(?:list aegis notes|list aegis memory files)$/i.test(s))
    return {intent:'memory_note_list',args:{}};
  const rules=[
    ['memory_remember',/^(?:please\s+)?(?:remember for aegis|aegis remember|save to aegis memory)\s*:\s*(.+)$/i,'text'],
    ['memory_todo_add',/^(?:please\s+)?(?:add to (?:my )?aegis to-do list|aegis (?:add )?todo|add aegis task)\s*:\s*(.+)$/i,'text'],
    ['memory_todo_done',/^(?:please\s+)?(?:complete aegis task|mark aegis task done)\s*:\s*(.+)$/i,'text'],
    ['memory_routine_add',/^(?:please\s+)?(?:add (?:an? )?aegis routine|add to aegis routine tasks)\s*:\s*(.+)$/i,'text'],
    ['memory_journal_add',/^(?:please\s+)?(?:write in (?:today's|todays) aegis journal|aegis journal)\s*:\s*(.+)$/i,'text'],
    ['memory_forget',/^(?:please\s+)?(?:forget from aegis|remove from aegis memory)\s*:\s*(.+)$/i,'text'],
    ['memory_search',/^(?:please\s+)?(?:search aegis memory for|what does aegis remember about)\s+(.+)$/i,'query']
  ];
  for(const [intent,regex,key] of rules){
    m=regex.exec(s);if(m)return {intent,args:{[key]:m[1]}};
  }
  if(/^(?:please\s+)?(?:show|read|list|open)\s+(?:(?:my|the)\s+)?aegis\s+(?:memory|persistent memory|persistent context|to-do list|todo|routine tasks|routines|journal|today's journal)\s*$/i.test(s)){
    const low=s.toLowerCase();
    const scope=/journal/.test(low)?'journal':/routine/.test(low)?'routines':/todo|to-do/.test(low)?'todo':'persistent';
    return {intent:'memory_show',args:{scope}};
  }
  return null;
}
export function validateMemoryArgs(intent,value) {
  if(!MEMORY_READS.has(intent)&&!MEMORY_MUTATIONS.has(intent))throw new Error('Unsupported memory tool.');
  const p=value&&typeof value==='object'&&!Array.isArray(value)?value:{};
  if(intent==='memory_note_create')return {path:relativeNote(p.path)};
  if(MEMORY_MUTATIONS.has(intent))return {text:plain(p.text,'memory entry')};
  if(intent==='memory_search')return {query:plain(p.query,'search phrase',120)};
  if(intent==='memory_note_list')return {};
  const scope=String(p.scope||'persistent');
  if(!Object.hasOwn(SCOPE_FILES,scope))throw new Error('Unknown memory scope.');
  return {scope};
}
export function memoryPreview(intent,raw) {
  const p=validateMemoryArgs(intent,raw);
  if(intent==='memory_note_create')return {
    args:p,summary:'Create an EMPTY Aegis-owned Markdown note:\n'+p.path+
    '\n\nNo template or context content will be generated. Existing notes will not be overwritten.'
  };
  const file={
    memory_remember:SCOPE_FILES.persistent,memory_todo_add:SCOPE_FILES.todo,
    memory_todo_done:SCOPE_FILES.todo,memory_routine_add:SCOPE_FILES.routines,
    memory_journal_add:'Daily/<today>.md',memory_forget:SCOPE_FILES.persistent
  }[intent];
  return {args:p,summary:'Change ONLY Aegis-owned '+file+
    '\nOperation: '+intent+'\nExact entry: '+p.text+
    '\n\nThe personal vault in Obsidian/claude stays read-only.'};
}
export async function memoryRoot(settings,{create=false}={}) {
  const expected=path.resolve(expandHome('~'),ROOT_RELATIVE);
  const configured=path.resolve(expandHome(settings.memoryRoot||'~/Documents/Obsidian/aegis'));
  const personal=path.resolve(expandHome(settings.vaultRoot||'~/Documents/Obsidian/claude'));
  if(configured!==expected||!inUserHome(configured)||within(configured,personal)||within(personal,configured))
    throw new Error('Aegis memory must stay at ~/Documents/Obsidian/aegis, separate from the read-only vault.');
  if(create)await fs.mkdir(configured,{recursive:true,mode:0o700});
  let root;
  try{root=await fs.realpath(configured);}
  catch(e){
    if(e.code==='ENOENT')throw new Error('Aegis memory folder not found. Create it locally or explicitly create an Aegis note.');
    throw e;
  }
  if(root!==configured)throw new Error('Aegis memory directory cannot be a symlink.');
  const personalActual=await fs.realpath(personal).catch(()=>personal);
  if(within(root,personalActual)||within(personalActual,root))throw new Error('Aegis memory cannot overlap the personal vault.');
  return root;
}
async function noteFile(root,relative,{createParents=false}={}) {
  const p=relativeNote(relative);
  const file=path.resolve(root,p);
  if(!within(root,file))throw new Error('Memory path escapes Aegis root.');
  const parts=p.split('/');let folder=root;
  for(const part of parts.slice(0,-1)){
    folder=path.join(folder,part);
    if(createParents)await fs.mkdir(folder,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;});
    const st=await fs.lstat(folder);
    if(!st.isDirectory()||st.isSymbolicLink())throw new Error('Aegis note folder cannot be a symlink.');
  }
  try{
    const st=await fs.lstat(file);
    if(st.isSymbolicLink()||!st.isFile()||st.size>MAX_NOTE)throw new Error('Unsafe or oversized Aegis Markdown file.');
  }catch(e){if(e.code!=='ENOENT')throw e;}
  return file;
}
async function readOptional(root,relative) {
  let f;
  try {f=await noteFile(root,relative);}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
  let handle;
  try{handle=await fs.open(f,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);}
  catch(e){if(e.code==='ENOENT')return null;throw e;}
  try{return await handle.readFile('utf8');}
  finally{await handle.close();}
}
async function editExisting(root,relative,update) {
  const file=await noteFile(root,relative);
  let before;
  try{before=await fs.readFile(file,'utf8');}
  catch(e){if(e.code==='ENOENT')throw new Error('Note missing: '+relative+'. Please create it locally or with the Create Markdown Note tool.');throw e;}
  const after=update(before);
  if(after===before)return {text:'No change; this exact entry already exists.',details:{path:relative,duplicate:true}};
  if(after.length>MAX_NOTE)throw new Error('Memory note is too large.');
  const tmp=path.join(path.dirname(file),'.aegis-'+randomUUID()+'.tmp');
  await fs.writeFile(tmp,after,{flag:'wx',mode:0o600});
  try{
    const st=await fs.lstat(file);
    if(st.isSymbolicLink()||!st.isFile())throw new Error('Memory note changed while editing.');
    await fs.rename(tmp,file);
  }finally{await fs.rm(tmp,{force:true});}
  return {text:'Updated Aegis memory note: '+relative,details:{path:relative}};
}
const exact=(a,b)=>a.trim().toLowerCase()===b.toLowerCase();
export async function executeMemory(intent,raw,settings) {
  const p=validateMemoryArgs(intent,raw);
  if(intent==='memory_note_create'){
    const root=await memoryRoot(settings,{create:true});
    const file=await noteFile(root,p.path,{createParents:true});
    await fs.writeFile(file,'',{flag:'wx',mode:0o600});
    return {text:'Created empty Aegis Markdown note: '+p.path,details:{path:p.path}};
  }
  if(intent==='memory_search')return searchMemory(settings,p.query);
  if(intent==='memory_note_list')return listMemory(settings);
  const root=await memoryRoot(settings);
  if(intent==='memory_show'){
    const file=p.scope==='journal'?dailyNotePath():SCOPE_FILES[p.scope];
    const content=await readOptional(root,file);
    return {text:content===null?'No note exists at '+file+'. Create it locally or explicitly with the Markdown-note tool.':
      'Aegis memory ['+file+']:\n\n'+content.slice(0,20000),details:{path:file}};
  }
  const file=({
    memory_remember:SCOPE_FILES.persistent,memory_todo_add:SCOPE_FILES.todo,
    memory_todo_done:SCOPE_FILES.todo,memory_routine_add:SCOPE_FILES.routines,
    memory_journal_add:dailyNotePath(),memory_forget:SCOPE_FILES.persistent
  })[intent];
  const isDelete=intent==='memory_forget'||intent==='memory_todo_done';
  return editExisting(root,file,before=>{
    const lines=before.split('\n');
    if(isDelete){
      const expected=intent==='memory_todo_done'?'- [ ] '+p.text:'- '+p.text;
      const indices=lines.flatMap((x,i)=>exact(x,expected)?[i]:[]);
      if(indices.length!==1)throw new Error('Expected one exact matching entry; found '+indices.length+'.');
      if(intent==='memory_todo_done')lines[indices[0]]='- [x] '+p.text;
      else lines.splice(indices[0],1);
      return lines.join('\n');
    }
    const entry=intent==='memory_todo_add'?'- [ ] '+p.text:
      intent==='memory_journal_add'?'- '+new Date().toLocaleTimeString('en-GB',{hour12:false})+' · '+p.text:'- '+p.text;
    if(intent!=='memory_journal_add'&&lines.some(l=>exact(l,entry)))return before;
    return before.replace(/\s*$/,'')+'\n'+entry+'\n';
  });
}
async function walk(root,folder='',depth=0,results=[]) {
  if(depth>3||results.length>=150)return results;
  const dir=path.join(root,folder);
  const entries=await fs.readdir(dir,{withFileTypes:true});
  for(const item of entries){
    if(item.name.startsWith('.')||item.isSymbolicLink())continue;
    const rel=folder?folder+'/'+item.name:item.name;
    if(item.isDirectory())await walk(root,rel,depth+1,results);
    else if(item.isFile()&&item.name.endsWith('.md'))results.push(rel);
    if(results.length>=150)break;
  }
  return results;
}
export async function listMemory(settings) {
  let root;
  try {root=await memoryRoot(settings);}catch(e){if(e.message.includes('not found'))return {text:'No Aegis memory directory exists yet. Create it locally on your Mac.'};throw e;}
  const notes=(await walk(root)).sort();
  return {text:notes.length?notes.map(n=>'• '+n).join('\n'):'Aegis memory directory is empty.',details:{notes}};
}
export async function searchMemory(settings,raw) {
  const query=plain(raw,'search phrase',120).toLowerCase();
  let root;
  try{root=await memoryRoot(settings);}catch(e){if(e.message.includes('not found'))return {text:'No Aegis memory directory exists yet.'};throw e;}
  const files=await walk(root);
  const hits=[];
  for(const file of files){
    if(file==='System Prompt.md')continue;
    const text=await readOptional(root,file);
    if(text===null)continue;
    const lines=text.split('\n');
    for(let i=0;i<lines.length;i++){
      if(lines[i].toLowerCase().includes(query))hits.push({path:file,line:i+1,text:lines[i].slice(0,300)});
      if(hits.length>=20)break;
    }
    if(hits.length>=20)break;
  }
  return {text:hits.length?hits.map(x=>x.path+':'+x.line+' '+x.text).join('\n'):
    'No literal memory matches for "'+query+'".',details:{hits}};
}
const STOP=new Set(['what','where','when','about','that','this','with','from','have','would','could','please','tell','your','mine','some','then','there','their','does','into','show','make','give','aegis','today','tomorrow','remember']);
export async function retrieveMemoryContext(settings,question) {
  let root;
  try{root=await memoryRoot(settings);}catch(e){if(e.message.includes('not found'))return '';throw e;}
  const terms=[...new Set(String(question).toLowerCase().match(/[a-z0-9À-ÿ]{4,}/g)||[])].filter(x=>!STOP.has(x)).slice(0,12);
  if(!terms.length)return '';
  const ranked=[];
  for(const name of [SCOPE_FILES.persistent,SCOPE_FILES.todo,SCOPE_FILES.routines,dailyNotePath()]){
    const body=await readOptional(root,name);
    if(body===null)continue;
    for(const line of body.split('\n')){
      if(!/^-\s/.test(line)||line.length>400)continue;
      const score=terms.filter(t=>line.toLowerCase().includes(t)).length;
      if(score>0)ranked.push({name,line,score});
    }
  }
  ranked.sort((a,b)=>b.score-a.score);
  return ranked.slice(0,6).map(x=>'['+x.name+'] '+x.line.slice(0,240)).join('\n').slice(0,1500);
}
