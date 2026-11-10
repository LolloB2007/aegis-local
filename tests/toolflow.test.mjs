import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-toolflow-'));
process.env.AEGIS_HOME=home;
process.env.AEGIS_DRY_RUN='1';
const {saveSettings,getHistory}=await import('../src/store.mjs');
const {runTurn}=await import('../src/agent.mjs');
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
const close=s=>new Promise(resolve=>s.close(resolve));

test('Kev classification -> async generator parameter extraction -> human approval -> one-shot execution',async t=>{
 const calls=[];
 const start=new Date(Date.now()+2*86400000).toISOString();
 const end=new Date(Date.now()+2*86400000+3600000).toISOString();
 const mock=http.createServer(async(req,res)=>{
   const chunks=[];for await(const part of req)chunks.push(part);
   const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
   calls.push({path:req.url,body});
   res.setHeader('content-type','application/json');
   if(req.url==='/api/ps')return res.end(JSON.stringify({models:[]}));
   if(req.url==='/v1/systemone')return res.end(JSON.stringify({
     answers:{intent:{choice:'ask_llm',probabilities:{ask_llm:0.91},confidence:0.91},target_app:{choice:'none'}}
   }));
   if(req.url==='/api/chat')return res.end(JSON.stringify({message:{role:'assistant',content:JSON.stringify({title:'Project meeting',start,end,calendar:'',notes:''})}}));
   return res.end('{}');
 });
 await listen(mock);
 t.after(async()=>{await close(mock);await fs.rm(home,{recursive:true,force:true});});
 await saveSettings({ollamaUrl:`http://127.0.0.1:${mock.address().port}`,autoReloadKev:false,calendarName:'Personal'});
 const proposed=await runTurn('Schedule a meeting on Personal calendar in two days at 10');
 assert.equal(proposed.action,'calendar_create');
 assert.equal(proposed.needsInput,true);
 assert.match(proposed.response,/Confirmation required/);
 assert.match(proposed.response,/Project meeting/);
 assert.ok(calls.some(c=>c.path==='/v1/systemone'));
 assert.ok(calls.some(c=>c.path==='/api/chat'&&c.body.format==='json'));
 const token=proposed.details.confirmationToken;
 assert.match(token,/^[a-f0-9]{12}$/);
 const confirmed=await runTurn('confirm '+token);
 assert.equal(confirmed.action,'calendar_create');
 assert.match(confirmed.response,/dry-run/);
 const replay=await runTurn('confirm '+token);
 assert.equal(replay.action,'confirm_expired');
 assert.equal((await getHistory()).length,6);
});
