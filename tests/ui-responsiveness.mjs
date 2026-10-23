import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from 'node:worker_threads';
import {appHarness} from './app-harness.mjs';
import {createWorkerTokenizer} from '../js/tokenizer.js';
import {createWorkBudget} from '../js/ui-work.js';
import {countTokens} from '../js/vendor/gpt-tokenizer-2.9.0.js';

function workerFixture(){
 let time=0,serial=0;const jobs=new Map(),workers=[];
 const tokenizer=createWorkerTokenizer({now:()=>time,schedule:fn=>{jobs.set(++serial,fn);return serial;},cancel:id=>jobs.delete(id),spawn:()=>{
  const worker={sent:[],postMessage(data){this.sent.push(data);},terminate(){this.terminated=true;}};workers.push(worker);return worker;
 }});
 return {tokenizer,workers,jobs,advance:ms=>time+=ms};
}
test('worker counts concurrent requests by ID, and settles every pending request on failure',async()=>{
 const h=workerFixture(),a=h.tokenizer.countTokens('hello'),b=h.tokenizer.countTokens('你好');
 const worker=h.workers[0];assert.equal(h.workers.length,1);
 worker.onmessage({data:{id:worker.sent[1].id,count:3,ready:true}});assert.equal(await b,3);
 worker.onerror();assert.equal(await a,5);assert.equal(h.tokenizer.tokenizerStatus(),'fallback');assert.equal(h.jobs.size,0);
 assert.equal(await h.tokenizer.countTokens('你好'),6);assert.equal(h.workers.length,1);
 h.advance(30000);const recovered=h.tokenizer.countTokens('hello');const fresh=h.workers[1];
 worker.onmessage({data:{id:fresh.sent[0].id,count:999,ready:true}});
 fresh.onmessage({data:{id:fresh.sent[0].id,count:2,ready:true}});
 assert.equal(await recovered,2);assert.equal(h.tokenizer.tokenizerReady(),true);
});
test('a stalled or unavailable worker returns estimates and can recover without hanging Send',async()=>{
 const h=workerFixture(),a=h.tokenizer.countTokens('hello'),b=h.tokenizer.countTokens('world');
 h.jobs.values().next().value();assert.deepEqual(await Promise.all([a,b]),[5,5]);assert.equal(h.jobs.size,0);
 const unavailable=createWorkerTokenizer({spawn:()=>{throw new Error('blocked');}});
 assert.equal(await unavailable.countTokens('é'),2);assert.equal(unavailable.tokenizerStatus(),'fallback');
});
test('real worker preserves the pinned encoder counts for Unicode and long text',async()=>{
 const url=new URL('../js/tokenizer-worker.js',import.meta.url).href;
 let thread;
 const tokenizer=createWorkerTokenizer({spawn:()=>{
  thread=new Worker(`const {parentPort}=require('node:worker_threads'); global.self={postMessage:data=>parentPort.postMessage(data)}; const ready=import(${JSON.stringify(url)}); parentPort.on('message',async data=>{await ready;self.onmessage({data});});`,{eval:true});
  const adapter={postMessage:data=>thread.postMessage(data),terminate:()=>thread.terminate()};
  thread.on('message',data=>adapter.onmessage?.({data}));thread.on('error',error=>adapter.onerror?.(error));return adapter;
 }});
 try {
  const texts=['hello world','Xin chào 👋 世界','The traveler returns. '.repeat(2000)];
  assert.deepEqual(await Promise.all(texts.map(tokenizer.countTokens)),texts.map(text=>Math.ceil(countTokens(text)*1.02)));
  assert.equal(tokenizer.tokenizerStatus(),'ok');
 }finally{await thread?.terminate();}
});
test('cached preparation yields actual tasks within its budget and rejects cancelled work',async()=>{
 let time=0,yields=0;const abort=new AbortController();
 const work=createWorkBudget({signal:abort.signal,now:()=>time,yieldTask:async()=>{yields++;}});
 await work();time=7;await work();assert.equal(yields,0);
 time=8;await work();assert.equal(yields,1);
 abort.abort();await assert.rejects(work(),{name:'AbortError'});assert.equal(yields,1);
});
test('feedback gets an animation frame and a task boundary before preparation resumes',async()=>{
 const frames=[],tasks=[];const {afterUiPaint}=await appHarness({globals:{document:{hidden:false},requestAnimationFrame:fn=>frames.push(fn),setTimeout:fn=>tasks.push(fn)}})('ui-work.js');
 let resumed=false;const pending=afterUiPaint().then(()=>resumed=true);
 assert.equal(resumed,false);frames.shift()();await Promise.resolve();assert.equal(resumed,false);
 tasks.shift()();await pending;assert.equal(resumed,true);
});
