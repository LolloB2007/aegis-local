import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {explicitIntegrationIntent,validateIntegrationArgs,executeIntegration} from '../src/integrations.mjs';
import {stageApproval,takeApproval,cancelApproval} from '../src/approvals.mjs';

test('integration intents require explicit commands',()=>{
 assert.equal(explicitIntegrationIntent('Schedule a meeting tomorrow at 10'),'calendar_create');
 assert.equal(explicitIntegrationIntent('Search my vault for Aegis'),'vault_search');
 assert.equal(explicitIntegrationIntent('Read my vault note Projects/Aegis/Aegis Local.md'),'vault_read');
 assert.equal(explicitIntegrationIntent('Open Calendar'),null);
 assert.equal(explicitIntegrationIntent('Tell me why calendars are hard'),null);
 assert.equal(explicitIntegrationIntent('Delete every file'),null);
});
test('calendar and reminder parameters must be complete and bounded',()=>{
 const settings={calendarName:'Personal',reminderListName:'Tasks'};
 const start=new Date(Date.now()+86400000).toISOString();
 const end=new Date(Date.now()+90000000).toISOString();
 assert.equal(validateIntegrationArgs('calendar_create',{title:'Test',start,end},settings).calendar,'Personal');
 assert.throws(()=>validateIntegrationArgs('calendar_create',{title:'Test',start,end:start},settings),/Events must/);
 assert.throws(()=>validateIntegrationArgs('calendar_create',{title:'Test',start:'tomorrow',end},settings),/ISO8601/);
 assert.throws(()=>validateIntegrationArgs('reminder_create',{title:'Test'},{reminderListName:''}),/Which Reminders list/);
 assert.equal(validateIntegrationArgs('reminder_create',{title:'Test'},settings).list,'Tasks');
});
test('approval tokens are one time and cancellable',()=>{
 const token=stageApproval('calendar_create',{title:'A'},'Create A');
 assert.ok(takeApproval(token));
 assert.equal(takeApproval(token),null);
 const cancel=stageApproval('reminder_create',{},'Create reminder');
 assert.ok(cancelApproval(cancel));
 assert.equal(takeApproval(cancel),null);
});
test('vault search, read, navigation and symlink escape protection',async t=>{
 const temp=await fs.mkdtemp(path.join(os.homedir(),'aegis-integration-test-'));
 t.after(()=>fs.rm(temp,{recursive:true,force:true}));
 const root=path.join(temp,'vault');
 await fs.mkdir(path.join(root,'Projects','Aegis'),{recursive:true});
 await fs.writeFile(path.join(root,'Projects','Aegis','Aegis Local.md'),'# Aegis\nLocal models keep data private.\n');
 await fs.symlink('/etc',path.join(root,'escape'));
 const settings={vaultRoot:root};
 const read=await executeIntegration('vault_read',{path:'Projects/Aegis/Aegis Local.md'},settings);
 assert.match(read.text,/Local models/);
 const found=await executeIntegration('vault_search',{query:'models'},settings);
 assert.equal(found.details.found.length,1);
 const listing=await executeIntegration('vault_list',{folder:'Projects'},settings);
 assert.match(listing.text,/Aegis/);
 await assert.rejects(()=>executeIntegration('vault_read',{path:'../sensitive.md'},settings),/parent paths/);
 await assert.rejects(()=>executeIntegration('vault_list',{folder:'escape'},settings),/outside the vault/);
});
