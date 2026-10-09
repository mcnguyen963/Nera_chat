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
