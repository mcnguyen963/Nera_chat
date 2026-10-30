import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
import {promptFetch} from './prompt-files.mjs';

const plain=x=>JSON.parse(JSON.stringify(x));
async function fixture(){
  const use=appHarness(),{makeEntry}=await use('lore-lines.js'),{normalizeMemory}=await use('memory-settings.js');
  const entries=[makeEntry('characters','Mara',{id:'mara'}),makeEntry('characters','Bram',{id:'bram'})];
  entries[0].sections.notes.text='Heals poisoned travellers with herbs.';
  entries[1].sections.notes.text='Bakes bread and cakes.';
  const mem=normalizeMemory({lorebooks:true,semanticLore:true});
  const records=new Map(),storage={load:async key=>records.get(key) ?? null,findStory:async(owner,sid)=>[...records.values()].find(v=>v.owner===owner && v.sid===sid) ?? null,save:async(value,check)=>{check();records.set(value.key,value);return true;}};
  const embedding=async(connection,texts)=>texts.map(t=>Float32Array.from(/poison|herbs|antidote/i.test(t)?[1,0]:/bread|bakes/i.test(t)?[0,1]:[0,0.2]));
  const semantic=(await use('lore-semantic.js')).createLoreSemantic({storage,embedder:embedding});
  return {use,entries,mem,semantic,records};
}
test('semantic index is scoped by account and story, and warns when its model differs',async()=>{
  const h=await fixture(),base={owner:'one',sid:'story',mem:h.mem,entries:h.entries},query='antidote for poison';
  await h.semantic.index(base);
  assert.deepEqual(plain((await h.semantic.search({...base,query})).ids),['mara']);
  assert.equal((await h.semantic.search({...base,owner:'two',query})).status,'index missing');
  assert.equal((await h.semantic.search({...base,sid:'other',query})).status,'index missing');
  const mismatched=await h.semantic.search({...base,mem:{...h.mem,semanticModel:'other'},query});
  assert.equal(mismatched.modelMismatch,true);assert.deepEqual(plain(mismatched.ids),['mara']);
  const edited=structuredClone(h.entries);edited[0].sections.notes.text='Changed since indexing.';
  const stale=await h.semantic.search({...base,entries:edited,query});
  assert.equal(stale.status,'partial index');assert.ok(!stale.ids.includes('mara'));
  assert.equal((await h.semantic.search({...base,mem:{...h.mem,semanticLore:false},query})).status,'off');
});
test('index abort and changed story never save a partial index',async()=>{
  const h=await fixture(),controller=new AbortController();controller.abort();
  await assert.rejects(h.semantic.index({owner:'a',sid:'s',mem:h.mem,entries:h.entries,signal:controller.signal}),/stopped/);
  await assert.rejects(h.semantic.index({owner:'a',sid:'s',mem:h.mem,entries:h.entries,check:()=>{throw Error('changed')}}),/changed/);
  assert.equal(h.records.size,0);
});
test('embedding connections accept HTTPS and private network HTTP, but reject unsafe URLs',async()=>{
  const {semanticConnection}=await appHarness()('lore-semantic.js');
  for(const endpoint of ['https://example.com/v1/embeddings','http://192.168.1.2:11434/v1/embeddings','http://10.0.0.4:11434/v1/embeddings','http://127.0.0.1:11434/v1/embeddings'])assert.equal(semanticConnection({semanticEndpoint:endpoint,semanticModel:'x'}).model,'x');
  for(const endpoint of ['http://example.com/v1/embeddings','http://8.8.8.8/v1/embeddings','http://user:pass@localhost:11434/v1/embeddings','https://example.com/v1/embeddings?key=secret','https://example.com/#secret'])assert.throws(()=>semanticConnection({semanticEndpoint:endpoint,semanticModel:'x'}));
});
test('device API keys are scoped to account and endpoint and used by lore and historical embeddings',async()=>{
  const values=new Map(),calls=[];
  const localStorage={getItem:k=>values.get(k) ?? null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};
  const fetch=async(url,options)=>{if(!options?.method)return promptFetch(url);calls.push({url,options});return {ok:true,json:async()=>({data:JSON.parse(options.body).input.map((_,index)=>({index,embedding:[1,0]}))})};};
  const use=appHarness({globals:{localStorage,fetch}}),{saveEmbeddingKey,getEmbeddingKey}=await use('embedding-credentials.js'),{semanticConnection,createLoreSemantic}=await use('lore-semantic.js'),{embedTexts}=await use('history-embeddings.js'),{makeEntry}=await use('lore-lines.js');
  const mem={semanticEndpoint:'https://example.test/v1/embeddings',semanticModel:'embed',semanticLore:true};
  saveEmbeddingKey('owner',mem.semanticEndpoint,'secret');
  assert.equal(getEmbeddingKey('other',mem.semanticEndpoint),'');assert.equal(getEmbeddingKey('owner','https://other.test/'),'');
  const entry=makeEntry('characters','Mara',{id:'mara'});entry.sections.notes.text='A healer.';
  let record;const storage={load:async()=>record,save:async value=>{record=value;return true;}};
  await createLoreSemantic({storage}).index({owner:'owner',sid:'s',mem,entries:[entry]});
  await embedTexts(semanticConnection(mem,'owner'),['test']);
  assert.equal(calls.length,2);for(const call of calls)assert.equal(call.options.headers.Authorization,'Bearer secret');
  assert.ok(!JSON.stringify(record).includes('secret'));
  saveEmbeddingKey('owner',mem.semanticEndpoint,'');assert.equal(getEmbeddingKey('owner',mem.semanticEndpoint),'');
});
test('semantic candidates flow through real narration and memory-update budgets',async()=>{
  let calls=0;
  const use=appHarness({stubs:{'lore-semantic.js':{loreSemantic:{search:async()=>{calls++;return {ids:['mara'],status:'ready'};}}},'messages.js':{getMessages:async()=>{throw Error('Unexpected read');}},'tokenizer.js':{countTokens:async t=>Math.ceil(t.length/4)}}});
  const {makeEntry}=await use('lore-lines.js'),{normalizeMemory}=await use('memory-settings.js'),builder=await use('context-builder.js'),prompts=await use('memory-prompts.js'),turns=await use('turns.js');
  const e=makeEntry('characters','Mara',{id:'mara'});e.sections.notes.text='UNIQUE_ANTIDOTE_DETAIL';
  const mem=normalizeMemory({lorebooks:true,memoryBlock:true,semanticLore:true,books:{characters:{budget:3000}}});
  const settings={providerCooldownAccount:'a',narratorSystemPrompt:'Narrate.',maxContextTokens:60000,maxResponseTokens:1000,keepRecentMessagesAfterSummary:10};
  const messages=[{id:'u',order:1,role:'user',content:'Who can treat this poison?'},{id:'a',order:2,role:'assistant',content:'The search begins.'}];
  const result=await builder.buildContextForRequest({id:'s',memory:mem},settings,{messages,loreEntries:[e]});
  assert.ok(result.apiMessages.some(m=>m.content.includes('UNIQUE_ANTIDOTE_DETAIL')));
  assert.equal(result.report.loaded.find(x=>x.entryId==='mara').reason,'semantic match');
  const range={assistants:turns.computeTurns(messages).assistants,fromTurn:1,toTurn:1,endOrder:2,messages};
  const update=await prompts.buildExtractionMessages({settings,mem,entries:[e],messages,range,count:async t=>Math.ceil(t.length/4),owner:'a',sid:'s'});
  assert.ok(update.messages.some(m=>m.content.includes('UNIQUE_ANTIDOTE_DETAIL')));
  const disabled=await builder.buildContextForRequest({id:'s',memory:{...mem,books:{...mem.books,characters:{...mem.books.characters,on:false}}}},settings,{messages,loreEntries:[e]});
  assert.ok(!disabled.apiMessages.some(m=>m.content.includes('UNIQUE_ANTIDOTE_DETAIL')));
  assert.ok(calls>=3);
});

