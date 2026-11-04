import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';
import * as vendor from '../js/vendor/gpt-tokenizer-2.9.0.js';
const plain=x=>JSON.parse(JSON.stringify(x));
test('record render cache preserves exact context and admission across budget boundaries',async()=>{
  const sources=Object.fromEntries(await Promise.all(['lore-record-select','character-select'].map(async name=>[name+'.js',await readFile(new URL(`fixtures/wp14/${name}.txt`,import.meta.url),'utf8')])));
  const setup=async frozen=>{
    const stats={calls:0},selected=frozen?{...sources}:{'lore-record-select.js':await readFile(new URL('../js/lore-record-select.js',import.meta.url),'utf8')};
    selected['lore-record-select.js']=selected['lore-record-select.js'].replace('export function renderRecordSelection(', 'function renderRecordSelectionImpl(')+'\nexport function renderRecordSelection(...args){globalThis.renderStats.calls++;return renderRecordSelectionImpl(...args);}';
    const use=appHarness({sources:selected,globals:{renderStats:stats},stubs:{'messages.js':{getMessages:async()=>{throw Error('unexpected read');}},'tokenizer.js':{countTokens:async text=>Math.ceil(vendor.countTokens(text)*1.02),tokenizerReady:()=>true}}});
    return {stats,builder:await use('context-builder.js'),l:await use('lore-lines.js'),r:await use('lore-records.js'),settings:(await use('story-settings.js')).defaultStorySettings()};
  };
  const before=await setup(true),after=await setup(false);
  const entries=Array.from({length:6},(_,i)=>{
    const e=before.l.makeEntry('characters',`Mira${i}`,{id:`c${i}`,importance:i<2?2:3,alwaysLoad:true});
    e.sections.personality.text='Quiet, but not submissive. Café 🌙';
    e.sections.notes.lines=Array.from({length:8},(_,j)=>({id:`n${i}-${j}`,text:`Archive ${j}: Mira${i} remembers the unsigned contract.`,by:j===0?'user':'import',turn:j+1}));
    return before.r.reconcileRecords(e);
  });
  const messages=[{id:'u',role:'user',order:1,content:'I ask Mira0 about the archive and contract.'}];
  for(const budget of [0,1,49,50,99,100,199,200,499,500,1000,3000]){
    const session={id:'s',loreSchemaVersion:3,memory:{lorebooks:true,loreNotesPerSection:0,books:{characters:{on:true,budget,maxCards:20}}}};
    const settings={...before.settings,maxContextTokens:20000,maxResponseTokens:1000};
    const opts={messages,loreEntries:entries};
    const a=await before.builder.buildContextForRequest(session,settings,opts),b=await after.builder.buildContextForRequest(session,settings,opts);
    assert.deepEqual(plain(b),plain(a),`budget ${budget}`);
  }
  assert.ok(after.stats.calls<before.stats.calls/2,`renders ${after.stats.calls} vs reference ${before.stats.calls}`);
});

test('backup part sizing preserves byte boundaries with linear serialization work',async()=>{
  const current=await readFile(new URL('../js/lore-store.js',import.meta.url),'utf8'),reference=await readFile(new URL('fixtures/wp14/lore-store.txt',import.meta.url),'utf8');
  const run=source=>{
    let bytes=0;
    const json={stringify:value=>{const text=JSON.stringify(value);bytes+=text.length;return text;}};
    const snippet=source.slice(source.indexOf('function backupParts('),source.indexOf('function publishBackup('));
    const fit=new Function('clean','serverTimestamp','TextEncoder','JSON',snippet+'\nreturn backupParts;')(structuredClone,()=>123,TextEncoder,json);
    const entries=Array.from({length:650},(_,i)=>({id:'c'+i,text:'Café🌙'.repeat(450)}));
    return {parts:fit({id:'backup',reason:'test',label:'label',createdMs:1},entries,['new'],2),bytes};
  };
  const a=run(reference),b=run(current);
  assert.deepEqual(b.parts,a.parts);assert.ok(b.bytes<a.bytes/50);
});

test('4000-message accurate memory context rebuild reuses token counts',async()=>{
  let calls=0;
  const use=appHarness({stubs:{'messages.js':{getMessages:async()=>[]},'tokenizer.js':{countTokens:async text=>{calls++;return Math.ceil(text.length/4);},tokenizerReady:()=>true}}});
  const {buildContextForRequest}=await use('context-builder.js');
  const messages=Array.from({length:4000},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'Unique story message '+i+' with an observation.'}));
  const session={id:'s',memory:{memoryBlock:true}},settings={narratorSystemPrompt:'Narrate.',maxContextTokens:1000000,maxResponseTokens:100,keepRecentMessagesAfterSummary:10};
  const first=await buildContextForRequest(session,settings,{messages});assert.ok(calls>=4000);calls=0;
  const second=await buildContextForRequest(session,settings,{messages});assert.deepEqual(plain(second.apiMessages),plain(first.apiMessages));assert.equal(calls,0);
});
