// Extractive, Ollama-assisted session context compaction for a 3B model.
// The LLM ONLY selects IDs. Retained text comes verbatim from past user turns.
// This is not personal memory and NEVER writes to Obsidian.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {paths} from './store.mjs';

const FILE=path.join(paths.dataDir,'session-compaction.json');
const MAX_ITEMS=9;
const MAX_SOURCE=5200;
const hash=m=>createHash('sha256').update(String(m.at||'')+'\n'+m.role+'\n'+m.content).digest('hex').slice(0,20);
const normalize=s=>String(s||'').replace(/\s+/g,' ').trim();
async function readCheckpoint(){
 try{
  const x=JSON.parse(await fs.readFile(FILE,'utf8'));
  if(!x||!Array.isArray(x.excerpts)||typeof x.lastCovered!=='string')return {lastCovered:'',excerpts:[]};
  return {lastCovered:x.lastCovered,excerpts:x.excerpts.filter(e=>e&&typeof e.text==='string'&&e.text.length<=230).slice(-MAX_ITEMS)};
 }catch(e){if(e.code==='ENOENT'||e instanceof SyntaxError)return {lastCovered:'',excerpts:[]};throw e;}
}
async function checkpoint(x){
 await fs.mkdir(paths.dataDir,{recursive:true,mode:0o700});
 const tmp=FILE+'.'+process.pid+'.tmp';
 await fs.writeFile(tmp,JSON.stringify(x,null,2),{mode:0o600});
 await fs.rename(tmp,FILE);
}
export async function compactSessionContext(settings,history,{fetchImpl=fetch}={}){
 const older=history.slice(0,Math.max(0,history.length-10));
 let saved=await readCheckpoint();
 if(older.length<16)return saved.excerpts;
 let pos=saved.lastCovered?older.findIndex(m=>hash(m)===saved.lastCovered):-1;
 const unprocessed=older.slice(pos+1);
 if(unprocessed.length<10)return saved.excerpts;
 const pending=unprocessed.slice(0,20);
 const userCandidates=pending.filter(x=>x.role==='user'&&typeof x.content==='string')
   .map((m,i)=>({id:i+1,text:normalize(m.content).slice(0,210)}))
   .filter(x=>x.text.length>=8);
 let chosen=[];
 if(userCandidates.length){
  const lines=userCandidates.map(x=>x.id+': '+x.text).join('\n').slice(0,MAX_SOURCE);
  // Intentionally only ask the 3B to select numeric IDs, not invent summaries.
  // Every selected excerpt is mapped back to the original user message.
  try{
   const controller=AbortSignal.timeout(30000);
   const response=await fetchImpl(settings.ollamaUrl+'/api/chat',{
    method:'POST',headers:{'content-type':'application/json'},signal:controller,
    body:JSON.stringify({model:settings.llmModel,stream:false,format:'json',keep_alive:settings.autoUnload?0:'5m',
     options:{temperature:0,num_ctx:Math.max(1024,settings.contextTokens)},
     messages:[
      {role:'system',content:'You are selecting important prior USER messages for a tiny local assistant context. Return only JSON {"ids":[integer,...]} with up to 5 IDs listed in the input. Prefer enduring preferences, unfinished tasks, and relevant decisions. Do not invent text, facts or IDs.'},
      {role:'user',content:'Choose up to five IDs from these prior user messages:\n'+lines}
     ]})
   });
   if(!response.ok)throw Error('Ollama unavailable');
   const raw=await response.text();
   if(raw.length>4000)throw Error('Selection too long');
   const ids=JSON.parse(JSON.parse(raw).message?.content||'{}').ids;
   if(!Array.isArray(ids))throw Error('Invalid selection');
   chosen=[...new Set(ids)].filter(Number.isInteger).map(id=>userCandidates.find(x=>x.id===id)).filter(Boolean).slice(0,5);
  }catch{
   // Deterministic fallback. Losing unverified facts is safer than inventing them.
   chosen=userCandidates.slice(-3);
  }
 }
 const fresh=chosen.map(x=>({text:x.text,kind:'prior user statement'}));
 saved={lastCovered:hash(pending.at(-1)),excerpts:[...saved.excerpts,...fresh].slice(-MAX_ITEMS)};
 await checkpoint(saved);
 return saved.excerpts;
}
export async function sessionContextForPrompt(settings,history,options={}){
 if(settings.autoCompact===false)return '';
 const excerpts=await compactSessionContext(settings,history,options);
 return excerpts.map(x=>'- '+x.text).join('\n').slice(0,1600);
}