test('version 3 narration keeps source-linked records available to a semantic match',async()=>{
  const use=appHarness({stubs:{'lore-semantic.js':{loreSemantic:{search:async()=>({ids:['mara'],status:'ready'})}},'messages.js':{getMessages:async()=>[]},'tokenizer.js':{countTokens:async t=>Math.ceil(t.length/4)}}});
  const {makeEntry}=await use('lore-lines.js'),records=await use('lore-records.js'),builder=await use('context-builder.js');
  const original=makeEntry('characters','Mara',{id:'mara'});original.sections.notes.text='The antidote must be diluted before use.';
  const entry=records.fromRecordDocument(records.toRecordDocument(original));
  const session={id:'s',loreSchemaVersion:3,memory:{lorebooks:true,semanticLore:true,memoryBlock:true}};
  const settings={providerCooldownAccount:'a',narratorSystemPrompt:'Narrate.',maxContextTokens:60000,maxResponseTokens:1000};
  const result=await builder.buildContextForRequest(session,settings,{messages:[{id:'u',order:1,role:'user',content:'Who can treat poison?'}],loreEntries:[entry]});
  assert.ok(result.apiMessages.some(m=>m.content.includes('The antidote must be diluted before use.')));
});

test('Director receives semantic candidates through its existing control-lore limit',async()=>{
  const use=appHarness({stubs:{'lore-semantic.js':{loreSemantic:{search:async()=>({ids:['mara'],status:'ready'})}},'tokenizer.js':{countTokens:async t=>Math.ceil(t.length/4)}}});
  const {makeEntry}=await use('lore-lines.js'),director=await use('director-context.js');
  const e=makeEntry('characters','Mara',{id:'mara'});e.sections.notes.text='UNIQUE_DIRECTOR_ANTIDOTE';
  const state={version:2,scene:{date:'21/10/738',time:'20:00',location:'Inn',present:['Nera']},event:null,decisions:[],threads:[],commitments:[]};
  const settings={providerCooldownAccount:'a',narrationMode:'director',directorProfileId:'small',profiles:[{id:'small',endpoint:'https://director.test',apiKey:'key',modelId:'m'}],activeProfileId:'small',endpoint:'https://director.test',apiKey:'key',modelId:'m',directorMaxInputTokens:20000,directorMaxOutputTokens:4000,directorRecentTurns:5};
  const result=await director.buildDirectorContext({id:'s',memory:{semanticLore:true}},settings,[{id:'u',order:1,role:'user',content:'Who can treat poison?'}],[e],state);
  assert.ok(result.report.controlMemoryIds.includes('mara'));
  assert.ok(result.apiMessages.some(m=>m.content.includes('UNIQUE_DIRECTOR_ANTIDOTE')));
});

