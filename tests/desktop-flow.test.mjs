import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-desktop-flow-'));
process.env.AEGIS_HOME=home;
process.env.AEGIS_DRY_RUN='1';
const {saveSettings,getHistory}=await import('../src/store.mjs');
const {runTurn}=await import('../src/agent.mjs');
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
const close=s=>new Promise(resolve=>s.close(resolve));

test('two-model email tool requires preview and one-time confirmation',async t=>{
 const calls=[];
 const mock=http.createServer(async(req,res)=>{
   let chunks=[];for await(const part of req)chunks.push(part);
   const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
   calls.push({path:req.url,body});
   res.setHeader('content-type','application/json');
   if(req.url==='/api/ps')return res.end(JSON.stringify({models:[]}));
   if(req.url==='/v1/systemone')return res.end(JSON.stringify({
     answers:{intent:{choice:'ask_llm',probabilities:{ask_llm:0.91},confidence:0.91},target_app:{choice:'none'}}
   }));
   if(req.url==='/api/chat')return res.end(JSON.stringify({message:{role:'assistant',content:JSON.stringify({
      to:'friend@example.com',subject:'Budget discussion',body:'Hello, I would like to discuss the budget next week. Best regards.'
   })}}));
   return res.end('{}');
 });
 await listen(mock);
 t.after(async()=>{await close(mock);await fs.rm(home,{recursive:true,force:true});});
 await saveSettings({ollamaUrl:`http://127.0.0.1:${mock.address().port}`,autoReloadKev:false});
 const proposed=await runTurn('Send an email to friend@example.com about the budget');
 assert.equal(proposed.action,'email_send');
 assert.equal(proposed.needsInput,true);
 assert.match(proposed.response,/SEND email/);
 assert.match(proposed.response,/friend@example.com/);
 assert.match(proposed.response,/discuss the budget/);
 assert.ok(calls.some(c=>c.path==='/api/chat'&&c.body.format==='json'));
 const token=proposed.details.confirmationToken;
 assert.match(token,/^[a-f0-9]{12}$/);
 const finished=await runTurn('confirm '+token);
 assert.equal(finished.action,'email_send');
 assert.match(finished.response,/dry-run/);
 const repeated=await runTurn('confirm '+token);
 assert.equal(repeated.action,'confirm_expired');
 assert.equal((await getHistory()).length,6);
});
