import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const home=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-v21-tools-'));
process.env.AEGIS_HOME=home;
const {getSettings}=await import('../src/store.mjs');
const {vaultNavigationIntent,executeVaultNavigation}=await import('../src/vault-navigation.mjs');
const {calendarPlanningIntent,validateCalendarPlanningArgs,calculateFreeSlots}=await import('../src/calendar-planning.mjs');
const {indexIntent,executeIndex}=await import('../src/document-index.mjs');
const {developerIntent,executeDeveloper}=await import('../src/developer-tools.mjs');

test('Obsidian graph navigation lists actual backlinks, outgoing links, and tasks without writing notes',async()=>{
 const root=path.join(home,'Documents','Obsidian','claude');
 await fs.mkdir(path.join(root,'Projects'),{recursive:true});
 await fs.writeFile(path.join(root,'Projects','Aegis.md'),'# Aegis\n- [ ] Implement safe search\n');
 await fs.writeFile(path.join(root,'Index.md'),'# Index\nSee [[Projects/Aegis]] and [[Missing Note]].\n');
 const before=await fs.readdir(root);
 const settings=await getSettings();
 const backlinks=await executeVaultNavigation('vault_backlinks',{path:'Projects/Aegis.md'},settings);
 assert.match(backlinks.text,/Index.md/);
 assert.equal(vaultNavigationIntent('Show vault backlinks: Projects/Aegis.md').intent,'vault_backlinks');
 const out=await executeVaultNavigation('vault_outlinks',{path:'Index.md'},settings);
 assert.match(out.text,/Projects\/Aegis/);
 const tasks=await executeVaultNavigation('vault_tasks',{},settings);
 assert.match(tasks.text,/Implement safe search/);
 assert.deepEqual(await fs.readdir(root),before);
 await assert.rejects(()=>executeVaultNavigation('vault_backlinks',{path:'../aegis/Persistent memory.md'},settings),/vault-relative/);
});

test('Calendar planner validates explicit timestamps and computes unoccupied 60-minute intervals',()=>{
 assert.equal(calendarPlanningIntent('Find free time this week'),'calendar_free');
 assert.equal(calendarPlanningIntent('Check calendar conflicts tomorrow'),'calendar_check');
 const tomorrow=new Date(Date.now()+86400000), date=new Date(tomorrow.getFullYear(),tomorrow.getMonth(),tomorrow.getDate());
 const start=new Date(date);start.setHours(9,0,0,0);
 const end=new Date(date);end.setHours(13,0,0,0);
 const args=validateCalendarPlanningArgs('calendar_free',{
  from:start.toISOString(),to:end.toISOString(),durationMinutes:'60',dayStart:'09:00',dayEnd:'13:00',calendar:''
 });
 const blockedStart=new Date(date);blockedStart.setHours(10,0,0,0);
 const events=[{start:blockedStart.getTime(),end:blockedStart.getTime()+3600000,title:'Occupied'}];
 const slots=calculateFreeSlots(events,args,start.getTime()-1000);
 assert.ok(slots.length>0);
 assert.ok(slots.every(s=>Date.parse(s.end)<=blockedStart.getTime()||Date.parse(s.start)>=blockedStart.getTime()+3600000));
 assert.throws(()=>validateCalendarPlanningArgs('calendar_free',{from:'tomorrow',to:'next week',durationMinutes:60}),/ISO8601/);
});

test('Indexed text excludes Aegis memory, searches documents and never edits them',async()=>{
 const dir=path.join(home,'Documents');
 const memory=path.join(dir,'Obsidian','aegis');
 await fs.mkdir(memory,{recursive:true});
 await fs.mkdir(path.join(dir,'Reports'),{recursive:true});
 const original='# Valuation\nTerminal growth assumption is six percent in long run.\n';
 await fs.writeFile(path.join(dir,'Reports','valuation.md'),original);
 await fs.writeFile(path.join(memory,'Persistent memory.md'),'SECRET-NEVER-INDEX\n');
 assert.equal(indexIntent('Index my documents').intent,'index_rebuild');
 const settings=await getSettings();
 const rebuilt=await executeIndex('index_rebuild',{},settings);
 assert.ok(rebuilt.details.indexed>=1);
 const result=await executeIndex('index_search',{query:'terminal growth'},settings);
 assert.match(result.text,/valuation.md/);
 const excluded=await executeIndex('index_search',{query:'SECRET-NEVER-INDEX'},settings);
 assert.equal(excluded.details.results.length,0);
 assert.equal(await fs.readFile(path.join(dir,'Reports','valuation.md'),'utf8'),original);
});

test('legacy note tool cannot write to the protected personal vault or Aegis memory',async()=>{
 const {createNote}=await import('../src/tools.mjs');
 const settings=await getSettings();
 for(const notesFolder of [settings.vaultRoot,settings.memoryRoot]){
   const configured={...settings,notesFolder};
   await assert.rejects(()=>createNote('save a note: Unsafe | Should not be saved',configured),
     /Protected Obsidian folders/);
 }
 const personal=path.join(home,'Documents','Obsidian','claude');
 const unauthorized=path.join(personal,'new-directory');
 await assert.rejects(
   ()=>createNote('save a note: No | Should not create folders',{...settings,notesFolder:unauthorized}),
   /Protected Obsidian folders/
 );
 await assert.rejects(()=>fs.stat(unauthorized),e=>e.code==='ENOENT');
 assert.ok(!(await fs.readdir(personal)).includes('Unsafe.md'));
});

test('Developer tool only inspects a specified local repository without arbitrary commands',async t=>{
 const dir=path.join(home,'Projects','sample');
 await fs.mkdir(dir,{recursive:true});
 const {execFileSync}=await import('node:child_process');
 execFileSync('git',['init','-q',dir]);
 assert.equal(developerIntent('git status: '+dir).intent,'git_status');
 const result=await executeDeveloper('git_status',{repository:dir});
 assert.match(result.text,/git_status/);
 await assert.rejects(()=>executeDeveloper('git_status',{repository:'/etc'}),/inside the user home/);
 t.after(async()=>fs.rm(home,{recursive:true,force:true}));
});
