import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';

const sources={};
if(process.env.F17_BEFORE){for(const file of ['lore-lines.js','memory-updater.js'])sources[file]=await readFile('/private/tmp/f17-'+file.replace('.js','')+'-before.js','utf8');}
const history=Array.from({length:20},(_,i)=>({id:'m'+i,order:101+i,role:i%2?'assistant':'user',narratorTurn:Math.floor(i/2)+1,content:'Earlier event'}));
const plain=value=>JSON.parse(JSON.stringify(value));
function parserHarness(){return appHarness({sources,stubs:{'messages.js':{getMessages:async()=>[]}}});}
for(const [stamp,expected] of [['T4-T5',5],['T9-T4',9],['Turn 4-Turn 5',5]])test('F17 parses repeated turn labels in ['+stamp+']',async()=>{
  const use=parserHarness(),l=await use('lore-lines.js'),t=await use('turns.js');
  const parsed=l.parseMemoryLines('['+stamp+'] [char] Mira | notes: Kept her promise.',{messages:history,range:{fromTurn:1,toTurn:10,assistants:t.computeTurns(history).assistants}});
  assert.equal(parsed.valid,true);assert.equal(parsed.ops[0].turn,expected);assert.equal(parsed.ops[0].src,100+2*expected);
  // Existing ranges still work alongside the newly accepted second T label.
  assert.equal(l.parseMemoryLines('[T4-5] [char] Mira | notes: Kept her promise.',{messages:history,range:{fromTurn:1,toTurn:10,assistants:t.computeTurns(history).assistants}}).ops[0].turn,5);
});
test('F17 adjusted records stay separate from skipped and leave a clamped note valid',async()=>{
  const use=parserHarness(),l=await use('lore-lines.js'),t=await use('turns.js');
  const parsed=l.parseMemoryLines('[T999] [char] Mira | notes: Kept her promise.',{messages:history,range:{fromTurn:1,toTurn:10,assistants:t.computeTurns(history).assistants}});
  assert.equal(parsed.valid,true);assert.equal(parsed.skipped.length,0);assert.equal(parsed.adjusted.length,1);assert.match(parsed.adjusted[0].reason,/^adjusted:/);
  assert.equal(parsed.ops[0].turn,10);assert.equal(parsed.ops[0].src,120);
});
test('F17 updater persists adjusted T999 stamps in lastSkipped through the real extraction transaction',async()=>{
  const messages=history.slice(0,10).map((m,i)=>({...m,narratorTurn:196+Math.floor(i/2)}));
  const path='users/owner/sessions/story',docs=new Map([[path,{historyRevision:0,loreRevision:0,memoryState:{extractedThroughOrder:0}}]]);
  const ref=(_db,...parts)=>parts.join('/');
  const snapshot=key=>({exists:()=>docs.has(key),data:()=>structuredClone(docs.get(key))});
  const events=[];let calls=0;
  const use=appHarness({sources,globals:{document:{dispatchEvent:e=>events.push(e.detail)},CustomEvent:class{constructor(_type,{detail}){this.detail=detail;}}},stubs:{
    'db.js':{db:{}},'auth.js':{currentUid:()=> 'owner'},'sessions.js':{updateSession:async()=>{}},'messages.js':{getMessages:async()=>messages},
    'session-memory.js':{clearMemoryInvalidations:async()=>{},recordMemoryFailure:async()=>{throw new Error('Extraction unexpectedly failed');}},
    'tokenizer.js':{countTokens:async text=>text.length},'memory-prompts.js':{buildExtractionMessages:async({range})=>({range,messages:[]})},
    'llm-client.js':{chatCompletion:async()=>{calls++;return {content:'[T999] [char] Mira | notes: Kept her promise.'};}},
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':{doc:ref,collection:ref,getDocFromServer:async key=>snapshot(key),getDocsFromServer:async()=>({docs:[]}),onSnapshot:()=>()=>{},serverTimestamp:()=>1,Timestamp:class{},increment:()=>{},writeBatch:()=>{},runTransaction:async(_db,action)=>{
      const writes=[];const result=await action({get:async key=>snapshot(key),set:(key,value)=>writes.push([key,value]),update:(key,value)=>writes.push([key,value])});
      for(const [key,value]of writes){const dest=docs.get(key) ?? {};for(const [field,v]of Object.entries(value)){const parts=field.split('.');let target=dest;for(const part of parts.slice(0,-1))target=target[part]??={};target[parts.at(-1)]=structuredClone(v);}docs.set(key,dest);}return result;
    }}
  }});
  const {normalizeMemory}=await use('memory-settings.js'),updater=await use('memory-updater.js');
  const live={session:{id:'story',historyRevision:0,memory:normalizeMemory({autoUpdate:true,batchTurns:10,lagTurns:0}),memoryState:{extractedThroughOrder:0}},messages,entries:[],settings:{maxContextTokens:50000,maxResponseTokens:1000}};
  updater.configureMemoryUpdater({get:()=>live,busy:()=>false,waitIdle:async()=>{},patch:(_sid,patch,entries)=>{Object.assign(live.session.memoryState,patch);if(entries)live.entries=entries;}});
  assert.equal(await updater.updateNow('story'),true);
  const persisted=docs.get(path).memoryState;
  assert.equal(persisted.extractedThroughOrder,110);assert.equal(persisted.lastSkipped.length,1);assert.equal(persisted.lastSkipped[0].card,'Mira');assert.match(persisted.lastSkipped[0].reason,/adjusted:.*T999.*T200/);
  assert.deepEqual(plain(live.session.memoryState.lastSkipped),persisted.lastSkipped);
  assert.equal(live.entries[0].sections.notes.lines[0].turn,200);assert.equal(live.entries[0].sections.notes.lines[0].src,110);assert.equal(calls,1);
  assert.equal(events.some(e=>e.status==='failed'),false);
});
