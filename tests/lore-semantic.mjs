import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';

const plain=x=>JSON.parse(JSON.stringify(x));
async function fixture(){
  const use=appHarness(),{makeEntry}=await use('lore-lines.js'),{normalizeMemory}=await use('memory-settings.js');
  const entries=[makeEntry('characters','Mara',{id:'mara'}),makeEntry('characters','Bram',{id:'bram'})];
  entries[0].sections.notes.text='Heals poisoned travellers with herbs.';
  entries[1].sections.notes.text='Bakes bread and cakes.';
  const mem=normalizeMemory({lorebooks:true,semanticLore:true});
  const records=new Map(),storage={load:async key=>records.get(key) ?? null,save:async(value,check)=>{check();records.set(value.key,value);return true;}};
  const embedding=async(connection,texts)=>texts.map(t=>Float32Array.from(/poison|herbs|antidote/i.test(t)?[1,0]:/bread|bakes/i.test(t)?[0,1]:[0,0.2]));
  const semantic=(await use('lore-semantic.js')).createLoreSemantic({storage,embedder:embedding});
  return {use,entries,mem,semantic,records};
}
test('semantic index is scoped by account, story, model and exact usable source content',async()=>{
  const h=await fixture(),base={owner:'one',sid:'story',mem:h.mem,entries:h.entries},query='antidote for poison';
  await h.semantic.index(base);
  assert.deepEqual(plain((await h.semantic.search({...base,query})).ids),['mara']);
  assert.equal((await h.semantic.search({...base,owner:'two',query})).status,'index missing');
  assert.equal((await h.semantic.search({...base,sid:'other',query})).status,'index missing');
  assert.equal((await h.semantic.search({...base,mem:{...h.mem,semanticModel:'other'},query})).status,'index missing');
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
test('local-only connection rejects remote endpoints and credentials',async()=>{
  const {semanticConnection}=await appHarness()('lore-semantic.js');
  for(const endpoint of ['https://example.com/v1/embeddings','http://192.168.1.2:11434/v1/embeddings','http://user:pass@localhost:11434/v1/embeddings'])assert.throws(()=>semanticConnection({semanticEndpoint:endpoint,semanticModel:'x'}));
  assert.equal(semanticConnection({semanticEndpoint:'http://127.0.0.1:11434/v1/embeddings',semanticModel:'x'}).model,'x');
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
