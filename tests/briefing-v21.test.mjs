import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const home=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-v21-brief-'));
process.env.AEGIS_HOME=home;
const {runBriefing}=await import('../src/briefing.mjs');
const {saveSettings}=await import('../src/store.mjs');
const listen=s=>new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));
const close=s=>new Promise(resolve=>s.close(resolve));

test('tomorrow briefing reads real open checkboxes, never edits the personal vault',async t=>{
 const vault=path.join(home,'Documents','Obsidian','claude');
 await fs.mkdir(vault,{recursive:true});
 await fs.writeFile(path.join(vault,'_Aegis.md'),"---\naegis-access: read-only\n---\n# Aegis Operating Manual — Read-Only Vault Access\nNever write.\n");
 const filename=path.join(vault,'Tasks.md');
 const note='# Pending\n- [ ] Review internship tracker\n- [x] Completed old task\n';
 await fs.writeFile(filename,note);
 const seen=[];
 const ollama=http.createServer(async(req,res)=>{
   const chunks=[];for await(const c of req)chunks.push(c);
   const body=JSON.parse(Buffer.concat(chunks).toString());
   seen.push(body);
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify({message:{role:'assistant',content:'Review the internship tracker tomorrow; calendar could not be retrieved.'}}));
 });
 await listen(ollama);
 t.after(async()=>{await close(ollama);await fs.rm(home,{recursive:true,force:true});});
 const settings=await saveSettings({ollamaUrl:'http://127.0.0.1:'+ollama.address().port,autoUnload:false,autoReloadKev:false});
 const result=await runBriefing(settings);
 assert.equal(result.details.taskMatches,1);
 assert.match(result.text,/internship tracker/);
 assert.ok(seen.some(body=>body.messages?.some(message=>
   message.role==='user'&&message.content.includes('Review internship tracker'))));
 assert.equal(await fs.readFile(filename,'utf8'),note);
});
