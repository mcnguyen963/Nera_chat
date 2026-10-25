import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';
import {promptFetch} from './prompt-files.mjs';
import {buildComparisonRequests,comparisonWarnings,main,BASELINE_COMMIT} from './tools/narrator-comparison.mjs';
import {MODEL,LIMITS} from './tools/director-eval.mjs';
import {EvaluationBudget,inputBounds} from './tools/lorebook-eval-core.mjs';
import {countTokens,tokenizerStatus} from './tools/production-tokenizer.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
test('Paid Narrator comparison requires confirmation before any key read or completion',async()=>{
 for(const args of [[],['--approved-budget','0.10'],['--confirm-live','yes','--approved-budget','0.40']])await assert.rejects(main(['run','--key-file','/missing-key',...args]),/separate user confirmation/);
 assert.equal(BASELINE_COMMIT,'3f5be8a8ee8a759c862520f4f265c0bcff81a823');
});
test('Eight offline requests compare identical contracts, alternate order, and stay within the price/budget caps',async()=>{
 const frozen=await readFile(new URL('./fixtures/narrator-context/memory-context.js',import.meta.url),'utf8');
 const stubs={'tokenizer.js':{countTokens,tokenizerStatus},'messages.js':{getMessages:async()=>{throw Error('No external story reads');}}};
 const frozenRules=await readFile(new URL('./fixtures/narrator-context/director-narrator.md',import.meta.url),'utf8');
 const baseline=appHarness({stubs,globals:{fetch:url=>String(url).endsWith('/director-narrator.md')?Promise.resolve({ok:true,text:async()=>frozenRules}):promptFetch(url)},sources:{'memory-context.js':frozen}}),candidate=appHarness({stubs});
 const {requests,settings}=await buildComparisonRequests(baseline,candidate);assert.equal(requests.length,8);
 const budget=new EvaluationBudget([],LIMITS);let maximum=0;
 for(const request of requests){
  assert.equal(request.body.model,MODEL);assert.equal(request.body.reasoning.effort,'high');assert.equal(request.body.provider.max_price.completion,.4);assert.equal(request.body.max_tokens,8192);assert.equal(request.body.stream,true);
  const bound=inputBounds(request.body,request.inputTokens),row=budget.reserve({scenario:request.scenario,inputBound:bound.inputBound,maxTokens:request.body.max_tokens});maximum+=row.reservedMicros;
  budget.settle(row,{cost:row.reservedMicros/1e6});assert.equal(row.status,'received');
 }
 assert.ok(maximum<=100000);assert.ok(requests.find(r=>r.scenario==='emotional-history').inputTokens>7000);
 for(let i=0;i<requests.length;i+=2){const pair=requests.slice(i,i+2);assert.deepEqual(plain(pair[0].contract),plain(pair[1].contract));assert.deepEqual(plain(pair[0].before),plain(pair[1].before));assert.deepEqual(plain(pair[0].after),plain(pair[1].after));assert.equal(pair[0].scenario,pair[1].scenario);assert.notEqual(pair[0].variant,pair[1].variant);assert.equal(pair[0].variant,i%4?'candidate':'baseline');}
 const candidateArrival=requests.find(r=>r.scenario==='arrival'&&r.variant==='candidate'),oldArrival=requests.find(r=>r.scenario==='arrival'&&r.variant==='baseline');
 assert.ok(candidateArrival.report.loaded.some(e=>e.entryId==='dara'));assert.ok(!oldArrival.report.loaded.some(e=>e.entryId==='dara'));
 assert.ok(candidateArrival.body.messages.some(m=>m.content.startsWith('[Reply brief')));assert.ok(!oldArrival.body.messages.some(m=>m.content.startsWith('[Reply brief')));
 // Rehearse all final production serializers and response parsing with fake SSE.
 let calls=0;const mock=appHarness({globals:{fetch:async(_url,opts)=>{
  const body=JSON.parse(opts.body),request=requests[calls++];assert.deepEqual(plain({...body,provider:undefined}),plain({...request.body,provider:undefined}));
  return new Response('data: '+JSON.stringify({choices:[{delta:{content:'The NPC waits for the player.'},finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:100,completion_tokens:10,cost:.001}})+'\n\ndata: [DONE]\n\n');
 }}}),client=await mock('llm-client.js');
 for(const request of requests){const response=await client.chatCompletion({settings,messages:request.body.messages});assert.equal(response.finishReason,'stop');assert.equal(response.content,'The NPC waits for the player.');}
 assert.equal(calls,8);
});


test('Captured failure excerpts remain visible to the fixture diagnostics without flagging a faithful short response',()=>{
 const captured=[['arrival','Twice you pass through gates in the old inner wall.'],['blocked','The lock plate has been welded over the old keyhole.'],['emotional-history','You asked me how the road was. You said the weather was turning.'],['emotional-history','You said that. Two days ago.'],['pending-choice',"I don't charge for the first."]];
 for(const [scenario,text] of captured)assert.equal(comparisonWarnings(text,scenario).length,1);
 for(const [scenario,text] of [['arrival','The walk takes one hour. You arrive outside the blue door.'],['blocked','The crossing is closed; there is no way across.'],['emotional-history','Dara says, "You kept the missing letter from me for two days. I am still hurt."']])assert.equal(comparisonWarnings(text,scenario).length,0);
});
