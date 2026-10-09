import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';

const suspect = 'Quote: "Gellert grades honesty," no that\'s for the ward tutor.\n(paraphrase of her Katarina-planting warning — careful, use sourced lines only)\n**Captain/Krail note** — Recurring.';
const clean = '# Earlier events\n**Mira** — Kept her promise.\nThe hearing had ended with a disputed verdict.';
const source = process.env.F6_BEFORE_SOURCE ? await readFile(process.env.F6_BEFORE_SOURCE,'utf8') : undefined;
function harness(content=clean) {
  let saved,calls=0;
  const use=appHarness({sources:source ? {'summarizer.js':source} : {},stubs:{
    'messages.js':{getMessages:async()=>[],getCheckpointMessages:async()=>[],newMessageId:()=> 'summary',addMessage:async(_sid,message)=>{saved=message;return {...message,historyRevision:1};}},
    'tokenizer.js':{countTokens:async text=>text.length},
    'context-builder.js':{buildContextForRequest:async()=>({usedTokens:100,report:{warnings:[]}}),computeContextUsage:async()=>({}),MESSAGE_FRAME_TOKENS:8,REQUEST_FRAME_TOKENS:8},
    'llm-client.js':{chatCompletion:async()=>{calls++;return {content,finishReason:'stop'};}}
  }});
  return {use,get saved(){return saved;},get calls(){return calls;}};
}
const plain=value=>JSON.parse(JSON.stringify(value));

test('F6 flags the owner summary self-corrections and empty bold entry once per line',async()=>{
  const {lintSummary}=await harness().use('summarizer.js');
  const hits=plain(lintSummary(suspect));
  assert.deepEqual(hits.map(hit=>hit.line),[1,2,3]);
  assert.deepEqual(hits.map(hit=>hit.text),suspect.split('\n'));
  assert.deepEqual(hits.map(hit=>hit.reasons),[['self-correction'],['self-correction'],['short-entry']]);
});
test('F6 catches comma self-notes and fewer than three words after bold entry dashes',async()=>{
  const {lintSummary}=await harness().use('summarizer.js');
  const content='careful, use this quote\nNO, THATS is wrong\nUse sourced material\n- **Guard** - Still waiting.\n**Scout** –\n**Mage** — Still carefully waiting.';
  assert.deepEqual(plain(lintSummary(content)).map(hit=>hit.line),[1,2,3,4,5]);
});
test('F6 does not flag clean prose or bold entries with three words',async()=>{
  const {lintSummary}=await harness().use('summarizer.js');
  assert.deepEqual(plain(lintSummary(clean)),[]);
  assert.deepEqual(plain(lintSummary('**Note** — Krail’s promise remained.\nThe narrator was careful.')),[]);
});
test('F6 summary commit returns warnings while preserving content and the normal single call',async()=>{
  const h=harness(suspect),{runSummarization}=await h.use('summarizer.js');
  const history=Array.from({length:8},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'Event '+i}));
  const result=await runSummarization({id:'story'},{narratorSystemPrompt:'Narrate.',maxContextTokens:50000,maxResponseTokens:1000,keepRecentMessagesAfterSummary:2},{messages:history});
  assert.equal(result.skipped,false);
  assert.equal(result.lintWarnings.length,3);
  assert.equal(h.saved.content,suspect);
  assert.equal(result.summaryMessage.content,suspect);
  assert.equal('lintWarnings' in h.saved,false);
  assert.equal('acceptance' in h.saved,false);
  assert.equal(h.calls,1);
});
