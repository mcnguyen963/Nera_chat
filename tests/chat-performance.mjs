import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';
import * as vendor from '../js/vendor/gpt-tokenizer-2.9.0.js';
const plain=x=>JSON.parse(JSON.stringify(x));
const count=async text=>Math.ceil(vendor.countTokens(text)*1.02);

test('cooperative record preparation preserves full context across budgets and closed threads',async()=>{
 const names=['memory-context','lore-record-select','lore-select','director-context'];
 const frozen=Object.fromEntries(await Promise.all(names.map(async name=>[name+'.js',await readFile(new URL('fixtures/chat-performance/'+name+'.txt',import.meta.url),'utf8')])));
 const use=appHarness({stubs:{'messages.js':{getMessages:async()=>{throw Error('Unexpected service read');}},'tokenizer.js':{countTokens:count,tokenizerReady:()=>true}}}),reference=appHarness({sources:frozen,stubs:{'messages.js':{getMessages:async()=>{throw Error('Unexpected service read');}},'tokenizer.js':{countTokens:count,tokenizerReady:()=>true}}});
 const {makeEntry}=await use('lore-lines.js'),{reconcileRecords}=await use('lore-records.js'),{defaultStorySettings}=await use('story-settings.js');
 const entries=[['characters','Míra Vale'],['characters','Silver Hall'],['locations','Hall'],['facts','C++ law'],...Array.from({length:12},(_,i)=>['events','Closed thread '+i])].map(([book,name],i)=>{
  const e=makeEntry(book,name,{id:'card-'+i,alwaysLoad:book!=='events',...(book==='events'?{kind:'thread',status:'closed'}:{})});
  e.sections[Object.keys(e.sections)[0]].text='Míra Vale and Silver Hall cannot cross Hall before 21/11/738. 雪の姫.';
  return reconcileRecords(e);
 });
 const messages=[{id:'u',order:1,role:'user',content:'Ask Míra Vale about Silver Hall and C++ law.'},{id:'a',order:2,role:'assistant',content:'The hall remains closed.'},{id:'latest',order:3,role:'user',content:'Míra Vale waits in Hall.'}];
 const build=await use('context-builder.js'),original=await reference('context-builder.js'),settings={...defaultStorySettings(),maxContextTokens:50000,maxResponseTokens:1000},before=plain(entries);
 for(const budget of [0,80,200,700,3000]){
  const session={id:'test',loreSchemaVersion:3,memory:{lorebooks:true,scene:true,memoryBlock:true,loreNotesPerSection:0,books:Object.fromEntries(['characters','locations','facts','events'].map(book=>[book,{on:true,budget,maxCards:20}]))}};
  assert.deepEqual(plain(await build.buildContextForRequest(session,settings,{messages,loreEntries:entries})),plain(await original.buildContextForRequest(session,settings,{messages,loreEntries:entries})));
 }
 assert.deepEqual(plain(entries),before);
});

test('record preparation yields between cards and aborts before further preparation',async()=>{
 const use=appHarness(),{makeEntry}=await use('lore-lines.js'),{reconcileRecords}=await use('lore-records.js'),{fitRecords}=await use('lore-record-select.js');
 const selected=Array.from({length:30},(_,i)=>{const entry=makeEntry('characters','Subject '+i,{id:'c'+i});entry.sections.personality.text='Independent, unless injured.';return {entry:reconcileRecords(entry)};});
 let time=0,yields=0,counts=0;const controller=new AbortController();
 await assert.rejects(fitRecords(selected,5000,async text=>{counts++;return text.length;},{signal:controller.signal,now:()=>time+=4,yieldTask:async()=>{if(++yields===2)controller.abort(Error('Switched story'));}}),/Switched story/);
 assert.equal(yields,2);assert.equal(counts,0,'cancellation during preparation must precede admission and counting');
});

