// Offline DOM-fixture benchmark; prints counts/timings, never story text.
// NERA_BENCHMARK_BACKUP=/path/to/newest.json node --experimental-vm-modules --test \
//   --test-name-pattern='Long-story UX benchmark' tests/tools/benchmark-chat-interactions.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {performance} from 'node:perf_hooks';
import {harness} from '../regressions.mjs';
import {countTokens} from '../../js/vendor/gpt-tokenizer-2.9.0.js';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('Long-story UX benchmark',async()=>{
  const path=process.env.NERA_BENCHMARK_BACKUP;if(!path)throw new Error('Set NERA_BENCHMARK_BACKUP to a local story backup.');
  const data=JSON.parse(await readFile(path,'utf8')),h=await harness({extraStubs:{'tokenizer.js':{countTokens:async text=>Math.ceil(countTokens(text)*1.02),tokenizerReady:()=>true}}});h.calls.loreEntries=data.lore ?? [];
  const chat=await h.use('ui/chat-view.js');chat.initChatView();chat.setSession('benchmark');await tick();
  // The offline settings adapter supplies revision 1; no production metadata is written.
  h.calls.sessionCallbacks.at(-1)({id:'benchmark',exists:()=>true,data:()=>({...data.session,id:'benchmark',storySettingsRevision:1})});
  await h.calls.latestCallbacks.at(-1)({messages:data.messages,hasEarlier:false});
  Object.assign(h.state.settings,{modelId:'offline',apiKey:'offline',streaming:true,narrationMode:'classic',maxContextTokens:120000,modelContextTokens:null});
  h.calls.onMessageSave=()=>new Promise(()=>{});h.calls.editMessage=()=>new Promise(()=>{});h.calls.deleteMessage=()=>new Promise(()=>{});
  const target=data.messages.findLast(m=>m.role==='user'),bubble=()=>h.el('message-list').children.find(n=>n.dataset.messageId===target.id);
  await bubble().querySelectorAll('button').find(b=>b.textContent==='Edit').click();
  bubble().querySelector('textarea').value+=' ';
  let start=performance.now();await bubble().querySelectorAll('button').find(b=>b.textContent==='Save').click();const editMs=performance.now()-start;
  assert.equal(bubble().querySelector('textarea'),null);
  start=performance.now();await bubble().querySelectorAll('button').find(b=>b.textContent==='Delete').click();const deleteMs=performance.now()-start;
  assert.equal(bubble(),undefined);
  let late;h.calls.streamReader={read:()=>new Promise(resolve=>late=resolve),cancel:()=>new Promise(()=>{})};
  h.el('chat-input').value='Continue';const send=h.el('composer').dispatchEvent({type:'submit',preventDefault(){}});
  for(let i=0;i<200&&!late;i++)await tick();assert.ok(late,'Narrator must reach the mocked stream with persistence still delayed');
  start=performance.now();await h.fire('btn-stop');const cancelMs=performance.now()-start;assert.equal(h.state.busy,false);
  late({done:true});await send;
  console.log(JSON.stringify({messages:data.messages.length,loreCards:data.lore?.length ?? 0,editFeedbackMs:+editMs.toFixed(2),deleteFeedbackMs:+deleteMs.toFixed(2),composerReleaseMs:+cancelMs.toFixed(2),persistence:'indefinitely delayed mock',measurement:'desktop DOM fixture; no browser layout or phone measurement',liveFirebaseRequests:0,paidLLMCalls:0}));
  assert.ok(Math.max(editMs,deleteMs,cancelMs)<100,'Feedback and composer release target is 100 ms in this fixture');
});
