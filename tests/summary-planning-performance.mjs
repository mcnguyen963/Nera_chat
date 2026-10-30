import test from 'node:test';
import assert from 'node:assert/strict';
import { appHarness } from './app-harness.mjs';

const history = count => Array.from({length:count}, (_, i) => ({
  id:'m'+i, order:i+1, narratorTurn:Math.floor(i/2)+1,
  role:i%2 ? 'assistant' : 'user', content:'An event.', acceptance:'accepted',
}));
const settings = {keepRecentMessagesAfterSummary:0, summarizerChunkTokens:100000};
const orders = plan => Array.from(plan.toFold ?? [], m => m.order);
const summarizer = () => appHarness({stubs:{
  'messages.js':{getMessages:async()=>[], getCheckpointMessages:async()=>[], addMessage:async()=>{}, newMessageId:()=> 'summary'},
  'tokenizer.js':{countTokens:async()=>0, tokenizerReady:()=>true},
  'llm-client.js':{chatCompletion:async()=>({})},
}})('summarizer.js');

test('summary review preserves earlier accepted replies and stops before incomplete director turns', async () => {
  const {planSummary} = await summarizer();
  const messages = history(10);
  messages[3].acceptance = 'pending'; // A later user makes this reply eligible.
  messages[7].directorIncomplete = true;
  const plan = planSummary({id:'s', memory:{scene:true}}, settings, messages);
  assert.deepEqual(orders(plan), [3,4,5,6]);
  assert.equal(plan.newBreakpointOrder, 6);

  messages[3].directorIncomplete = true;
  assert.equal(planSummary({id:'s', memory:{scene:true}}, settings, messages).skip, 'pending-reply');
  messages[3].directorIncomplete = false;
  messages[7].directorIncomplete = false;
  messages[9].acceptance = 'rejected'; // No later user has accepted the last reply.
  assert.deepEqual(orders(planSummary({id:'s', memory:{scene:true}}, settings, messages)), [3,4,5,6,7,8]);
  assert.deepEqual(orders(planSummary({id:'s', memory:{scene:false}}, settings, messages)), [3,4,5,6,7,8,9,10]);
});

test('summary review work grows linearly with story history', async () => {
  const {planSummary} = await summarizer();
  const counts = [];
  for (const count of [100, 1000]) {
    let reads = 0;
    const messages = history(count).map(message => new Proxy(message, {
      get(target, key) { if (key === 'role') reads++; return target[key]; },
    }));
    const plan = planSummary({id:'s', memory:{scene:true}}, settings, messages);
    assert.equal(plan.newBreakpointOrder, count);
    counts.push(reads);
  }
  assert.ok(counts[1] < counts[0] * 12, `role reads: ${counts.join(', ')}`);
});

test('a coordinated summary never passes the completed batch boundary',async()=>{
  const {planSummary}=await summarizer(),messages=history(12);
  assert.deepEqual(orders(planSummary({id:'s'},settings,messages,{throughOrder:7})),[3,4,5,6]);
  assert.equal(planSummary({id:'s'},settings,messages,{throughOrder:6}).newBreakpointOrder,6);
});
