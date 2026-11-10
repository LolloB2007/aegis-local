import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const home=await fs.mkdtemp(path.join(os.tmpdir(),'aegis-v14-tools-'));
process.env.AEGIS_HOME=home;
process.env.AEGIS_DRY_RUN='1';
const {
 desktopIntent,DESKTOP_SCHEMAS,validateDesktopArgs,previewDesktop,executeDesktop
}=await import('../src/desktop-tools.mjs');
const {APP_CHOICES,detectApp}=await import('../src/intent.mjs');
const settings={vaultRoot:path.join(home,'Documents','Obsidian','claude')};

test('desktop intent grammar does not authorize arbitrary shell execution',()=>{
 assert.equal(desktopIntent('Quit Spotify'),'app_quit');
 assert.equal(desktopIntent('Send an email to someone@example.com'),'email_send');
 assert.equal(desktopIntent('Draft an email to person@example.com'),'email_draft');
 assert.equal(desktopIntent('Organize my Downloads'),'folder_organize');
 assert.equal(desktopIntent('Set volume to 40'),'volume_set');
 assert.equal(desktopIntent('Set brightness to 40'),'brightness_set');
 assert.equal(desktopIntent('What is my Wi-Fi status?'),'network_status');
 assert.equal(desktopIntent('Run a memory diagnostic'),'system_diagnostic');
 assert.equal(desktopIntent('rm -rf ~/Documents'),null);
 assert.equal(desktopIntent('How do I send an email?'),null);
 assert.equal(desktopIntent('Please delete everything'),null);
 assert.ok(APP_CHOICES.spotify);
 assert.equal(detectApp('open Spotify'),'spotify');
 assert.ok(DESKTOP_SCHEMAS.email_send);
});
test('strict argument validation',()=>{
 assert.deepEqual(validateDesktopArgs('volume_set',{level:'0'}),{level:0});
 assert.deepEqual(validateDesktopArgs('brightness_set',{level:'100'}),{level:100});
 assert.throws(()=>validateDesktopArgs('brightness_set',{level:'101'}),/between 0 and 100/);
 assert.throws(()=>validateDesktopArgs('volume_set',{level:'40; echo injected'}),/between 0 and 100/);
 assert.equal(validateDesktopArgs('app_quit',{app:'Spotify'}).app,'spotify');
 assert.throws(()=>validateDesktopArgs('app_quit',{app:'../../bin/sh'}),/allowlist/);
 assert.throws(()=>validateDesktopArgs('email_send',{to:'a@b.com,c@d.com',subject:'x',body:'text'}),/recipient/);
 assert.throws(()=>validateDesktopArgs('file_trash',{path:'/etc/passwd'}),/outside your home/);
 assert.throws(()=>validateDesktopArgs('file_trash',{path:'~/Documents/../.ssh/id_rsa'}),/protected/);
 assert.throws(()=>validateDesktopArgs('system_diagnostic',{kind:'cat /etc/passwd'}),/Unsupported diagnostic/);
});
test('safe previews, vault protections, symlink escapes and dry run executor',async t=>{
 t.after(()=>fs.rm(home,{recursive:true,force:true}));
 const downloads=path.join(home,'Downloads');
 const desktop=path.join(home,'Desktop');
 const vault=settings.vaultRoot;
 await fs.mkdir(downloads,{recursive:true});
 await fs.mkdir(desktop,{recursive:true});
 await fs.mkdir(vault,{recursive:true});
 await fs.writeFile(path.join(downloads,'invoice.pdf'),'not a real pdf');
 await fs.writeFile(path.join(desktop,'photo.jpg'),'image');
 await fs.writeFile(path.join(vault,'secret.md'),'private vault');
 await fs.symlink('/etc/passwd',path.join(downloads,'escape.txt'));
 const trash=validateDesktopArgs('file_trash',{path:path.join(downloads,'invoice.pdf')});
 const proposed=await previewDesktop('file_trash',trash,settings);
 assert.match(proposed.summary,/Move the file/);
 assert.match((await executeDesktop('file_trash',proposed.args,settings)).text,/dry-run/);
 const organized=await previewDesktop('folder_organize',{folder:desktop},settings);
 assert.match(organized.summary,/Images/);
 assert.equal(organized.args.previewItems.length,1);
 assert.match((await executeDesktop('folder_organize',organized.args,settings)).text,/dry-run/);
 await assert.rejects(()=>previewDesktop('file_trash',{path:path.join(vault,'secret.md')},settings),/Vault files are protected/);
 await assert.rejects(()=>previewDesktop('file_trash',{path:path.join(downloads,'escape.txt')},settings),/Symlink escapes/);
 const email=validateDesktopArgs('email_send',{to:'friend@example.com',subject:'Hello',body:'Checking in'});
 assert.match((await previewDesktop('email_send',email,settings)).summary,/SEND email/);
 assert.match((await executeDesktop('email_send',email,settings)).text,/dry-run/);
});
