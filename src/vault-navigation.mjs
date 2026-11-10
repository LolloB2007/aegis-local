// Bounded, read-only Obsidian graph exploration for Aegis v2.1.
import fs from 'node:fs/promises';
import path from 'node:path';
import {expandHome,inUserHome} from './store.mjs';
import {requireVaultPolicy} from './vault-policy.mjs';

export function vaultNavigationIntent(raw) {
  const s=String(raw||'').trim();let m;
  if((m=/^(?:please\s+)?(?:show|find|list)\s+(?:my\s+)?vault\s+backlinks\s*:\s*(.+)$/i.exec(s)))
    return {intent:'vault_backlinks',args:{path:m[1]}};
  if((m=/^(?:please\s+)?(?:show|find|list)\s+(?:my\s+)?vault\s+(?:links|outgoing links)\s*:\s*(.+)$/i.exec(s)))
    return {intent:'vault_outlinks',args:{path:m[1]}};
  if(/^(?:please\s+)?(?:show|find|list)\s+(?:all\s+)?(?:open\s+)?(?:my\s+)?vault\s+tasks\s*$/i.test(s))
    return {intent:'vault_tasks',args:{}};
  return null;
}
export function validateVaultNavigationArgs(intent,p) {
  if(!['vault_backlinks','vault_outlinks','vault_tasks'].includes(intent))throw new Error('Unsupported vault navigation tool.');
  if(intent==='vault_tasks')return {};
  const value=p?.path;
  if(typeof value!=='string'||value.length>240||!value.trim()||path.isAbsolute(value)||
    value.includes('\\')||value.split('/').some(x=>x==='..'||x.startsWith('.')))
    throw new Error('Specify a normal vault-relative Markdown path.');
  return {path:value.trim()};
}
async function getVault(settings) {
  return (await requireVaultPolicy(settings)).root;
}
async function allMarkdown(root) {
  const files=[];const until=Date.now()+5000;
  async function visit(directory,depth) {
    if(files.length>=3000||Date.now()>until||depth>10)return;
    let contents;try{contents=await fs.readdir(directory,{withFileTypes:true});}catch{return;}
    for(const item of contents) {
      if(item.name.startsWith('.')||item.isSymbolicLink())continue;
      const full=path.join(directory,item.name);
      if(item.isDirectory())await visit(full,depth+1);
      else if(item.isFile()&&item.name.endsWith('.md'))files.push(path.relative(root,full).split(path.sep).join('/'));
      if(files.length>=3000||Date.now()>until)break;
    }
  }
  await visit(root,0);return files;
}
const normalize=link=>link.split('|')[0].split('#')[0].trim()
  .replace(/\.md$/i,'').replaceAll('\\','/').toLowerCase();
function wikilinks(body) {
  const result=[];let m;const regex=/\[\[([^\]\n]{1,300})\]\]/g;
  while((m=regex.exec(body))&&result.length<250) result.push(m[1]);
  return result;
}
const stem=p=>p.replace(/\.md$/i,'').toLowerCase();
export async function executeVaultNavigation(intent,raw,settings) {
  const p=validateVaultNavigationArgs(intent,raw),root=await getVault(settings),files=await allMarkdown(root);
  if(intent==='vault_tasks') {
    const tasks=[];
    for(const relative of files) {
      if(tasks.length>=80)break;
      const file=path.join(root,relative);
      try {
        const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>180000)continue;
        const body=await fs.readFile(file,'utf8');
        for(const [index,line] of body.split('\n').entries()) {
          if(/^\s*[-*]\s+\[\s\]/.test(line)) tasks.push({path:relative,line:index+1,text:line.trim().slice(0,200)});
          if(tasks.length>=80)break;
        }
      }catch{/* unsupported or changed note */}
    }
    return {text:tasks.length?tasks.map(t=>t.path+':'+t.line+' '+t.text).join('\n'):'No open Markdown checkboxes found in the scanned vault files.',details:{scanned:files.length,tasks}};
  }
  const exactPath=p.path.endsWith('.md')?p.path:p.path+'.md';
  const relative=files.find(f=>f.toLowerCase()===exactPath.toLowerCase());
  if(!relative)throw new Error('No matching Markdown note exists; specify an exact vault-relative path.');
  const target=stem(relative),targetBasename=path.posix.basename(target);
  if(intent==='vault_outlinks') {
    const body=await fs.readFile(path.join(root,relative),'utf8');
    return {text:'Outgoing links from '+relative+':\n'+(wikilinks(body).slice(0,60).map(t=>'• '+t).join('\n')||'(none)'),details:{path:relative}};
  }
  const matches=[];
  for(const candidate of files) {
    if(candidate===relative||matches.length>=60)continue;
    try{
      const file=path.join(root,candidate),st=await fs.lstat(file);
      if(st.size>180000||!st.isFile()||st.isSymbolicLink())continue;
      const body=await fs.readFile(file,'utf8');
      const hit=wikilinks(body).some(link=>{
        const linked=normalize(link);
        return linked===target || linked===targetBasename;
      });
      if(hit)matches.push(candidate);
    }catch{/* disappearing file */}
  }
  return {text:'Backlinks to '+relative+':\n'+(matches.map(x=>'• '+x).join('\n')||'(none)'),details:{path:relative,matches}};
}
