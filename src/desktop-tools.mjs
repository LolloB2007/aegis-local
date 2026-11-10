// v1.4 desktop tools. No model output is evaluated as a command or AppleScript.
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {expandHome, inUserHome} from './store.mjs';
import {APP_CHOICES} from './intent.mjs';

const executeFile = promisify(execFile);
const READ = ['running_apps','network_status','volume_get','brightness_get','system_diagnostic'];
export const DESKTOP_MUTATIONS = new Set(['app_quit','email_draft','email_send','file_move','file_trash','folder_organize','volume_set','brightness_set']);
export const DESKTOP_READ = new Set(READ);
export const DESKTOP_PLANNED = new Set(['app_quit','email_draft','email_send','file_move','file_trash','folder_organize','volume_set','brightness_set','system_diagnostic']);

export function desktopIntent(input) {
 const s = String(input||'').trim().toLowerCase().replace(/^please\s+/,'');
 if (/^(?:show|list|what(?:'s| is))\s+(?:the\s+)?(?:running|open)\s+(?:apps?|applications?)\b|^what apps are running/.test(s)) return 'running_apps';
 if (/^(?:quit|close|exit)\s+(?:the\s+)?(?:app(?:lication)?\s+)?[\w ]{2,60}$/.test(s)) return 'app_quit';
 if (/^(?:draft|compose|write)\s+(?:an?\s+)?(?:email|mail)\s+to\b/.test(s)) return 'email_draft';
 if (/^send\s+(?:an?\s+)?(?:email|mail)\s+to\b/.test(s)) return 'email_send';
 if (/^(?:delete|trash|remove)\s+(?:the\s+)?(?:file\s+|document\s+|download\s+).+|^move\s+(?:the\s+)?(?:file\s+)?.+\s+to\s+(?:the\s+)?trash$/.test(s)) return 'file_trash';
 if (/^(?:tidy|organize|reorganize|sort)\s+(?:up\s+)?(?:my\s+|the\s+)?(?:desktop|downloads|documents|folder\b|files\s+in\b)/.test(s)) return 'folder_organize';
 if (/^move\s+(?:the\s+)?(?:file\s+|document\s+).+\s+to\b/.test(s)) return 'file_move';
 if (/^(?:what(?:'s| is)\s+(?:my\s+)?(?:wifi|wi-fi|network|ip address)|(?:show|check|get)\s+(?:my\s+)?(?:wifi|wi-fi|network)(?:\s+status|\s+info)?)/.test(s)) return 'network_status';
 if (/^(?:what(?:'s| is)\s+(?:the\s+)?(?:volume|sound level)|(?:get|check|show)\s+(?:the\s+)?(?:system\s+)?volume)/.test(s)) return 'volume_get';
 if (/^(?:set|change|adjust|turn)\s+(?:the\s+)?(?:system\s+)?volume\s+(?:to|at)\b/.test(s)) return 'volume_set';
 if (/^(?:what(?:'s| is)\s+(?:the\s+)?(?:screen\s+)?brightness|(?:get|check|show)\s+(?:the\s+)?(?:screen\s+)?brightness)/.test(s)) return 'brightness_get';
 if (/^(?:set|change|adjust|turn)\s+(?:the\s+)?(?:screen\s+)?brightness\s+(?:to|at)\b/.test(s)) return 'brightness_set';
 if (/^(?:run|show|check)\s+(?:a\s+)?(?:system\s+)?(?:diagnostic|disk space|memory (?:diagnostic|report|pressure)|uptime|top processes)\b/.test(s)) return 'system_diagnostic';
 return null;
}

export const DESKTOP_SCHEMAS = Object.freeze({
 app_quit:{app:'An exact allowlisted app key, such as safari, chrome, spotify, slack, outlook'},
 email_draft:{to:'One recipient email address',subject:'Email subject',body:'Complete email body'},
 email_send:{to:'One recipient email address',subject:'Email subject',body:'Complete email body'},
 file_trash:{path:'Existing full path, or ~/Desktop/file, ~/Downloads/file, ~/Documents/file. Files only, never a directory.'},
 file_move:{path:'Existing file path',destination:'Existing target directory path, under ~/Desktop, ~/Documents, or ~/Downloads'},
 folder_organize:{folder:'One of Desktop, Downloads, Documents; full home path also accepted'},
 volume_set:{level:'Integer percentage 0 to 100'},
 brightness_set:{level:'Integer percentage 0 to 100'},
 system_diagnostic:{kind:'Choose exactly one: disk_free, uptime, processes, memory'}
});

function stringArg(value,label,max=1000) {
 if(typeof value!=='string') throw new Error(label+' must be text.');
 const s=value.trim();
 if(!s||s.length>max||Array.from(s).some(c=>c.charCodeAt(0)<32)) throw new Error('Invalid '+label+'.');
 return s;
}
function percent(value) {
 const n=typeof value==='string'&&/^\d{1,3}$/.test(value.trim())?Number(value):value;
 if(!Number.isInteger(n)||n<0||n>100) throw new Error('Percentage must be an integer between 0 and 100.');
 return n;
}
function mailArgs(p){
 const to=stringArg(p.to,'recipient',254).toLowerCase();
 if(!/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(to)) throw new Error('Specify a single valid recipient.');
 return {to,subject:stringArg(p.subject,'subject',180),body:stringArg(p.body,'body',10000)};
}
const HOME=()=>expandHome('~');
const within=(base,child)=>child===base||child.startsWith(base+path.sep);
const PROTECTED=new Set(['.git','.obsidian','.trash','library','applications','.ssh','.config']);
function cleanPath(raw,label){
 const entered=stringArg(raw,label,700);
 if(!entered.startsWith('~/')&&!path.isAbsolute(entered))throw new Error(label+' must be a full path or start with ~/.');
 const candidate=path.resolve(expandHome(entered));
 if(!inUserHome(candidate))throw new Error(label+' is outside your home folder.');
 const parts=path.relative(HOME(),candidate).split(path.sep);
 if(parts.some(p=>!p||p==='..'||p.startsWith('.')||PROTECTED.has(p.toLowerCase())))throw new Error('Hidden/system folders are protected.');
 if(!['Desktop','Documents','Downloads'].includes(parts[0])||parts.length<1)throw new Error('File tools only handle Desktop, Documents, or Downloads.');
 return candidate;
}
async function protectedVault(real,settings){
 for(const configuredName of [settings.vaultRoot||'~/Documents/Obsidian/claude',
                                settings.memoryRoot||'~/Documents/Obsidian/aegis']){
   const configured=path.resolve(expandHome(configuredName));
   const actual=await fs.realpath(configured).catch(()=>configured);
   if(within(configured,real)||within(actual,real))
     throw new Error('Vault files are protected, including Aegis memory notes. Use dedicated tools.');
 }
}
async function safeExisting(raw,settings,{directory=false}={}){
 const requested=cleanPath(raw,directory?'folder':'file');
 const actual=await fs.realpath(requested);
 if(!inUserHome(actual))throw new Error('Symlink escapes your home folder.');
 if(!['Desktop','Documents','Downloads'].some(name=>within(path.join(HOME(),name),actual)))throw new Error('Resolved path is outside approved folders.');
 await protectedVault(actual,settings);
 const st=await fs.lstat(requested);
 if(st.isSymbolicLink() || (directory ? !st.isDirectory() : !st.isFile()))throw new Error(directory?'Expected a directory.':'Expected a regular file; links and folders are not supported.');
 if(st.uid!==undefined&&process.getuid&&st.uid!==process.getuid())throw new Error('Only your own files can be modified.');
 return {path:actual,size:st.size,mtimeMs:st.mtimeMs};
}
function noCollision(dest){return fs.access(dest).then(()=>{throw new Error('Target already exists: '+dest);},e=>{if(e.code!=='ENOENT')throw e;});}
export function validateDesktopArgs(intent,raw) {
 const p=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
 switch(intent){
 case 'running_apps':case 'network_status':case 'volume_get':case 'brightness_get':return {};
 case 'app_quit': {
  const app=stringArg(p.app,'app',70).toLowerCase().replace(/\s+/g,'');
  if(!Object.hasOwn(APP_CHOICES,app))throw new Error('Application is not on the allowlist.');
  return {app};
 }
 case 'email_draft':case 'email_send':return mailArgs(p);
 case 'file_trash':return {path:cleanPath(p.path,'file')};
 case 'file_move':return {path:cleanPath(p.path,'file'),destination:cleanPath(p.destination,'destination')};
 case 'folder_organize': {
   const name=stringArg(p.folder,'folder',700);
   const folder=['desktop','downloads','documents'].includes(name.toLowerCase())?path.join(HOME(),name[0].toUpperCase()+name.slice(1).toLowerCase()):cleanPath(name,'folder');
   const allowed=['Desktop','Downloads','Documents'].map(n=>path.join(HOME(),n));
   if(!allowed.includes(folder))throw new Error('Bulk organization is restricted to top-level Desktop, Downloads, or Documents.');
   const result={folder};
   if(p.previewItems!==undefined){
     if(!Array.isArray(p.previewItems)||p.previewItems.length>30||p.previewItems.some(x=>typeof x?.name!=='string'||typeof x?.category!=='string'||!Number.isFinite(x?.mtimeMs)||!Number.isFinite(x?.size)))throw new Error('Invalid approved file preview.');
     result.previewItems=p.previewItems.map(x=>({name:x.name,category:x.category,mtimeMs:x.mtimeMs,size:x.size}));
   }
   return result;
 }
 case 'volume_set':case 'brightness_set':return {level:percent(p.level)};
 case 'system_diagnostic':{
   const kind=stringArg(p.kind,'diagnostic',40);
   if(!['disk_free','uptime','processes','memory'].includes(kind))throw new Error('Unsupported diagnostic. Use disk_free, uptime, processes or memory.');
   return {kind};
 }
 default:throw new Error('Unsupported desktop tool.');
 }
}
const types=Object.freeze({
 Images:new Set(['.png','.jpg','.jpeg','.gif','.heic','.webp','.tiff','.svg']),
 Documents:new Set(['.pdf','.doc','.docx','.txt','.md','.rtf','.pages','.xls','.xlsx','.csv','.ppt','.pptx','.key']),
 Archives:new Set(['.zip','.rar','.7z','.tar','.gz','.dmg','.pkg']),
 Audio:new Set(['.mp3','.wav','.m4a','.flac','.aac']),
 Video:new Set(['.mov','.mp4','.mkv','.avi','.webm']),
 Code:new Set(['.py','.js','.ts','.tsx','.json','.html','.css','.sh','.ipynb'])
});
function category(name) {
 const ext=path.extname(name).toLowerCase();
 return Object.keys(types).find(key=>types[key].has(ext))||'Other';
}
async function organizePlan(folder,settings){
 await safeExisting(folder,settings,{directory:true});
 const entries=await fs.readdir(folder,{withFileTypes:true});
 const files=entries.filter(e=>e.isFile()&&!e.isSymbolicLink()&&!e.name.startsWith('.')).sort((a,b)=>a.name.localeCompare(b.name));
 if(files.length>30)throw new Error('More than 30 loose files. Organize in smaller batches to review the moves.');
 const plans=[];
 for(const e of files) {
   const source=await safeExisting(path.join(folder,e.name),settings);
   plans.push({name:e.name,category:category(e.name),mtimeMs:source.mtimeMs,size:source.size});
 }
 return plans;
}
export async function previewDesktop(intent,p,settings){
 switch(intent){
 case 'folder_organize':{
   const items=await organizePlan(p.folder,settings);
   return {args:{...p,previewItems:items},summary:`Organize ${items.length} loose files in ${p.folder}:\n${items.map(x=>`- ${x.name} -> ${x.category}/`).join('\n')||'(none)'}\nNothing in subfolders will be changed.`};
 }
 case 'file_trash':await safeExisting(p.path,settings);return {args:p,summary:`Move the file to macOS Trash (recoverable):\n${p.path}`};
 case 'file_move':{
   await safeExisting(p.path,settings);
   await safeExisting(p.destination,settings,{directory:true});
   if(path.dirname(p.path)===p.destination)throw new Error('File is already in that folder.');
   await noCollision(path.join(p.destination,path.basename(p.path)));
   return {args:p,summary:`Move file:\n${p.path}\nTo: ${p.destination}/`};
 }
 case 'email_send':return {args:p,summary:`SEND email via Apple Mail (external communication)\nTo: ${p.to}\nSubject: ${p.subject}\n\n${p.body}`};
 case 'email_draft':return {args:p,summary:`Create an UNSENT draft in Apple Mail\nTo: ${p.to}\nSubject: ${p.subject}\n\n${p.body}`};
 case 'app_quit':return {args:p,summary:`Quit ${APP_CHOICES[p.app]}. Unsaved work in that application may be lost.`};
 case 'volume_set':return {args:p,summary:`Change speaker output volume to ${p.level}%.`};
 case 'brightness_set':return {args:p,summary:`Change display brightness to ${p.level}% (requires the brightness CLI).`};
 default:throw new Error('Preview is not available for this tool.');
 }
}
async function cmd(bin,args,timeout=14000){
 if(process.env.AEGIS_DRY_RUN==='1')return '[dry-run: no macOS change]';
 if(process.platform!=='darwin')throw new Error('This integration requires macOS.');
 try {const {stdout}=await executeFile(bin,args,{timeout,maxBuffer:120000});return stdout.trim().slice(0,18000);}
 catch(e){if(e.code==='ENOENT')throw new Error(`Required macOS executable unavailable: ${bin}.`);throw new Error((e.stderr||e.message||'Command failed').slice(0,650));}
}
const SCRIPT_MAIL=`on run argv
set addr to item 1 of argv
set subjectText to item 2 of argv
set messageText to item 3 of argv
set doSend to item 4 of argv
tell application "Mail"
 set outgoing to make new outgoing message with properties {subject:subjectText, content:messageText, visible:(doSend is "false")}
 tell outgoing
  make new to recipient at end of to recipients with properties {address:addr}
 end tell
 if doSend is "true" then
  send outgoing
 else
  activate
 end if
end tell
if doSend is "true" then return "Email sent via Apple Mail." 
return "Draft created in Apple Mail, not sent."
end run`;
const SCRIPT_QUIT=`function run(argv) { Application(argv[0]).quit(); return 'Quit '+argv[0]; }`;
async function fileMove(p,settings){
 const from=await safeExisting(p.path,settings);
 const destination=await safeExisting(p.destination,settings,{directory:true});
 const to=path.join(destination.path,path.basename(from.path));
 await noCollision(to);
 if(process.env.AEGIS_DRY_RUN==='1')return {text:`[dry-run] Would move ${from.path} to ${to}`};
 await fs.copyFile(from.path,to,fs.constants.COPYFILE_EXCL);
 await fs.unlink(from.path);
 return {text:`Moved ${from.path} to ${to}`,details:{from:from.path,to}};
}
async function fileTrash(p,settings){
 const from=await safeExisting(p.path,settings);
 if(process.env.AEGIS_DRY_RUN==='1')return {text:`[dry-run] Would trash ${from.path}`};
 const trash=path.join(HOME(),'.Trash');
 await fs.mkdir(trash,{recursive:true,mode:0o700});
 const real=await fs.realpath(trash);
 if(!within(HOME(),real))throw new Error('Trash directory cannot point outside home.');
 const dest=path.join(real,`${path.basename(from.path)}.aegis-${randomUUID()}`);
 await fs.rename(from.path,dest);
 return {text:`Moved ${from.path} to macOS Trash (recoverable).`,details:{trashedPath:dest}};
}
async function organize(p,settings){
 if(!p.previewItems)throw new Error('Preview is required before organizing files.');
 const current=await organizePlan(p.folder,settings);
 const snapshot=JSON.stringify(p.previewItems);
 if(JSON.stringify(current)!==snapshot)throw new Error('Folder changed since approval. Preview and confirm again.');
 if(process.env.AEGIS_DRY_RUN==='1')return {text:`[dry-run] Would organize ${current.length} files.`};
 const results=[];
 for(const item of current){
   const from=path.join(p.folder,item.name);
   const original=await safeExisting(from,settings);
   if(original.size!==item.size||original.mtimeMs!==item.mtimeMs)throw new Error('File changed during organization; stopped.');
   const target=path.join(p.folder,item.category);
   await fs.mkdir(target,{recursive:true});
   const actual=await safeExisting(target,settings,{directory:true});
   const to=path.join(actual.path,item.name);
   await noCollision(to);
   await fs.copyFile(from,to,fs.constants.COPYFILE_EXCL);
   await fs.unlink(from);
   results.push(`${item.name} -> ${item.category}/`);
 }
 return {text:`Organized ${results.length} files:\n${results.join('\n')}`,details:{moved:results.length}};
}
export async function executeDesktop(intent,p,settings){
 if(!DESKTOP_READ.has(intent)&&!DESKTOP_MUTATIONS.has(intent))throw new Error('Desktop tool not allowed.');
 switch(intent){
 case 'running_apps':return {text:await cmd('/usr/bin/osascript',['-l','JavaScript','-e',"function run(){return Application('System Events').applicationProcesses.whose({backgroundOnly:false})().map(x=>x.name()).slice(0,50).join('\\n');}"])};
 case 'network_status': {
   const network=await cmd('/usr/sbin/scutil',['--nwi']);
   let wifi='Wi-Fi name unavailable';
   let ip='IP address unavailable';
   try { wifi=await cmd('/usr/sbin/networksetup',['-getairportnetwork','en0']); } catch {}
   try { ip=await cmd('/usr/sbin/ipconfig',['getifaddr','en0']); } catch {}
   return {text:`Network: ${network}\nWi-Fi: ${wifi}\nLocal en0 IP: ${ip}`};
 }
 case 'volume_get':return {text:await cmd('/usr/bin/osascript',['-e','output volume of (get volume settings) as text'])};
 case 'volume_set':return {text:await cmd('/usr/bin/osascript',['-e','on run argv\nset volume output volume ((item 1 of argv) as integer)\nreturn output volume of (get volume settings) as text\nend run',String(p.level)])};
 case 'brightness_get':return {text:await cmd('brightness',['-l'])};
 case 'brightness_set':return {text:await cmd('brightness',[String(p.level/100)])};
 case 'app_quit':return {text:await cmd('/usr/bin/osascript',['-l','JavaScript','-e',SCRIPT_QUIT,APP_CHOICES[p.app]])};
 case 'email_draft':case 'email_send':return {text:await cmd('/usr/bin/osascript',['-e',SCRIPT_MAIL,p.to,p.subject,p.body,String(intent==='email_send')],25000)};
 case 'file_move':return fileMove(p,settings);
 case 'file_trash':return fileTrash(p,settings);
 case 'folder_organize':return organize(p,settings);
 case 'system_diagnostic':{
  const map={
    disk_free:['/bin/df',['-h']],
    uptime:['/usr/bin/uptime',[]],
    processes:['/bin/ps',['-Ao','pid,comm,%cpu,%mem']],
    memory:['/usr/bin/memory_pressure',[]]
  };
  const [bin,args]=map[p.kind];
  return {text:await cmd(bin,args)};
 }
 default:throw new Error('Desktop tool not implemented.');
 }
}
