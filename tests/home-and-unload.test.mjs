import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// A home reached through a symlink (macOS /var -> /private/var) must behave
// exactly like a canonical one for every realpath-based containment check.
const real=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-home-real-'));
const link=real+'-link';
await fs.symlink(real,link);
process.env.AEGIS_HOME=link;
const {inUserHome,expandHome}=await import('../src/store.mjs');
const {unloadModel}=await import('../src/ollama.mjs');

test('symlinked home: lexical and realpath forms are both inside home',async t=>{
  t.after(()=>Promise.all([fs.rm(link,{force:true}),fs.rm(real,{recursive:true,force:true})]));
  const canonical=await fs.realpath(real);
  assert.equal(expandHome('~/Documents'),path.join(canonical,'Documents'));
  assert.equal(expandHome(path.join(link,'Documents')),path.join(canonical,'Documents'));
  assert.equal(inUserHome(path.join(canonical,'Documents')),true);
  assert.equal(inUserHome(path.join(link,'Downloads')),true);
  assert.equal(inUserHome(path.join(canonical,'..','escape')),false);
});

test('unload uses the configured Ollama server over HTTP for both models',async t=>{
  const seen=[];
  const mock=http.createServer(async(req,res)=>{
    let body='';for await(const c of req)body+=c;
    seen.push({url:req.url,body:body?JSON.parse(body):{}});
    res.setHeader('content-type','application/json');
    res.end(req.url==='/api/ps'?JSON.stringify({models:[{name:'kev:0.8b-q8_0'},{name:'llama3.2:3b'}]}):'{}');
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>mock.close(r)));
  const settings={ollamaUrl:'http://127.0.0.1:'+mock.address().port};
  assert.equal((await unloadModel(settings,'kev:0.8b-q8_0','decision')).method,'generate-unload');
  assert.equal((await unloadModel(settings,'llama3.2:3b','generator')).method,'generate-unload');
  const unloads=seen.filter(e=>e.url==='/api/generate'&&e.body.keep_alive===0).map(e=>e.body.model);
  assert.deepEqual(unloads,['kev:0.8b-q8_0','llama3.2:3b']);
});
