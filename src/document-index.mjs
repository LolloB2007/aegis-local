// Permission-bounded on-device document index. Python standard library SQLite FTS5.
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {expandHome,inUserHome} from './store.mjs';
import {requireVaultPolicy} from './vault-policy.mjs';

const script=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../scripts/local_index.py');
export const INDEX_MUTATIONS=new Set(['index_rebuild']);
export const INDEX_READS=new Set(['index_search']);
export function indexIntent(text) {
 const s=String(text||'').trim(),m=/^(?:please\s+)?(?:search (?:my )?(?:indexed |local )?(?:documents|files) for|find in (?:my )?(?:indexed |local )?documents:)\s*(.+)$/i.exec(s);
 if(m)return {intent:'index_search',args:{query:m[1]}};
 if(/^(?:please\s+)?(?:index my documents|rebuild (?:my )?(?:local )?document index|refresh (?:my )?(?:local )?document index)$/i.test(s))
   return {intent:'index_rebuild',args:{}};
 return null;
}
export function validateIndexArgs(intent,raw) {
 if(intent==='index_rebuild')return {};
 if(intent==='index_search'&&typeof raw?.query==='string'&&raw.query.trim().length>=2&&raw.query.trim().length<=100)
   return {query:raw.query.trim()};
 throw new Error('Unsupported or incomplete document index request.');
}
export function indexPreview() {
 return {summary:'Rebuild the private on-device SQLite search index from approved search roots. No source files will be changed. This will store derived document text in ~/.aegis-local/documents.sqlite3. Obsidian/aegis memory and hidden files are excluded.',args:{}};
}
async function pythonTask(intent,p,settings) {
 const {spawn}=await import('node:child_process');
 const python=process.env.AEGIS_PYTHON||'python3';
 const roots=settings.searchRoots.map(expandHome).filter(inUserHome);
 const payload=JSON.stringify({roots:[...roots,expandHome(settings.vaultRoot)],exclude:expandHome(settings.memoryRoot),...p});
 return await new Promise((resolve,reject)=>{
  const proc=spawn(python,[script,intent==='index_rebuild'?'rebuild':'search'],{stdio:['pipe','pipe','pipe']});
  let out='',err='';
  const timer=setTimeout(()=>proc.kill('SIGKILL'),intent==='index_rebuild'?60000:12000);
  proc.stdout.on('data',chunk=>{out+=chunk;if(out.length>180000)proc.kill();});
  proc.stderr.on('data',chunk=>{err+=chunk;if(err.length>4000)err=err.slice(-4000);});
  proc.on('error',reject);
  proc.stdin.on('error',()=>{});
  proc.on('close',code=>{
    clearTimeout(timer);
    if(code!==0){reject(new Error('Local document index failed: '+(err||out).slice(0,350)));return;}
    try{const parsed=JSON.parse(out);if(parsed.error)throw new Error(parsed.error);resolve(parsed);}
    catch(e){reject(e);}
  });
  proc.stdin.end(payload);
 });
}
export async function executeIndex(intent,p,settings) {
 const args=validateIndexArgs(intent,p);
 // Rebuilding can traverse the personal Obsidian vault. Require the manual
 // before any scan, even when Documents is an indexed search root.
 if(intent==='index_rebuild')await requireVaultPolicy(settings);
 const result=await pythonTask(intent,args,settings);
 if(intent==='index_rebuild')
   return {text:'Local index updated: '+result.indexed+' documents, '+result.errors+' unreadable files.'+(result.partial?' Scan stopped at a safety limit.':''),details:result};
 return {text:result.results?.length?result.results.map(x=>'- '+x.path+'\n  '+x.excerpt).join('\n'):
   (result.status||'No indexed documents match the exact query.'),details:result};
}
