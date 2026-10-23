// Offline event-loop probe, not a browser or physical-phone measurement.
// node --experimental-vm-modules tests/tools/benchmark-send-responsiveness.mjs
// Add --compare to compare the working tree with HEAD's context builder.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {Worker} from 'node:worker_threads';
import {appHarness} from '../app-harness.mjs';
import {createTokenizer,createWorkerTokenizer} from '../../js/tokenizer.js';

let thread;
const workerUrl=new URL('../../js/tokenizer-worker.js',import.meta.url).href;
const offThread=createWorkerTokenizer({spawn:()=>{
 thread=new Worker(`const {parentPort}=require('node:worker_threads'); global.self={postMessage:data=>parentPort.postMessage(data)}; const ready=import(${JSON.stringify(workerUrl)}); parentPort.on('message',async data=>{await ready;self.onmessage({data});});`,{eval:true});
 const adapter={postMessage:data=>thread.postMessage(data),terminate:()=>thread.terminate()};
 thread.on('message',data=>adapter.onmessage?.({data}));thread.on('error',error=>adapter.onerror?.(error));return adapter;
}});
const inline=createTokenizer(),compare=process.argv.includes('--compare');
const baseline=compare?execFileSync('git',['show','HEAD:js/memory-context.js'],{encoding:'utf8'}):null;
try {
 for(const n of [50,500,2000]){
  let expected;
  const messages=Array.from({length:n},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',narratorTurn:Math.floor(i/2)+1,content:`Story message ${i}. `+'The traveler studies the map and heads toward the inn. '.repeat(60)}));
  for(const variant of compare?['HEAD-inline','working-worker']:['working-worker']){
   const use=appHarness({sources:variant==='HEAD-inline'?{'memory-context.js':baseline}:{},globals:{performance}});
   const {buildMemoryContext}=await use('memory-context.js'),{createTokenCounter}=await use('token-cache.js');
   const encoder=variant==='HEAD-inline'?inline:offThread;
   const count=createTokenCounter({count:encoder.countTokens,ready:encoder.tokenizerReady});
   for(const cache of ['cold','warm']){
    const start=performance.now();let previous=start,maxGap=0,ticks=0;
    const pulse=setInterval(()=>{const now=performance.now();maxGap=Math.max(maxGap,now-previous);previous=now;ticks++;},5);
    let result;
    try{result=await buildMemoryContext({memory:{memoryBlock:true,scene:true,batchTurns:5}},{narratorSystemPrompt:'Narrate.',maxContextTokens:120000,maxResponseTokens:8192,keepRecentMessagesAfterSummary:10},{messages},{count,adRule:'',normalizeAd:s=>s});}
    finally{maxGap=Math.max(maxGap,performance.now()-previous);clearInterval(pulse);}
    const wire=JSON.stringify({messages:result.apiMessages,tokens:result.usedTokens});
    if(expected)assert.equal(wire,expected);else expected=wire;
    console.log(JSON.stringify({messages:n,variant,cache,totalMs:+(performance.now()-start).toFixed(1),maxEventLoopGapMs:+maxGap.toFixed(1),heartbeatTicks:ticks,requestParity:true,liveRequests:0}));
   }
  }
 }
}finally{await thread?.terminate();}
