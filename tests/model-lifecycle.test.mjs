import test from 'node:test';
import assert from 'node:assert/strict';
import {createModelScheduler} from '../src/model-lifecycle.mjs';

const sleep = ms => new Promise(resolve=>setTimeout(resolve,ms));
const settings={autoUnload:true,llmModel:'llama3.2:3b',kevModel:'kev:0.8b-q8_0'};

test('eager release unloads BOTH models shortly after a completed turn', async t=>{
  const unloaded=[];
  const scheduler=createModelScheduler({
    readSettings:async()=>settings,
    unload:async(_settings,name,type)=>unloaded.push([name,type]),
    releaseDelayMs:5
  });
  t.after(()=>scheduler.close());
  assert.equal(await scheduler.enqueue(async()=>42),42);
  await sleep(70);
  assert.deepEqual(unloaded,[['llama3.2:3b','generator'],['kev:0.8b-q8_0','decision']]);
});

test('queued work is not interrupted by an idle-release timer',async t=>{
  const unloaded=[];
  let allow;
  const gate=new Promise(resolve=>{allow=resolve;});
  const scheduler=createModelScheduler({
    readSettings:async()=>settings,
    unload:async(_settings,name)=>unloaded.push(name),
    releaseDelayMs:5
  });
  t.after(()=>scheduler.close());
  const first=scheduler.enqueue(async()=>{await gate;return 1;});
  const second=scheduler.enqueue(async()=>2);
  await sleep(30);
  assert.deepEqual(unloaded,[]);
  allow();
  assert.deepEqual(await Promise.all([first,second]),[1,2]);
  await sleep(60);
  assert.deepEqual(unloaded,['llama3.2:3b','kev:0.8b-q8_0']);
});

test('failed or aborted turns still trigger model release',async t=>{
  const unloaded=[];
  const scheduler=createModelScheduler({
    readSettings:async()=>settings,
    unload:async(_settings,name)=>unloaded.push(name),
    releaseDelayMs:5
  });
  t.after(()=>scheduler.close());
  await assert.rejects(scheduler.enqueue(async()=>{throw Error('cancelled');}),/cancelled/);
  await sleep(50);
  assert.equal(unloaded.length,2);
});

test('autoUnload false is respected as a saved preference',async t=>{
  const unloaded=[];
  const scheduler=createModelScheduler({
    readSettings:async()=>({...settings,autoUnload:false}),
    unload:async(_settings,name)=>unloaded.push(name),
    releaseDelayMs:5
  });
  t.after(()=>scheduler.close());
  await scheduler.enqueue(async()=>true);
  await sleep(50);
  assert.deepEqual(unloaded,[]);
});

test('a prompt queued during release cleanup is serialized after it',async t=>{
  const order=[];
  let begin;
  const barrier=new Promise(resolve=>begin=resolve);
  const scheduler=createModelScheduler({
    readSettings:async()=>settings,
    unload:async(_settings,name)=>{
      order.push('unload:'+name);
      if(name===settings.llmModel) await barrier;
    },
    releaseDelayMs:2
  });
  t.after(()=>{begin();scheduler.close();});
  await scheduler.enqueue(async()=>{order.push('first');});
  await sleep(25);
  const second=scheduler.enqueue(async()=>{order.push('second');});
  await sleep(10);
  assert.equal(order.includes('second'),false,'user work waits for already-started unload');
  begin();
  await second;
  assert.ok(order.indexOf('second')>order.indexOf('unload:'+settings.llmModel));
});
