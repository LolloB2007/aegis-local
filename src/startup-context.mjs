// Startup context is user-authored data. No Markdown files are generated here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { memoryRoot } from './memory.mjs';

const MAX_FILE_BYTES=24000;
const MAX_PROMPT_CHARS=3800;
let snapshot=null;
const regular=async file=>{
 const st=await fs.lstat(file);
 if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_FILE_BYTES)
   throw new Error(path.basename(file)+' must be a regular Markdown file smaller than 24 KB.');
 const handle=await fs.open(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{return (await handle.readFile('utf8')).trim();}
 finally{await handle.close();}
};
export async function initializeStartupContext(settings) {
 // Reset on reload, so an old snapshot cannot silently masquerade as current.
 snapshot=null;
 const root=await memoryRoot(settings);
 const memoryFile=path.join(root,'Persistent memory.md');
 let persistent;
 try { persistent=await regular(memoryFile); }
 catch(e){
  if(e.code==='ENOENT')throw new Error(
    'Aegis not ready: create ~/Documents/Obsidian/aegis/Persistent memory.md locally (it may be empty). No file was created automatically.');
  throw e;
 }
 // User can choose not to supply a separate conversation prompt.
 let prompt='';
 try{prompt=await regular(path.join(root,'System Prompt.md'));}
 catch(e){if(e.code!=='ENOENT')throw e;}
 if(prompt.length>MAX_PROMPT_CHARS)
   throw new Error('System Prompt.md is too long for a 3B model. Keep it below 3,800 characters.');
 snapshot=Object.freeze({
   systemPrompt:prompt,
   persistentMemory:persistent,
   loadedAt:new Date().toISOString(),
   promptLoaded:Boolean(prompt),
   memoryLoaded:true,
   memoryCharacters:persistent.length
 });
 return {...snapshot,systemPrompt:undefined,persistentMemory:undefined};
}
export const getStartupContext=()=>snapshot;
export function requiredStartupContext() {
 if(!snapshot) throw new Error('Aegis not ready: startup context has not been loaded.');
 return snapshot;
}
function relevantLines(text,question,maxChars) {
 if(!text)return '';
 if(text.length<=maxChars)return text;
 const ignored=new Set(['have','what','when','where','that','this','about','with','from','your','aegis','would','could','which','them','then','there','please']);
 const terms=[...new Set((question.toLowerCase().match(/[a-z0-9à-ÿ]{4,}/g)||[]).filter(x=>!ignored.has(x)))].slice(0,15);
 const lines=text.split('\n').map((line,index)=>({line,index,score:terms.reduce((n,x)=>n+(line.toLowerCase().includes(x)?1:0),0)}));
 const selected=lines.filter(x=>x.score>0).sort((a,b)=>b.score-a.score).slice(0,12).sort((a,b)=>a.index-b.index);
 const context=selected.map(x=>x.line).join('\n');
 return (context||text.slice(0,Math.min(450,maxChars))).slice(0,maxChars);
}
export function currentPersonalContext(question,maxChars=1200) {
 return relevantLines(requiredStartupContext().persistentMemory,String(question||''),maxChars);
}
