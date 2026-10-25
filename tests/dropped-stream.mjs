import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';

async function droppedStream(mode) {
  const error = new TypeError('Load failed');
  let reads = 0, cancelled = 0;
  const bytes = new TextEncoder().encode('data: '+JSON.stringify({choices:[{delta:{content:'Partial story',reasoning:'Private reasoning'}}]})+'\n');
  const reader = {
    read: async () => {
      if (!reads++) return {done:false,value:bytes};
      if (mode === 'reject') throw error;
      return {done:true};
    },
    cancel: async () => { cancelled++; },
  };
  const api = await appHarness({globals:{fetch:async () => ({ok:true,body:{getReader:() => reader}})}})('llm-client.js');
  return {
    error,
    cancelled: () => cancelled,
    call: options => api.chatCompletion({settings:{modelId:'model',endpoint:'https://example.test',streaming:true},messages:[],...options}),
  };
}

for (const mode of ['end','reject']) test(`F10 stream ${mode} preserves content and reasoning for the keep decision`, async () => {
  const h = await droppedStream(mode);
  await assert.rejects(h.call(), error => {
    assert.equal(error.aborted, 'dropped');
    assert.equal(error.partial.content, 'Partial story');
    assert.equal(error.partial.thinking, 'Private reasoning');
    if (mode === 'reject') assert.equal(error, h.error);
    else assert.match(error.message, /ended before completion/);
    return true;
  });
  assert.equal(h.cancelled(), 1);
});

test('F10 user abort retains its user reason and captured partial reply', async () => {
  const h = await droppedStream('end'), controller = new AbortController();
  await assert.rejects(h.call({signal:controller.signal,onDelta:() => controller.abort('user')}), error => {
    assert.equal(error.aborted, 'user');
    assert.equal(error.partial.content, 'Partial story');
    return true;
  });
});

test('terminal DONE completes an open stream, preserves prior usage and ignores later events',async()=>{
 for(const finalNewline of [true,false]) {
  let reads=0,cancelled=0,released=0;
  const events='data: '+JSON.stringify({choices:[{delta:{content:'Complete reply'},finish_reason:'stop'}]})+'\n\n'
   +'data: '+JSON.stringify({choices:[],usage:{prompt_tokens:17,completion_tokens:3}})+'\n\n'
   +'data: [DONE]'+(finalNewline?'\n\ndata: malformed after DONE\n':'');
  const reader={read:async()=>++reads===1?{done:false,value:new TextEncoder().encode(events)}:new Promise(()=>{}),cancel:async()=>{cancelled++;},releaseLock:()=>{released++;}};
  const api=await appHarness({globals:{fetch:async()=>({ok:true,body:{getReader:()=>reader}})}})('llm-client.js');
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort('test did not finish'),100);
  try {
   const result=await api.chatCompletion({settings:{modelId:'model',endpoint:'https://example.test',streaming:true},messages:[],signal:controller.signal});
   assert.equal(result.content,'Complete reply');assert.equal(result.finishReason,'stop');assert.equal(result.usage.prompt_tokens,17);
   assert.equal(reads,1);assert.equal(cancelled,1);assert.equal(released,1);
  }finally{clearTimeout(timer);controller.abort();}
 }
});

test('terminal DONE excludes later content in the same or following chunk',async()=>{
 for(const sameChunk of [true,false]) {
  const end='data: '+JSON.stringify({choices:[{delta:{content:'First'},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n';
  const late='data: '+JSON.stringify({choices:[{delta:{content:'After DONE'}}]})+'\n\n';
  const chunks=sameChunk?[end+late]:[end,late],received=[];let reads=0;
  const api=await appHarness({globals:{fetch:async()=>({ok:true,body:{getReader:()=>({read:async()=>++reads<=chunks.length?{done:false,value:new TextEncoder().encode(chunks[reads-1])}:{done:true},cancel:async()=>{}})}})}})('llm-client.js');
  const result=await api.chatCompletion({settings:{modelId:'model',endpoint:'https://example.test',streaming:true},messages:[],onDelta:t=>received.push(t)});
  assert.equal(result.content,'First');assert.deepEqual(received,['First']);assert.equal(reads,1);
 }
});
