import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const home=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-v21-ready-'));
process.env.AEGIS_HOME=home;
const {createServer}=await import('../src/server.mjs');
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
const close=s=>new Promise(resolve=>s.close(resolve));
test('core is unavailable until exact persistent memory note is present, even if empty',async t=>{
 t.after(async()=>fs.rm(home,{recursive:true,force:true}));
 const offline=createServer({port:0});await listen(offline);
 const base='http://127.0.0.1:'+offline.address().port;
 const health=await fetch(base+'/api/health');
 assert.equal(health.status,503);
 assert.equal((await health.json()).ok,false);
 const notReady=await fetch(base+'/api/chat',{method:'POST',
  headers:{'X-Aegis-Local':'1','Content-Type':'application/json'},
  body:JSON.stringify({message:'What is Aegis?'})});
 assert.equal(notReady.status,503);
 await close(offline);
 const dir=path.join(home,'Documents','Obsidian','aegis');
 await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,'Persistent memory.md'),'');
 const online=createServer({port:0});await listen(online);
 try{
  const status=await fetch('http://127.0.0.1:'+online.address().port+'/api/health');
  assert.equal(status.status,200);
  const info=await status.json();
  assert.equal(info.ok,true);
  assert.equal(info.startup.memoryLoaded,true);
  assert.equal(info.startup.memoryCharacters,0);
  assert.equal(info.startup.promptLoaded,false);
  assert.deepEqual(await fs.readdir(dir),['Persistent memory.md']);
 }finally{await close(online);}
});
