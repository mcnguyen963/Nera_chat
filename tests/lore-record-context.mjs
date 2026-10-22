import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
import {promptFetch} from './prompt-files.mjs';
const plain=x=>JSON.parse(JSON.stringify(x));
const messages=[{id:'u1',order:1,role:'user',content:'Opening.'},{id:'a1',order:2,role:'assistant',content:'First reply.'},{id:'u2',order:3,role:'user',content:'Mira waits at the Inn with the letter.'}];
const settings={narratorSystemPrompt:'Narrate.',modelId:'mock',endpoint:'https://mock.test',apiKey:'mock',streaming:false,maxContextTokens:35000,maxResponseTokens:500,keepRecentMessagesAfterSummary:4};
async function setup(){const calls=[],use=appHarness({stubs:{'messages.js':{getMessages:async()=>messages},'tokenizer.js':{countTokens:async text=>text.length}},globals:{fetch:async(url,opts)=>{if(!opts?.body)return promptFetch(url,opts);calls.push(JSON.parse(opts.body));return {ok:true,json:async()=>({choices:[{message:{content:'Mock reply.'},finish_reason:'stop'}]})};}}});return {use,calls,l:await use('lore-lines.js'),r:await use('lore-records.js'),builder:await use('context-builder.js'),prompts:await use('memory-prompts.js'),client:await use('llm-client.js')};}
function fixture(h){
 const char=h.l.makeEntry('characters','Mira');char.id='mira';char.sections.personality.text='Reserved and precise.';char.sections.appearance.text='Blue hair.';char.sections.notes.text='Obedient, not affectionate.';
 const loc=h.l.makeEntry('locations','Inn');loc.id='inn';loc.sections.description.text='A stone inn.';loc.sections.state.text='Its upper room burned.';
 const facts=h.l.makeEntry('facts','Bond');facts.id='bond';facts.alwaysLoad=true;facts.sections.text.text='A bond compels service, not affection.';
 const events=h.l.makeEntry('events','Timeline',{kind:'timeline'});events.id='timeline';events.sections.text.lines=[{id:'old',text:'Mira recovered the letter at the Inn.',turn:1,by:'import',at:1},{id:'recent',text:'A distant unrelated festival opened.',turn:99,by:'import',at:100}];
 const closed=h.l.makeEntry('events','Missing letter',{kind:'thread',status:'closed'});closed.id='thread';closed.sections.text.text='Mira already recovered the letter.';
 const entries=[char,loc,facts,events,closed].map(h.r.reconcileRecords);const core=entries[0].recordLayout.records.find(r=>h.r.resolveRecord(entries[0],r).text.includes('Obedient'));h.r.approveRecord(entries[0],core);
 const memory={lorebooks:true,protagonist:'Mira',loreLookbackMessages:0,books:{characters:{on:true,budget:450,maxCards:1},locations:{on:true,budget:180,maxCards:1},facts:{on:true,budget:400},events:{on:true,budget:550}}};return {entries,session:{id:'s',loreSchemaVersion:3,memory}};
}
test('all books select records within ceilings and inspector does not alter the serialized request',async()=>{
 const h=await setup(),{entries,session}=fixture(h),snapshot=JSON.stringify({entries,session,messages});
 const opts={messages,loreEntries:entries,requireLatestUser:true},built=await h.builder.buildContextForRequest(session,settings,opts),inspected=await h.builder.buildContextForRequest(session,settings,{...opts,includeInspection:true});
 assert.deepEqual(plain(built.apiMessages),plain(inspected.apiMessages));assert.equal(built.usedTokens,inspected.usedTokens);assert.ok(built.usedTokens<=settings.maxContextTokens);
 for(const [book,report] of Object.entries(built.report.recordSelection))assert.ok(report.budget<=session.memory.books[book].budget);
 const wire=built.apiMessages.map(m=>m.content).join('\n');for(const m of messages)assert.ok(wire.includes(m.content));assert.match(wire,/Obedient, not affectionate/);assert.ok(built.report.loaded.some(e=>e.entryId==='thread'));assert.ok(!built.report.skipped.some(e=>e.entryId==='thread'));assert.equal(entries.find(e=>e.id==='thread').status,'closed');assert.equal(JSON.stringify({entries,session,messages}),snapshot);assert.equal(h.calls.length,0);
 await h.client.chatCompletion({settings,messages:built.apiMessages});assert.equal(h.calls.length,1);assert.deepEqual(plain(h.calls[0].messages),plain(built.apiMessages));assert.doesNotMatch(JSON.stringify(h.calls[0]),/recordLayout|coreCandidate|sourceArchive|recordSelection|fingerprint/);
});
test('migrated sources produce byte-identical extraction requests and no extra calls',async()=>{
 const h=await setup(),{entries,session}=fixture(h),legacy=entries.map(({schemaVersion,recordLayout,...e})=>e),migrated=entries.map(e=>h.r.fromRecordDocument(h.r.toRecordDocument(e))),range={fromTurn:1,toTurn:1,endOrder:2,assistants:[{id:'a1',turn:1,order:2}],messages:messages.slice(0,2)},args={settings,mem:{...session.memory,updateMaxTokens:2000},messages,range,count:async text=>text.length};
 const a=await h.prompts.buildExtractionMessages({...args,entries:legacy}),b=await h.prompts.buildExtractionMessages({...args,entries:migrated});assert.deepEqual(plain(a.messages),plain(b.messages));assert.equal(h.calls.length,0);
});
test('only explicit migration switches selection; pins can select off-scene subjects without consuming optional limits',async()=>{
 const h=await setup(),{entries,session}=fixture(h),off=h.r.reconcileRecords(h.l.makeEntry('characters','Offscene'));off.sections.notes.text='Pinned identity constraint.';const pinned=h.r.reconcileRecords(off);pinned.recordLayout.records.at(-1).pinned=true;entries.push(pinned);
 const migrated=await h.builder.buildContextForRequest(session,settings,{messages,loreEntries:entries});assert.ok(migrated.report.loaded.some(e=>e.entryId===pinned.id));assert.ok(migrated.report.loaded.some(e=>e.entryId==='mira'));
 const legacy=await h.builder.buildContextForRequest({...session,loreSchemaVersion:2},settings,{messages,loreEntries:entries});assert.equal(legacy.report.recordSelection,undefined);assert.ok(!legacy.report.loaded.some(e=>e.entryId===pinned.id));
});
test('stale note evidence and future snapshot sources cannot sneak into record selection',async()=>{
 const h=await setup(),{entries,session}=fixture(h),mira=entries[0];mira.sections.status={text:'FUTURE_PLACEMENT',origin:'auto',kind:'snapshot',cutoff:{order:9},lines:[{id:'stale',text:'STALE_SECRET',by:'auto',src:2,evidence:[{id:'a1',order:2,revision:10}]}]};entries[0]=h.r.reconcileRecords(mira);
 const built=await h.builder.buildContextForRequest(session,settings,{messages,loreEntries:entries,upToOrder:4});const wire=built.apiMessages.map(m=>m.content).join('\n');assert.doesNotMatch(wire,/FUTURE_PLACEMENT|STALE_SECRET/);
});
