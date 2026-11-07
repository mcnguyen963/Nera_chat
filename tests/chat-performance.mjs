import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';
import * as vendor from '../js/vendor/gpt-tokenizer-2.9.0.js';
const plain=x=>JSON.parse(JSON.stringify(x));
const count=async text=>Math.ceil(vendor.countTokens(text)*1.02);

test('cooperative record preparation preserves full context across budgets and closed threads',async()=>{
 const names=['memory-context','lore-record-select','lore-select'];
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
