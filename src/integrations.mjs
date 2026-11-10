import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expandHome, inUserHome } from './store.mjs';

// Neither Kev nor the text model may supply executable commands or tool names.
const exec = promisify(execFile);
const MAX_RESPONSE = 24000;
const READ = new Set(['vault_list','vault_read','vault_search','calendar_list','clipboard_read','battery_status']);
export const MUTATING_ACTIONS = new Set(['calendar_create','reminder_create','clipboard_write']);
export const PLANNED_ACTIONS = new Set(['vault_list','vault_read','vault_search','calendar_list','calendar_create','reminder_create','clipboard_write']);

export function explicitIntegrationIntent(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (/^(?:please\s+)?(?:open|launch|start)\s+(?:the\s+)?(?:calendar|obsidian)\s*$/.test(s)) return null;
  if (/^(?:please\s+)?(?:create|add|schedule|book|put|set up)\s+(?:an?\s+)?(?:new\s+)?(?:event|meeting|appointment|call|calendar entry|lunch|dinner)\b/.test(s) || /^(?:please\s+)?schedule\s+.+/.test(s)) return 'calendar_create';
  if (/^(?:please\s+)?(?:create|add|schedule|book)\s+(?:an?\s+)?(?:new\s+)?calendar\s+event\b/.test(s)) return 'calendar_create';
  if (/^(?:please\s+)?(?:read|show|summarize|display)\s+.+\b(?:my\s+)?(?:vault|obsidian)\b/.test(s)) return 'vault_read';
  if (/^(?:please\s+)?(?:remind me to|add (?:a )?reminder|create (?:a )?reminder|set (?:a )?reminder)\b/.test(s)) return 'reminder_create';
  if (/^(?:please\s+)?(?:what(?:'s| is) on (?:my |the )?calendar|list (?:my )?calendar|show (?:my )?(?:upcoming )?calendar events|show (?:my )?schedule)\b/.test(s)) return 'calendar_list';
  if (/^(?:please\s+)?(?:list|browse|show|explore)\s+.+\b(vault|obsidian)\b/.test(s) || /^(?:please\s+)?(?:list|browse|show)\s+(?:the\s+)?(?:vault|obsidian notes|vault folders)\b/.test(s)) return 'vault_list';
  if (/^(?:please\s+)?(?:read|show|open|display|summarize)\s+.+\b(vault note|obsidian note|from (?:my |the )?vault)\b/.test(s)) return 'vault_read';
  if (/^(?:please\s+)?(?:search|find|look for|grep)\s+.+\b(vault|obsidian)\b/.test(s) || /^(?:please\s+)?(?:search|find)\s+(?:my\s+)?vault\b/.test(s)) return 'vault_search';
  if (/^(?:please\s+)?(?:read|show|what(?:'s| is) in|paste)\s+(?:the\s+|my\s+)?clipboard\b/.test(s)) return 'clipboard_read';
  if (/^(?:please\s+)?(?:copy|put|write)\s+.+\s+(?:to|into)\s+(?:the\s+|my\s+)?clipboard\b/.test(s)) return 'clipboard_write';
  if (/^(?:please\s+)?(?:what(?:'s| is) (?:my |the )?battery(?: level| status)?|check (?:my |the )?battery|battery status)\b/.test(s)) return 'battery_status';
  return null;
}
export function toolSchema(intent) {
  return ({
    vault_list: {folder:'Vault-relative folder path, empty string for root'},
    vault_read: {path:'Exact vault-relative Markdown .md path'},
    vault_search: {query:'Literal words to search inside vault Markdown'},
    calendar_list: {from:'ISO8601 timestamp with timezone',to:'ISO8601 timestamp with timezone',calendar:'Exact calendar name or empty for all'},
    calendar_create: {title:'Event title',start:'ISO8601 timestamp with timezone',end:'ISO8601 timestamp with timezone',calendar:'Exact calendar name or empty',notes:'Optional event notes'},
    reminder_create: {title:'Reminder text',due:'Optional ISO8601 timestamp with timezone',list:'Exact reminders list name or empty'},
    clipboard_write: {text:'Exact text to copy to clipboard'}
  })[intent] || null;
}
function boundedText(value, limit, label, required=true) {
  if(typeof value !== 'string') throw new Error(`${label} must be text.`);
  const s=value.trim();
  if((required && !s)||s.length>limit||/[\u0000-\u0008\u000b\u000e-\u001f]/.test(s)) throw new Error(`Invalid ${label}.`);
  return s;
}
function isoDate(value,label,optional=false) {
  if(optional && !value) return '';
  const s=boundedText(value,50,label);
  if(!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.test(s)||!Number.isFinite(Date.parse(s))) throw new Error(`${label} requires ISO8601 and an explicit timezone.`);
  return s;
}
export function validateIntegrationArgs(intent,raw,settings,now=Date.now()) {
  const p=raw&&typeof raw==='object'&&!Array.isArray(raw)?raw:{};
  switch(intent){
    case 'vault_list': return {folder:boundedText(p.folder??'',240,'vault folder',false)};
    case 'vault_read': return {path:boundedText(p.path??'',240,'vault path')};
    case 'vault_search': return {query:boundedText(p.query??'',100,'search phrase')};
    case 'calendar_list': {
      const from=isoDate(p.from,'range start'),to=isoDate(p.to,'range end');
      if(Date.parse(to)<=Date.parse(from)||Date.parse(to)-Date.parse(from)>31*86400000) throw new Error('Calendar range must be between 1 minute and 31 days.');
      return {from,to,calendar:boundedText(p.calendar??'',100,'calendar name',false)};
    }
    case 'calendar_create': {
      const title=boundedText(p.title??'',160,'event title'),start=isoDate(p.start,'event start'),end=isoDate(p.end,'event end');
      const a=Date.parse(start),b=Date.parse(end);
      if(a<now-3600000||a>now+366*86400000||b-a<60000||b-a>24*3600000) throw new Error('Events must start within the next year and last 1 minute to 24 hours.');
      const calendar=boundedText(p.calendar||settings.calendarName||'',100,'calendar name',false);
      if(!calendar) throw new Error('Which calendar? Specify its exact name (e.g. "on Personal calendar") or set calendarName in settings.');
      return {title,start,end,calendar,notes:boundedText(p.notes??'',2000,'event notes',false)};
    }
    case 'reminder_create': {
      const title=boundedText(p.title??'',240,'reminder title'),due=isoDate(p.due??'','due time',true);
      const list=boundedText(p.list||settings.reminderListName||'',100,'reminders list',false);
      if(!list) throw new Error('Which Reminders list? Specify its exact name or set reminderListName.');
      return {title,due,list};
    }
    case 'clipboard_write': return {text:boundedText(p.text??'',5000,'clipboard content')};
    case 'clipboard_read':case 'battery_status': return {};
    default:throw new Error('Unsupported integration tool.');
  }
}
function within(root, target){return target===root||target.startsWith(root+path.sep);}
async function vaultPath(settings, relative=''){
  const root=expandHome(settings.vaultRoot);
  if(!inUserHome(root)) throw new Error('Vault must be inside your home.');
  const base=await fs.realpath(root);
  if(typeof relative!=='string'||path.isAbsolute(relative)||relative.includes('\\')||relative.includes('\0')) throw new Error('Use a vault-relative path.');
  const cleaned=relative.replace(/^\.\//,'').replace(/\/$/,'');
  if(cleaned.split('/').some(part=>part==='..'||part.startsWith('.'))) throw new Error('Hidden and parent paths are prohibited.');
  const candidate=path.resolve(base,cleaned||'.');
  if(!within(base,candidate)) throw new Error('Path escapes vault root.');
  const actual=await fs.realpath(candidate);
  if(!within(base,actual)) throw new Error('Symlink points outside the vault.');
  return {root:base,file:actual};
}
function rel(root,p){return path.relative(root,p).split(path.sep).join('/')||'.';}
async function vaultList(settings,{folder}){
  const {root,file}=await vaultPath(settings,folder);
  const entries=await fs.readdir(file,{withFileTypes:true});
  const visible=entries.filter(e=>!e.name.startsWith('.')&&!e.isSymbolicLink()).sort((a,b)=>Number(b.isDirectory())-Number(a.isDirectory())||a.name.localeCompare(b.name)).slice(0,80);
  return {text:`Vault: ${rel(root,file)}\n${visible.map(e=>`${e.isDirectory()?'[folder]':'[file]'} ${e.name}`).join('\n')||'(empty)'}`,details:{folder:rel(root,file),count:visible.length}};
}
async function vaultRead(settings,{path:p}){
  const {root,file}=await vaultPath(settings,p);
  if(path.extname(file).toLowerCase()!=='.md') throw new Error('Vault reads support Markdown only.');
  const st=await fs.stat(file);
  if(!st.isFile()||st.size>300000) throw new Error('Markdown note is too large or not a regular file.');
  const body=await fs.readFile(file,'utf8'),excerpt=body.slice(0,MAX_RESPONSE);
  return {text:`Vault note: ${rel(root,file)}\n\n${excerpt}${body.length>MAX_RESPONSE?'\n\n[Truncated]':''}`,details:{path:rel(root,file),truncated:body.length>MAX_RESPONSE}};
}
async function vaultSearch(settings,{query}){
  const {root}=await vaultPath(settings);
  const found=[];let scanned=0;const end=Date.now()+4000;
  async function visit(folder,depth){
    if(depth>9||scanned>4000||found.length>=20||Date.now()>end) return;
    let entries;try{entries=await fs.readdir(folder,{withFileTypes:true});}catch{return;}
    for(const e of entries){
      if(Date.now()>end||found.length>=20||scanned>4000) break;
      if(e.name.startsWith('.')||e.isSymbolicLink()||['node_modules','_trash'].includes(e.name)) continue;
      const full=path.join(folder,e.name);
      if(e.isDirectory()) await visit(full,depth+1);
      else if(e.isFile()&&e.name.toLowerCase().endsWith('.md')){
        scanned++;
        try{
          const st=await fs.stat(full);if(st.size>150000)continue;
          const body=await fs.readFile(full,'utf8'),index=body.toLowerCase().indexOf(query.toLowerCase());
          if(index!==-1||e.name.toLowerCase().includes(query.toLowerCase())){
            const at=Math.max(0,index);
            found.push({path:rel(root,full),excerpt:body.slice(Math.max(0,at-70),at+180).replace(/\s+/g,' ')});
          }
        }catch{}
      }
    }
  }
  await visit(root,0);
  return {text:found.length?`Vault search for "${query}" (${found.length} results):\n${found.map(f=>`- ${f.path}: ${f.excerpt}`).join('\n')}`:`No vault Markdown matches for "${query}" (${scanned} files scanned).`,details:{found,scanned}};
}
async function macCommand(bin,args){
  if(process.env.AEGIS_DRY_RUN==='1') return '[dry-run: no macOS change]';
  if(process.platform!=='darwin') throw new Error('This tool requires macOS.');
  const {stdout}=await exec(bin,args,{timeout:15000,maxBuffer:250000,windowsHide:true});
  return stdout.trim().slice(0,MAX_RESPONSE);
}
const eventScript=`function run(argv) {
 const app=Application('Calendar'),[title,start,end,calendarName,notes]=argv;
 const matches=app.calendars.whose({name:calendarName})();
 if(!matches.length) throw Error('Calendar not found: '+calendarName);
 const event=app.Event({summary:title,startDate:new Date(start),endDate:new Date(end),description:notes});
 matches[0].events.push(event);
 return 'Created calendar event: '+title;
}`;
const listScript=`function run(argv) {
 const app=Application('Calendar'),[start,end,calendarName]=argv;
 const calendars=calendarName?app.calendars.whose({name:calendarName})():app.calendars();
 const result=[];
 for(const cal of calendars){
   const events=cal.events.whose({startDate:{_greaterThan:new Date(start),_lessThan:new Date(end)}})();
   for(const ev of events.slice(0,40)){
     result.push({calendar:cal.name(),title:ev.summary(),start:ev.startDate().toISOString(),end:ev.endDate().toISOString()});
     if(result.length>=80)break;
   }
   if(result.length>=80)break;
 }
 return JSON.stringify(result.sort((a,b)=>a.start.localeCompare(b.start)));
}`;
const reminderScript=`function run(argv) {
 const [title,due,listName]=argv,app=Application('Reminders');
 const lists=app.lists.whose({name:listName})();
 if(!lists.length) throw Error('Reminders list not found: '+listName);
 const p={name:title};
 if(due)p.dueDate=new Date(due);
 lists[0].reminders.push(app.Reminder(p));
 return 'Created reminder: '+title;
}`;
const clipboardSetScript=`on run argv\nset the clipboard to (item 1 of argv)\nreturn "Clipboard updated"\nend run`;
export async function executeIntegration(intent,params,settings){
  if(!READ.has(intent)&&!MUTATING_ACTIONS.has(intent)) throw new Error('Tool not allowed.');
  switch(intent){
    case 'vault_list':return vaultList(settings,params);
    case 'vault_read':return vaultRead(settings,params);
    case 'vault_search':return vaultSearch(settings,params);
    case 'calendar_create':return {text:await macCommand('/usr/bin/osascript',['-l','JavaScript','-e',eventScript,params.title,params.start,params.end,params.calendar,params.notes])};
    case 'calendar_list':{
      const raw=await macCommand('/usr/bin/osascript',['-l','JavaScript','-e',listScript,params.from,params.to,params.calendar]);
      if(process.env.AEGIS_DRY_RUN==='1') return {text:raw};
      const events=JSON.parse(raw);if(!Array.isArray(events))throw new Error('Unexpected Calendar response.');
      return {text:events.length?events.slice(0,60).map(e=>`${e.start} ${e.title} (${e.calendar})`).join('\n'):'No events in that date range.',details:{events:events.slice(0,60)}};
    }
    case 'reminder_create':return {text:await macCommand('/usr/bin/osascript',['-l','JavaScript','-e',reminderScript,params.title,params.due,params.list])};
    case 'clipboard_write':return {text:await macCommand('/usr/bin/osascript',['-e',clipboardSetScript,params.text])};
    case 'clipboard_read':return {text:await macCommand('/usr/bin/osascript',['-e','the clipboard as text'])};
    case 'battery_status':return {text:await macCommand('/usr/bin/pmset',['-g','batt'])};
    default:throw new Error('Unsupported integration.');
  }
}
export function confirmationSummary(intent,p){
  if(intent==='calendar_create')return `Create "${p.title}" in calendar "${p.calendar}" from ${p.start} to ${p.end}${p.notes?`; notes: ${p.notes}`:''}`;
  if(intent==='reminder_create')return `Add reminder "${p.title}" to "${p.list}"${p.due?` due ${p.due}`:''}`;
  if(intent==='clipboard_write')return `Replace clipboard with: ${p.text.slice(0,250)}${p.text.length>250?'...':''}`;
  throw new Error('No confirmation needed.');
}
