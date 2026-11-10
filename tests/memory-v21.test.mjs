import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
const home=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-v21-memory-'));
process.env.AEGIS_HOME=home;
process.env.AEGIS_DRY_RUN='1';
const {getSettings,saveSettings}=await import('../src/store.mjs');
const {memoryIntent,validateMemoryArgs,executeMemory,dailyNotePath,searchMemory}=await import('../src/memory.mjs');
const {initializeStartupContext,getStartupContext}=await import('../src/startup-context.mjs');
const {generate}=await import('../src/ollama.mjs');
const {runTurn}=await import('../src/agent.mjs');
const dir=path.join(home,'Documents','Obsidian','aegis');
const personal=path.join(home,'Documents','Obsidian','claude');

test('startup refuses missing Persistent memory.md and does not generate any notes',async()=>{
 await fs.mkdir(dir,{recursive:true});
 await fs.mkdir(personal,{recursive:true});
 const settings=await getSettings();
 await assert.rejects(()=>initializeStartupContext(settings),/Persistent memory.md/);
 assert.deepEqual(await fs.readdir(dir),[]);
 await fs.writeFile(path.join(dir,'Persistent memory.md'),'');
 let ready=await initializeStartupContext(settings);
 assert.equal(ready.memoryLoaded,true);
 assert.equal(ready.memoryCharacters,0);
 assert.equal(ready.promptLoaded,false);
 assert.deepEqual(await fs.readdir(dir),['Persistent memory.md']);
 await fs.writeFile(path.join(dir,'System Prompt.md'),'Use concise answers and check uncertainty.');
 await fs.writeFile(path.join(dir,'Persistent memory.md'),'- My project codename is Aegis Atlas.\n');
 ready=await initializeStartupContext(settings);
 assert.equal(ready.promptLoaded,true);
 assert.match(getStartupContext().persistentMemory,/Aegis Atlas/);
 assert.equal(getStartupContext().systemPrompt,'Use concise answers and check uncertainty.');
 assert.deepEqual((await fs.readdir(dir)).sort(),['Persistent memory.md','System Prompt.md']);
});

test('the Ollama system messages contain user-authored prompt and bounded memory references',async()=>{
 await initializeStartupContext(await getSettings());
 let recorded;
 const server=http.createServer(async(req,res)=>{
   const buf=[];for await(const chunk of req)buf.push(chunk);
   recorded=JSON.parse(Buffer.concat(buf).toString());
   res.setHeader('Content-Type','application/json');
   res.end(JSON.stringify({message:{role:'assistant',content:'I can confirm Aegis Atlas is the project codename.'}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
   const settings=await saveSettings({ollamaUrl:'http://127.0.0.1:'+server.address().port});
   const reply=await generate(settings,[{role:'user',content:'What is the Aegis Atlas codename?'}]);
   assert.match(reply.content,/Aegis Atlas/);
   assert.ok(recorded.messages.some(m=>m.role==='system'&&m.content.includes('Use concise answers')));
   assert.ok(recorded.messages.some(m=>m.role==='system'&&m.content.includes('Aegis Atlas')));
   assert.ok(recorded.messages.every(m=>m.content.length<9000));
 }finally{await new Promise(r=>server.close(r));}
});

test('empty note creation is explicit, safely named, and never creates template context',async()=>{
 const settings=await getSettings();
 assert.equal(memoryIntent('Create Aegis Markdown note: Routine Tasks.md').intent,'memory_note_create');
 assert.equal(memoryIntent("Start my daily note").intent,'memory_note_create');
 assert.match(dailyNotePath(),/^Daily\/\d{4}-\d\d-\d\d\.md$/);
 assert.throws(()=>validateMemoryArgs('memory_note_create',{path:'../../claude/secret.md'}),/relative Markdown/);
 assert.throws(()=>validateMemoryArgs('memory_note_create',{path:'../System Prompt.md'}),/relative Markdown/);
 let reply=await executeMemory('memory_note_create',{path:'To-Do List.md'},settings);
 assert.match(reply.text,/Created empty/);
 assert.equal(await fs.readFile(path.join(dir,'To-Do List.md'),'utf8'),'');
 await assert.rejects(()=>executeMemory('memory_note_create',{path:'To-Do List.md'},settings),/EEXIST/);
 reply=await executeMemory('memory_todo_add',{text:'Read chapters'},settings);
 assert.match(reply.text,/Updated/);
 assert.match(await fs.readFile(path.join(dir,'To-Do List.md'),'utf8'),/^- \[ \] Read chapters/m);
 await executeMemory('memory_todo_done',{text:'Read chapters'},settings);
 assert.match(await fs.readFile(path.join(dir,'To-Do List.md'),'utf8'),/^- \[x\] Read chapters/m);
 const vaultContent=await fs.readdir(personal);
 assert.equal(vaultContent.length,0);
 const files=await fs.readdir(dir);
 assert.ok(!files.includes('Routine Tasks.md'));
 assert.ok(!files.includes('Persistent Context.md'));
 assert.ok(!files.includes('Daily'));
});

test('memory mutation only stages then executes after one-time confirmation',async t=>{
 t.after(async()=>fs.rm(home,{recursive:true,force:true}));
 const current=await getSettings();
 const proposed=await runTurn('Aegis remember: I am testing the memory system');
 assert.equal(proposed.action,'memory_remember');
 assert.equal(proposed.needsInput,true);
 const before=await fs.readFile(path.join(dir,'Persistent memory.md'),'utf8');
 assert.doesNotMatch(before,/testing the memory system/);
 const token=proposed.details.confirmationToken;
 assert.match(token,/^[a-f0-9]{12}$/);
 const confirmed=await runTurn('confirm '+token);
 assert.equal(confirmed.action,'memory_remember');
 assert.match(await fs.readFile(path.join(dir,'Persistent memory.md'),'utf8'),/testing the memory system/);
 const replay=await runTurn('confirm '+token);
 assert.equal(replay.action,'confirm_expired');
});
