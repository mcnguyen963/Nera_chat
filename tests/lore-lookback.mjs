import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
async function setup(){
 const use=appHarness({stubs:{'messages.js':{getMessages:async()=>{throw Error('Unexpected history fetch');}},'tokenizer.js':{countTokens:async t=>Math.ceil(t.length/4)}}});
 const {makeEntry}=await use('lore-lines.js'),context=await use('context-builder.js'),memory=await use('memory-settings.js');
 const character=makeEntry('characters','Mira',{id:'mira',aliases:['Lady Mira']}),location=makeEntry('locations','Ashford Inn',{id:'inn',aliases:['the inn']}),closed=makeEntry('events','Lost Seal',{id:'closed',kind:'thread',status:'closed',aliases:['Seal mystery']}),open=makeEntry('events','Find the map',{id:'open',kind:'thread',status:'open'}),timeline=makeEntry('events','Timeline',{id:'timeline',kind:'timeline'});
 character.sections.notes.text='Unique character canon';location.sections.description.text='Unique location canon';closed.sections.text.text='Unique closed thread canon';open.sections.text.text='Unique open thread canon';timeline.sections.text.text='Unique timeline canon';
 const entries=[character,location,closed,open,timeline],messages=Array.from({length:7},(_,i)=>({id:'m'+(i+1),order:i+1,role:i%2 ? 'assistant' : 'user',content:i===2 ? 'Ask Lady Mira about the inn and the Seal mystery.' : 'Quiet story message '+(i+1)}));
 const settings={narratorSystemPrompt:'Narrate.',maxContextTokens:20000,maxResponseTokens:1000,keepRecentMessagesAfterSummary:2};
 const build=(n,extra={},opts={})=>context.buildContextForRequest({id:'s',memory:{lorebooks:true,...(n==null ? {} : {loreLookbackMessages:n}),...extra}},settings,{messages,loreEntries:entries,...opts});
 return {use,context,memory,entries,messages,build,settings};
}
const loaded=b=>b.report.loaded.map(e=>e.entryId);
const payload=b=>b.apiMessages.map(m=>m.content).join('\n');
test('previous-message lookback counts both user and narrator messages and honors its boundary',async()=>{
 const h=await setup(),before=JSON.stringify({messages:h.messages,entries:h.entries});
 for(const n of [0,1,3]){const b=await h.build(n);assert.ok(!loaded(b).includes('mira'));assert.ok(!loaded(b).includes('inn'));assert.ok(!loaded(b).includes('closed'));assert.ok(loaded(b).includes('open'));assert.ok(loaded(b).includes('timeline'));assert.ok(!payload(b).includes('Unique closed thread canon'));}
 for(const n of [4,7,1000]){const b=await h.build(n);for(const id of ['mira','inn','closed'])assert.ok(loaded(b).includes(id),id);assert.ok(payload(b).includes('Unique character canon'));assert.ok(payload(b).includes('Unique location canon'));assert.match(payload(b),/Closed threads \(resolved; do not reopen without new story evidence\):\n## Lost Seal/);}
 assert.equal(JSON.stringify({messages:h.messages,entries:h.entries}),before);assert.ok(loaded(await h.build(null)).includes('mira'));
});
test('current input still loads names with zero lookback and resolves closed threads explicitly',async()=>{
 const h=await setup();h.messages[6].content='Ask Lady Mira about the inn and the Seal mystery.';const b=await h.build(0);for(const id of ['mira','inn','closed'])assert.ok(loaded(b).includes(id));assert.equal(b.report.loaded.find(e=>e.entryId==='closed').reason,'mentioned');assert.equal(h.entries.find(e=>e.id==='closed').status,'closed');
});
test('narrator mentions load within one message and newest mentions win the card cap',async()=>{
 const h=await setup(),{makeEntry}=await h.use('lore-lines.js');const old=makeEntry('characters','Kael',{id:'kael'});old.sections.notes.text='Old character canon';h.entries.push(old);h.messages[4].content='Kael arrives.';h.messages[5].content='Lady Mira leaves the inn and closes the Seal mystery.';
 const b=await h.build(2,{books:{characters:{maxCards:1}}});assert.ok(loaded(b).includes('mira'));assert.ok(!loaded(b).includes('kael'));assert.ok(loaded(await h.build(1)).includes('closed'));
});
test('zero lookback retains always-load cards, protagonist and current scene while book budgets still apply',async()=>{
 const h=await setup(),{makeEntry}=await h.use('lore-lines.js');const always=makeEntry('characters','Roster',{id:'roster',alwaysLoad:true});always.sections.notes.text='Always cast';h.entries.push(always);h.messages[5].scene='date: Day 1 · time: morning · place: Ashford Inn · present: Mira';
 const b=await h.build(0,{scene:true,protagonist:'Mira',startingScene:'date: Day 1 · time: morning · place: Ashford Inn · present: Mira'});assert.ok(loaded(b).includes('roster'));assert.ok(loaded(b).includes('mira'));assert.ok(loaded(b).includes('inn'));
 const tiny=await h.build(4,{books:{characters:{budget:0},locations:{on:false},events:{budget:0}}});assert.ok(!loaded(tiny).includes('mira'));assert.ok(!loaded(tiny).includes('inn'));assert.ok(!loaded(tiny).includes('closed'));
});
test('lore lookback excludes OOC and summary records and future regeneration messages',async()=>{
 const h=await setup();h.messages[5].content='Lady Mira visits the inn for the Seal mystery.';h.messages[5].ooc=true;const b=await h.build(1);assert.ok(!loaded(b).includes('mira'));
 h.messages[5].ooc=false;h.messages[5].role='summary';assert.ok(!loaded(await h.build(1)).includes('mira'));
 const truncated=await h.build(100,{},{upToOrder:3});for(const id of ['mira','inn','closed'])assert.ok(!loaded(truncated).includes(id));
});
test('saved lookback normalizes zero and large values without a hidden small cap',async()=>{
 const {memory}=await setup();assert.equal(memory.normalizeMemory().loreLookbackMessages,4);for(const n of [0,9,10000])assert.equal(memory.normalizeMemory({loreLookbackMessages:n}).loreLookbackMessages,n);assert.equal(memory.normalizeMemory({loreLookbackMessages:'12'}).loreLookbackMessages,12);assert.equal(memory.normalizeMemory({loreLookbackMessages:-1}).loreLookbackMessages,0);assert.equal(memory.normalizeMemory({loreLookbackMessages:'bad'}).loreLookbackMessages,4);
});