test('scoped mention reuse preserves Unicode overlaps and a new build observes renamed aliases',async()=>{
 const use=appHarness(),{makeEntry}=await use('lore-lines.js'),select=await use('lore-select.js');
 const entries=['Silver Hall','Hall','Kael Sol','Míra Vale'].map((name,i)=>makeEntry('characters',name,{id:'c'+i}));entries[3].aliases=['雪の姫'];
 const index=select.buildLoreIndex(entries),find=select.createMentionFinder(index);
 for(const text of ['ſilver hall','Kael Sol','雪の姫 meets Míra Vale in Silver Hall','SILVER\nHALL']){
  assert.deepEqual(plain(find(text,'characters')),plain(select.findMentions(text,index,'characters')));
  assert.deepEqual(plain(find(text,'characters')),plain(select.findMentions(text,index,'characters')));
 }
 entries[3].aliases=['New Alias'];const next=select.createMentionFinder(select.buildLoreIndex(entries));
 assert.deepEqual(plain(next('雪の姫','characters')),[]);assert.deepEqual(plain(next('New Alias','characters')),['c3']);
});

test('Director preparation preserves complete requests and offered schemas while trimming',async()=>{
 const source=await readFile(new URL('fixtures/chat-performance/director-context.txt',import.meta.url),'utf8');
 const boundaries={'messages.js':{getMessages:()=>{throw Error('Unexpected service read');}},'tokenizer.js':{countTokens:count,tokenizerReady:()=>true}};
 const use=appHarness({stubs:boundaries}),frozen=appHarness({sources:{'director-context.js':source},stubs:boundaries});
 const {makeEntry}=await use('lore-lines.js'),{reconcileRecords}=await use('lore-records.js'),api=await use('director-context.js'),old=await frozen('director-context.js');
 const entries=Array.from({length:18},(_,i)=>{const e=makeEntry('characters','Person '+i,{id:'c'+i,alwaysLoad:true});e.sections.personality.text=('Person '+i+' never crosses the river before 21/11/738. ').repeat(8);return reconcileRecords(e);});
 const messages=Array.from({length:12},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:('Earlier actions and responses. ').repeat(50)+(i%2?'\n<scene>date: 21/11/738 · time: 12:00 · place: River · present: Person 1</scene>':'')}));messages.push({id:'latest',order:13,role:'user',content:'Ask Person 1 and Person 2 about the river.'});
 const before={version:2,scene:{date:'21/11/738',time:'12:00',location:'River',present:['Person 0','Person 1']},event:null,decisions:[],threads:[],commitments:[]};
 const session={id:'test',loreSchemaVersion:3,memory:{protagonist:'Person 0',lorebooks:true,books:{characters:{on:true,budget:5000,maxCards:18}}}},original=plain({entries,messages,before,session});
 for(const endpoint of ['http://local/mock','https://openrouter.ai/api/v1/chat/completions']){
  const settings={directorProfileId:'d',profiles:[{id:'d',endpoint,apiKey:'mock',modelId:'mock'}],directorMaxInputTokens:30000,directorMaxOutputTokens:1000,directorRecentTurns:5};
  const large=await old.buildDirectorContext(session,settings,messages,entries,before);
  for(const limit of [30000,large.usedTokens-100,large.usedTokens-1400]){
   const current={...settings,directorMaxInputTokens:limit};
   assert.deepEqual(plain(await api.buildDirectorContext(session,current,messages,entries,before)),plain(await old.buildDirectorContext(session,current,messages,entries,before)));
  }
 }
 assert.deepEqual(plain({entries,messages,before,session}),original);
});

test('cancelled Director preparation does not count or publish a request',async()=>{
 const controller=new AbortController();controller.abort(Error('Story changed'));
 let counts=0;const use=appHarness({stubs:{'messages.js':{getMessages:async()=>[]},'tokenizer.js':{countTokens:async()=>{counts++;return 1;}}}}),api=await use('director-context.js');
 const settings={directorProfileId:'d',profiles:[{id:'d',endpoint:'http://local',apiKey:'mock',modelId:'mock'}],directorMaxInputTokens:30000,directorMaxOutputTokens:1000,directorRecentTurns:5};
 await assert.rejects(api.buildDirectorContext({id:'s',memory:{}},settings,[{id:'u',order:1,role:'user',content:'Wait.'}],[],{}, {signal:controller.signal}),/Story changed/);assert.equal(counts,0);
});