test('a failing embedding service falls back without selecting semantic cards',async()=>{
  const h=await fixture();await h.semantic.index({owner:'a',sid:'s',mem:h.mem,entries:h.entries});
  const failure=(await h.use('lore-semantic.js')).createLoreSemantic({storage:{load:async key=>h.records.get(key)},embedder:async()=>{throw Error('offline')}});
  const result=await failure.search({owner:'a',sid:'s',mem:h.mem,entries:h.entries,query:'poison'});
  assert.equal(result.status,'unavailable');assert.deepEqual(plain(result.ids),[]);
});

test('a model dimension change requires rebuilding instead of claiming search is ready',async()=>{
  const h=await fixture();await h.semantic.index({owner:'a',sid:'s',mem:h.mem,entries:h.entries});
  const changed=(await h.use('lore-semantic.js')).createLoreSemantic({storage:{load:async key=>h.records.get(key)},embedder:async()=>[Float32Array.from([1,0,0])]});
  const result=await changed.search({owner:'a',sid:'s',mem:h.mem,entries:h.entries,query:'poison'});
  assert.equal(result.status,'index out of date');assert.deepEqual(plain(result.ids),[]);
});

test('incremental indexing reuses unchanged records and removes deleted cards',async()=>{
  const h=await fixture(),calls=[],embedding=async(_connection,texts)=>{calls.push(...texts);return texts.map(()=>Float32Array.from([1,0]));};
  const semantic=(await h.use('lore-semantic.js')).createLoreSemantic({storage:{load:async key=>h.records.get(key),save:async(value,check)=>{check();h.records.set(value.key,value);return true;}},embedder:embedding});
  const base={owner:'a',sid:'s',mem:h.mem,entries:h.entries};
  await semantic.index(base);assert.equal(calls.length,2);calls.length=0;
  const changed=structuredClone(h.entries);changed[0].sections.notes.text='A new detail.';
  await semantic.index({...base,entries:changed});assert.equal(calls.length,1);calls.length=0;
  await semantic.index({...base,entries:changed.slice(0,1)});assert.equal(calls.length,0);
  const result=await semantic.search({...base,entries:changed.slice(0,1),query:'detail'});
  assert.deepEqual(plain(result.ids),['mara']);
});

