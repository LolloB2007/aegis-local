import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home = await fs.mkdtemp(path.join(os.tmpdir(),'aegis-v2-stream-'));
process.env.AEGIS_HOME = home;
process.env.AEGIS_DRY_RUN = '1';
const {createServer} = await import('../src/server.mjs');
const {saveSettings,getHistory} = await import('../src/store.mjs');
const {briefingIntent,tomorrowBounds} = await import('../src/briefing.mjs');

const listen = server => new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const close = server => new Promise(resolve=>server.close(resolve));

test('daily briefing intent is strict and tomorrow bounds are valid',()=>{
 assert.equal(briefingIntent('Brief me for tomorrow'),true);
 assert.equal(briefingIntent('Tell me about briefings'),false);
 const {from,to}=tomorrowBounds();
 const diff=Date.parse(to)-Date.parse(from);
 assert.ok(diff>=23*3600000 && diff<=25*3600000);
});

test('SSE streams model deltas and a complete result from the guarded queue',async t=>{
 const observed=[];
 const mock=http.createServer(async(req,res)=>{
   const chunks=[];for await(const part of req)chunks.push(part);
   const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
   observed.push({url:req.url,body});
   res.setHeader('content-type','application/json');
   if(req.url==='/api/ps')return res.end(JSON.stringify({models:[]}));
   if(req.url==='/v1/systemone')return res.end(JSON.stringify({
    answers:{intent:{choice:'ask_llm',probabilities:{ask_llm:.91},confidence:.91},target_app:{choice:'none'}}
   }));
   if(req.url==='/api/chat'){
      assert.equal(body.stream,true);
      res.write('{"message":{"content":"Good "},"done":false}\n');
      res.write('{"mess');
      setTimeout(()=>{
       res.write('age":{"content":"morning"},"done":false}\n');
       res.end('{"done":true,"eval_count":2,"load_duration":1000}\n');
      },4);
      return;
   }
   res.end('{}');
 });
 await listen(mock);
 const memoryDir=path.join(home,'Documents','Obsidian','aegis');
 await fs.mkdir(memoryDir,{recursive:true});
 await fs.writeFile(path.join(memoryDir,'Persistent memory.md'),'');
 const server=createServer({port:0});
 await listen(server);
 t.after(async()=>{await close(server);await close(mock);await fs.rm(home,{recursive:true,force:true});});
 await saveSettings({ollamaUrl:'http://127.0.0.1:'+mock.address().port,autoReloadKev:false});
 const base='http://127.0.0.1:'+server.address().port;
 const health=await fetch(base+'/api/health').then(r=>r.json());
 assert.equal(health.ok,true);
 assert.equal(health.version, JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url),'utf8')).version);
 const resp=await fetch(base+'/api/stream',{method:'POST',
   headers:{'Content-Type':'application/json','X-Aegis-Local':'1'},
   body:JSON.stringify({message:'Explain interest rates'})});
 assert.equal(resp.status,200);
 assert.match(resp.headers.get('content-type'),/text\/event-stream/);
 const output=await resp.text();
 const records=output.split('\n\n').filter(x=>x.includes('data: ')).map(raw=>{
   const type=/event: ([^\n]+)/.exec(raw)?.[1];
   const json=/data: ([^\n]+)/.exec(raw)?.[1];
   return {type,data:JSON.parse(json)};
 });
 assert.ok(records.some(x=>x.type==='phase'));
 assert.ok(records.some(x=>x.type==='step'));
 assert.equal(records.filter(x=>x.type==='delta').map(x=>x.data.text).join(''),'Good morning');
 assert.equal(records.find(x=>x.type==='result').data.response,'Good morning');
 assert.equal(records.at(-1).type,'done');
 assert.equal(records.at(-1).data.ok,true);
 assert.equal((await getHistory()).at(-1).content,'Good morning');
 assert.ok(observed.some(x=>x.url==='/api/chat'&&x.body.stream===true));
});
