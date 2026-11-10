// Read-only deterministic Git / GitHub workflow inspection. No arbitrary shell.
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {expandHome,inUserHome} from './store.mjs';

const exec=promisify(execFile);
const ACTIONS=Object.freeze({
 git_status:'status',git_log:'log',git_diff:'diff',
 git_branches:'branches',github_prs:'prs',github_checks:'checks'
});
export function developerIntent(raw) {
 const s=String(raw||'').trim();
 let m=/^(?:please\s+)?(?:git (status|log|diff|branches)|github (?:pull requests|prs|checks|ci))\s*(?:in|for|:)\s*(.+)$/i.exec(s);
 if(!m)return null;
 const action=m[1]?.toLowerCase() || (/checks|ci/i.test(s)?'checks':'prs');
 const map={status:'git_status',log:'git_log',diff:'git_diff',branches:'git_branches',
   prs:'github_prs',checks:'github_checks'};
 return {intent:map[action],args:{repository:m[2].trim()}};
}
export function validateDeveloperArgs(intent,raw) {
 if(!Object.hasOwn(ACTIONS,intent))throw new Error('Unsupported Git operation.');
 const input=raw?.repository;
 if(typeof input!=='string'||!input.trim()||input.length>420||/[\u0000-\u001f]/.test(input))
   throw new Error('Specify the local repository directory.');
 const root=path.resolve(expandHome(input.trim()));
 if(!inUserHome(root))throw new Error('Repository must be inside the user home.');
 return {repository:root};
}
async function localRepo(input) {
 const real=await fs.realpath(input);
 if(!inUserHome(real))throw new Error('Repository symlink escapes the user home.');
 const out=await exec('git',['-c','core.fsmonitor=false','-C',real,'rev-parse','--show-toplevel'],
   {timeout:6000,maxBuffer:30000});
 const top=await fs.realpath(out.stdout.trim());
 if(!inUserHome(top))throw new Error('Resolved repository is outside the user home.');
 return top;
}
export async function executeDeveloper(intent,raw) {
 const p=validateDeveloperArgs(intent,raw),repo=await localRepo(p.repository);
 const commands={
  git_status:['git',['-c','core.fsmonitor=false','-C',repo,'status','--short','--branch','--untracked-files=normal']],
  git_log:['git',['-C',repo,'log','-12','--format=%h %ad %s','--date=short']],
  git_diff:['git',['-C',repo,'diff','--no-ext-diff','--stat','--','.',':(exclude)node_modules']],
  git_branches:['git',['-C',repo,'branch','--list','--no-color']],
  github_prs:['gh',['pr','list','--repo',repo,'--limit','12']],
  github_checks:['gh',['run','list','--limit','12']]
 };
 const [bin,args]=commands[intent];
 const safeArgs=bin==='gh' ? (intent==='github_prs'?
   ['pr','list','--limit','12'] : args) : args;
 let result;
 try{result=await exec(bin,safeArgs,{cwd:repo,timeout:12000,maxBuffer:90000,
   env:{...process.env,GIT_OPTIONAL_LOCKS:'0',GIT_CONFIG_NOSYSTEM:'1'}});}
 catch(e){if(e.code==='ENOENT')throw new Error(bin+' is not installed.');throw new Error((e.stderr||e.message).slice(0,400));}
 return {text:'Read-only '+intent+' in '+repo+':\n'+(result.stdout.trim().slice(0,12000)||'(no output)'),details:{repository:repo}};
}
