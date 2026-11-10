import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('voice front end has no second privileged executor',async()=>{
 const main=await fs.readFile(new URL('../src/ui/voice-control/main.js',import.meta.url),'utf8');
 const overlay=await fs.readFile(new URL('../src/ui/voice-control/overlay.html',import.meta.url),'utf8');
 const preload=await fs.readFile(new URL('../src/ui/voice-control/preload.cjs',import.meta.url),'utf8');
 assert.doesNotMatch(main,/shell-execute|execute-tool|bash.*-c|nodeIntegration:\s*true/);
 assert.match(main,/nodeIntegration:\s*false/);
 assert.match(main,/contextIsolation:\s*true/);
 assert.match(main,/sandbox:\s*true/);
 assert.match(main,/sendToAegis\(transcript\.text\)/);
 assert.doesNotMatch(overlay,/require\(['"]electron['"]\)/);
 assert.doesNotMatch(preload,/execute-tool|generate-content/);
});
test('voice launch script derives repository location, not user paths',async()=>{
 const launch=await fs.readFile(new URL('../src/ui/voice-control/launch.sh',import.meta.url),'utf8');
 assert.doesNotMatch(launch,/\/Users\/|pgrep -F/);
 assert.match(launch,/SCRIPT_DIR|VOICE_DIR/);
});