test('semantic event matches rank between recent mentions and other open threads',async()=>{
  const use=appHarness(),{makeEntry}=await use('lore-lines.js'),{normalizeMemory}=await use('memory-settings.js'),{selectEntries}=await use('lore-select.js');
  const a=makeEntry('events','A',{id:'a'}),b=makeEntry('events','B',{id:'b'}),closed=makeEntry('events','C',{id:'c'});
  for(const e of [a,b,closed]){e.kind='thread';e.status='open';}closed.status='closed';
  const mem=normalizeMemory({lorebooks:true});
  const result=selectEntries([a,b,closed],mem,'',null,'',{semanticIds:['b','c']});
  assert.equal(result.selected.events[0].entry.id,'b');assert.equal(result.selected.events[0].reason,'semantic match');
  assert.ok(!result.selected.events.some(x=>x.entry.id==='c'));
});

test('matched older record is included without opening the whole note window',async()=>{
  const use=appHarness(),{makeEntry}=await use('lore-lines.js'),records=await use('lore-records.js'),{fitRecords}=await use('lore-record-select.js');
  const e=makeEntry('facts','Secret',{id:'secret'});e.sections.text.lines=[1,2,3,4].map(n=>({id:'n'+n,text:'detail '+n,by:'auto',turn:n}));
  const entry=records.reconcileRecords(e),old=entry.recordLayout.records.find(r=>records.resolveRecord(entry,r).sources.some(s=>s.lineId==='n1'));
  const count=async t=>t.length,base=await fitRecords([{entry}],10000,count,{loreNotesPerSection:2});
  assert.doesNotMatch(base.text,/detail 1/);
  const matched=await fitRecords([{entry}],10000,count,{loreNotesPerSection:2,semanticRecords:{secret:[old.id]}});
  assert.match(matched.text,/detail 1/);assert.doesNotMatch(matched.text,/detail 2/);assert.match(matched.text,/detail 4/);
  const tooSmall=await fitRecords([{entry}],1,count,{loreNotesPerSection:2,semanticRecords:{secret:[old.id]}});assert.equal(tooSmall.text,'');
});

test('search does not automatically rebuild a missing or stale index',async()=>{
  const h=await fixture(),base={owner:'a',sid:'s',mem:h.mem,entries:h.entries};
  const result=await h.semantic.search({...base,query:'poison',check:()=>{}});assert.equal(result.status,'index missing');
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(h.records.size,0);
  await h.semantic.index(base);assert.equal(h.records.size,1);
  const prior=h.records.values().next().value;await h.semantic.search({...base,entries:[],query:'poison',check:()=>{}});
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(h.records.values().next().value,prior);
});
test('an interrupted lore rebuild keeps the active index and resumes completed batches',async()=>{
  const h=await fixture(),{createLoreSemantic}=await h.use('lore-semantic.js');
  const entries=Array.from({length:10},(_,i)=>{const e=structuredClone(h.entries[0]);e.id='entry-'+i;e.name='Character '+i;return e;});
  const records=new Map(),stages=new Map();let calls=0;
  const storage={load:async key=>records.get(key)??null,loadStage:async key=>stages.get(key)??null,save:async(value,check)=>{check();records.set(value.key,value);return true;},saveStage:async(value,check)=>{check();stages.set(value.key,structuredClone(value));return true;},removeStage:async key=>stages.delete(key)};
  const embedder=async(_connection,texts)=>{calls++;if(calls===2)throw Error('Interrupted');return texts.map(()=>[1,0]);};
  const semantic=createLoreSemantic({storage,embedder}),args={owner:'a',sid:'s',mem:h.mem,entries,force:true};
  await assert.rejects(semantic.index(args),/Interrupted/);assert.equal(records.size,0);assert.equal(stages.size,1);
  const result=await semantic.index(args);assert.equal(result.count,10);assert.equal(calls,3);assert.equal(stages.size,0);
});
