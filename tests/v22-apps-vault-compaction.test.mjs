import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const home=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-v22-'));
process.env.AEGIS_HOME=home;
process.env.AEGIS_DRY_RUN='1';
const {getSettings}=await import('../src/store.mjs');
const {APP_CHOICES,detectApp,explicitIntent}=await import('../src/intent.mjs');
const {browserForRequest,openWebsite,webSearch}=await import('../src/tools.mjs');
const {explicitIntegrationIntent,validateIntegrationArgs,executeIntegration,confirmationSummary}=await import('../src/integrations.mjs');
const {requireVaultPolicy}=await import('../src/vault-policy.mjs');
const {compactSessionContext,sessionContextForPrompt}=await import('../src/context-compaction.mjs');
const {stageApproval,takeApproval}=await import('../src/approvals.mjs');
const POLICY='---\naegis-access: read-only\n---\n# Aegis Operating Manual — Read-Only Vault Access\nNever write.\n';

test('WhatsApp and Opera GX are launch-only allowlisted apps; Chrome preferred browser',async()=>{
 assert.equal(APP_CHOICES.whatsapp,'WhatsApp');
 assert.equal(detectApp('Open WhatsApp'),'whatsapp');
 assert.equal(detectApp('Launch Opera GX'),'opera_gx');
 const settings=await getSettings();
 assert.equal(settings.preferredBrowser,'chrome');
 assert.equal(explicitIntent('Open github.com in Safari'),'open_website');
 assert.equal(browserForRequest('Open github.com',settings).app,'Google Chrome');
 assert.equal(browserForRequest('Open github.com in Safari',settings).app,'Safari');
 const result=await openWebsite('Open github.com',settings);
 assert.equal(result.details.browser,'Google Chrome');
 const search=await webSearch('Search the web for company reports in Opera GX',settings);
 assert.equal(search.details.browser,'Opera GX');
});
test('Apple Notes creation is bounded and confirmation gated like Calendar',async()=>{
 assert.equal(explicitIntegrationIntent('Create a note in the Notes app about statistics'),'notes_create');
 const p=validateIntegrationArgs('notes_create',{title:'Study',body:'Review statistics',folder:'Notes'},await getSettings());
 assert.match(confirmationSummary('notes_create',p),/Review statistics/);
 assert.throws(()=>validateIntegrationArgs('notes_create',{title:'Study',body:'x'.repeat(5500)},p),/Invalid Apple Notes body/);
 const token=stageApproval('notes_create',p,confirmationSummary('notes_create',p));
 assert.deepEqual(takeApproval(token).args,p);
 assert.equal(takeApproval(token),null);
 const output=await executeIntegration('notes_create',p,await getSettings());
 assert.match(output.text,/dry-run/);
 assert.equal(explicitIntegrationIntent('Create a calendar event tomorrow'),'calendar_create');
});
test('vault reads are fail-closed until valid _Aegis.md is on disk',async t=>{
 const settings=await getSettings();
 const vault=path.join(home,'Documents','Obsidian','claude');
 await fs.mkdir(vault,{recursive:true});
 const file=path.join(vault,'Project.md');
 await fs.writeFile(file,'Project notes for navigation.');
 await assert.rejects(()=>executeIntegration('vault_read',{path:'Project.md'},settings),/_Aegis.md is missing/);
 await fs.writeFile(path.join(vault,'_Aegis.md'),'# no valid policy');
 await assert.rejects(()=>requireVaultPolicy(settings),/Invalid _Aegis.md|must explicitly declare/);
 await fs.writeFile(path.join(vault,'_Aegis.md'),POLICY);
 const manual=await requireVaultPolicy(settings);
 assert.match(manual.manual,/read-only/);
 const note=await executeIntegration('vault_read',{path:'Project.md'},settings);
 assert.match(note.text,/Project notes/);
 await fs.rm(path.join(vault,'_Aegis.md'));
 await assert.rejects(()=>executeIntegration('vault_read',{path:'Project.md'},settings),/_Aegis.md is missing/);
});
test('Ollama compaction selects only exact user statements and never writes personal memory',async t=>{
 const history=Array.from({length:42},(_,i)=>({
  role:i%2?'assistant':'user',at:new Date(Date.UTC(2026,0,1,0,i)).toISOString(),
  content:i%2?'Assistant response '+i:'User explicitly said preference '+i
 }));
 let calls=0;
 const fakeFetch=async(_url,args)=>{
  calls++;
  const body=JSON.parse(args.body);
  assert.equal(body.model,'llama3.2:3b');
  assert.equal(body.options.temperature,0);
  return {ok:true,text:async()=>JSON.stringify({message:{content:JSON.stringify({ids:[1,3,999]})}})};
 };
 const settings=await getSettings();
 const chosen=await compactSessionContext(settings,history,{fetchImpl:fakeFetch});
 assert.ok(chosen.length>=1);
 assert.ok(chosen.every(x=>history.some(h=>h.content===x.text)));
 const stored=JSON.parse(await fs.readFile(path.join(home,'.aegis-local','session-compaction.json'),'utf8'));
 assert.deepEqual(stored.excerpts,chosen);
 assert.ok(!(await fs.readdir(home)).includes('Persistent memory.md'));
 assert.ok(calls>0);
 const prompt=await sessionContextForPrompt(settings,history,{fetchImpl:fakeFetch});
 assert.match(prompt,/User explicitly said preference/);
 t.after(async()=>fs.rm(home,{recursive:true,force:true}));
});
