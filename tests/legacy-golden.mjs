import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {appHarness} from './app-harness.mjs';
const fx=p=>readFile(new URL('./fixtures/main-context-builder/'+p,import.meta.url),'utf8');
const tok={countTokens:async t=>Math.ceil(String(t).length/4),tokenizerReady:()=>true};
const cfg={narratorSystemPrompt:'Narrate.',maxContextTokens:12000,maxResponseTokens:2000,autoSummaryThresholdPercent:70,keepRecentMessagesAfterSummary:6};
const messages=Array.from({length:30},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'Turn '+i+' event. '.repeat(15)}));
async function api(main) {
 const sources={};if(main) for(const f of ['context-builder.js','plan-parser.js','story-text.js','request-budget.js']) sources[f]=await fx(f);
 return appHarness({sources,stubs:{'messages.js':{getMessages:async()=>messages},'tokenizer.js':tok,...(main?{'settings.js':{PLAN_THREAD_RECOVERY_RULE:JSON.parse(await fx('recovery-rule.json'))}}:{})}})('context-builder.js');
}
const scenarios=[
 {settings:{narratorSystemPrompt:'Custom narration.'+JSON.parse(await fx('recovery-rule.json'))}},
 {all:[...messages,{id:'sum',role:'summary',order:31,content:'Past events'}],session:{activeSummaryMessageId:'sum',breakpointOrder:1},settings:{maxContextTokens:900}},
 {},{all:messages.slice(0,4)},
 {all:[...messages,{id:'sum',role:'summary',order:31,content:'Past events'}],session:{activeSummaryMessageId:'sum',breakpointOrder:20}},
 {settings:{maxContextTokens:900}},{opts:{upToOrder:15}},
 {settings:{modelContextTokens:2000,maxResponseTokens:1000}},
 {all:messages.map(m=>({...m,tokenCount:999999}))},
 {all:messages.map(m=>({...m,content:m.role==='assistant'?'<think>private</think>'+m.content+'<plan_thread>private</plan_thread>':m.content}))},
 {all:[...messages,{id:'empty',order:31,role:'assistant',content:'<think>only reasoning</think>'}]},
 {all:messages.map(m=>({...m,content:'夜の物語 '+m.content}))},
 {session:{longTermPlan:'Fixed plan',allowLlmPlanUpdates:true},opts:{planOverride:'Forbidden'}},
 {settings:{maxContextTokens:50},opts:{requireLatestUser:true}},
 {settings:{maxContextTokens:0},opts:{requireLatestUser:true}},
];
test('C2 main fixtures have their original hashes',async()=>{
 for(const line of (await fx('SOURCE.txt')).split('\n').slice(1).filter(Boolean)){const [hash,f]=line.split(' ');assert.equal(createHash('sha256').update(await fx(f)).digest('hex'),hash,f);}
});
for(const [i,s] of scenarios.entries()) test('C2 main wire parity '+(i+1),async()=>{
 const main=await api(true),feature=await api(false),session={id:'s',longTermPlan:'Fixed',...s.session,allowLlmPlanUpdates:false},settings={...cfg,...s.settings},opts={messages:s.all??messages,...s.opts};delete opts.planOverride;
 let expected;try{expected=await main.buildContextForRequest(session,settings,opts);}catch(error){await assert.rejects(feature.buildContextForRequest(session,settings,opts),e=>e.message===error.message);return;}
 const actual=await feature.buildContextForRequest(session,settings,opts);
 for(const k of ['apiMessages','usedTokens','windowedCount','droppedCount','exceedsInputLimit']) assert.deepEqual(JSON.parse(JSON.stringify(actual[k])),JSON.parse(JSON.stringify(expected[k])),k);
 const a=await main.computeContextUsage(session,settings,opts.messages),b=await feature.computeContextUsage(session,settings,opts.messages);
 for(const k of ['usedTokens','max','threshold','overThreshold'])assert.equal(b[k],a[k],k);
});
