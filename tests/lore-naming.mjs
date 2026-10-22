import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
import {promptFetch} from './prompt-files.mjs';

const plain=value=>JSON.parse(JSON.stringify(value));
const history=[{id:'u1',order:1,role:'user',content:'Meet the Silver Captain at Raven Hall for the Founders’ Reception and discuss the succession charter.'},{id:'a1',order:2,role:'assistant',content:'Mira Vale, the Silver Captain, waits in Raven Hall, also called Raven House. The Founders’ Reception is also called the Founding Banquet. Arvayne succession law is known as the succession charter. Mira accepts the task of recovering the invitation.'}];
const settings={narratorSystemPrompt:'Narrate.',maxContextTokens:60000,maxResponseTokens:1000,modelId:'mock',endpoint:'https://mock.test',apiKey:'mock',streaming:false};
async function setup(){
  const calls=[],use=appHarness({stubs:{'messages.js':{getMessages:async()=>history},'tokenizer.js':{countTokens:async t=>Math.ceil(t.length/4)}},globals:{fetch:async(url,opts)=>{
    if(!opts?.body)return promptFetch(url,opts);
    calls.push(opts.body);return {ok:true,json:async()=>({choices:[{message:{content:'Mock reply.'},finish_reason:'stop'}]})};
  }}});
  const lore=await use('lore-lines.js'),memory=await use('memory-settings.js'),turns=await use('turns.js');
  const mem=memory.normalizeMemory({lorebooks:true,batchTurns:2,lagTurns:0,loreLookbackMessages:0,books:{characters:{budget:3000},locations:{budget:3000},facts:{budget:3000},events:{budget:3000}}});
  const range={assistants:turns.computeTurns(history).assistants,fromTurn:1,toTurn:1,endOrder:2,messages:history};
  return {use,lore,mem,range,calls,ctx:{messages:history,range,mem}};
}
const output=[
  'T1 [alias] events | Founders\' Reception | Founding Banquet',
  'T1 [alias] characters | Mira Vale | Silver Captain',
  'T1 [alias] locations | Raven Hall | Raven House',
  'T1 [alias] facts | Arvayne succession law | succession charter',
  'T1 [char] Mira Vale | notes: NAMING_CHARACTER: accepted responsibility for the invitation.',
  'T1 [loc] Raven Hall | description: NAMING_LOCATION: a stone hall.',
  'T1 [fact] Arvayne succession law | NAMING_FACT: inheritance follows the charter.',
  'T1 [open] Founders\' Reception | NAMING_THREAD: recover the invitation.',
].join('\n');

test('extraction seeds all four books and aliases survive export and reach later serialized requests in both storage modes',async()=>{
  const h=await setup(),parsed=h.lore.parseMemoryLines(output,h.ctx);
  assert.equal(parsed.skipped.length,0);assert.equal(parsed.ops.length,8);
  const changes=h.lore.applyOps([],parsed.ops,{mem:h.mem});
  assert.equal(changes.creates.length,4);assert.equal(changes.aliases.length,4);
  const format=await h.use('lore-format.js'),records=await h.use('lore-records.js'),builder=await h.use('context-builder.js');
  // Closed threads must be recalled by the alias, without open-thread fallback.
  changes.entries.find(e=>e.book==='events').status='closed';
  const draft='Silver Captain visits Raven House for the Founding Banquet under the succession charter.';
  for(const version of [2,3]){
    const entries=version===3 ? changes.entries.map(e=>records.fromRecordDocument(records.toRecordDocument(e))) : changes.entries;
    for(const kind of ['json','md']){
      const restored=kind==='json'?format.fromJson(format.toJson(entries)).entries:format.fromMarkdown(format.toMarkdown(entries)).entries;
      for(const e of entries)assert.deepEqual(plain(restored.find(r=>r.name===e.name).aliases),plain(e.aliases));
    }
    const built=await builder.buildContextForRequest({id:'s',loreSchemaVersion:version,memory:h.mem},settings,{messages:history,loreEntries:entries,draftText:draft,includeInspection:true});
    const client=await h.use('llm-client.js');
    await client.chatCompletion({settings,messages:built.apiMessages});
    const serialized=h.calls.at(-1);
    for(const marker of ['CHARACTER','LOCATION','FACT','THREAD'])assert.ok(serialized.includes('NAMING_'+marker));
    for(const e of entries){assert.ok(built.report.loaded.some(r=>r.entryId===e.id));assert.ok(!built.report.skipped.some(r=>r.entryId===e.id));}
    const empty=await builder.buildContextForRequest({id:'s',loreSchemaVersion:version,memory:{...h.mem,books:{...h.mem.books,events:{on:true,budget:0}}}},settings,{messages:history,loreEntries:entries,draftText:draft});
    assert.ok(empty.report.skipped.some(r=>r.book==='events'&&/budget/.test(r.reason)));
    assert.ok(!JSON.stringify(empty.apiMessages).includes('NAMING_THREAD'));
  }
});

test('existing identity metadata stays unchanged while notes can target saved aliases',async()=>{
  const h=await setup(),old=h.lore.makeEntry('facts','Arvayne law',{aliases:['succession charter']});
  const before=plain(old);
  const parsed=h.lore.parseMemoryLines('T1 [fact] succession charter | A confirmed amendment.\nT1 [alias] facts | Arvayne law | new charter',h.ctx);
  const result=h.lore.applyOps([old],parsed.ops);
  assert.equal(result.creates.length,0);assert.equal(result.appends[0].entryId,old.id);
  assert.equal(result.entries[0].name,old.name);assert.deepEqual(plain(result.entries[0].aliases),old.aliases);
  assert.match(result.skipped[0].reason,/saved card names and aliases are preserved/);assert.deepEqual(plain(old),before);
});

test('aliases cannot create blank cards, collide with identities or mutate Timeline or Plan',async()=>{
  const h=await setup();
  const parsed=h.lore.parseMemoryLines(output+'\nT1 [alias] facts | Missing topic | Lost charter\nT1 [alias] events | Timeline | Founding Banquet\nT1 [alias] plan | Reception | Founding Banquet\nT1 [alias] facts | Arvayne succession law | the guard\nT1 [alias] facts | Arvayne succession law | '+ 'x'.repeat(61),h.ctx);
  assert.ok(parsed.skipped.some(s=>/format or book/.test(s.reason)));assert.equal(parsed.skipped.filter(s=>s.reason==='not a valid alias').length,2);
  const result=h.lore.applyOps([],parsed.ops);
  assert.equal(result.creates.length,4);assert.ok(result.skipped.some(s=>/not created/.test(s.reason)));
  const old=h.lore.makeEntry('locations','Raven House');
  const collision=h.lore.applyOps([old],h.lore.parseMemoryLines(output,h.ctx).ops);
  assert.ok(collision.skipped.some(s=>s.reason==='name already used by Raven House'));
  assert.deepEqual(plain(collision.creates.find(e=>e.book==='locations').aliases),[]);
  const timeline=h.lore.applyOps([],h.lore.parseMemoryLines('T1 [event] The reception ended.\nT1 [alias] events | Timeline | Founding Banquet',h.ctx).ops);
  assert.equal(timeline.creates[0].kind,'timeline');assert.equal(timeline.aliases.length,0);assert.match(timeline.skipped[0].reason,/card kind/);
});

test('matching normalizes apostrophes and whitespace but retains word boundaries and offsets',async()=>{
  const h=await setup(),select=await h.use('lore-select.js');
  for(const book of ['characters','locations','facts','events']){
    const e=h.lore.makeEntry(book,"Founders' Reception",{aliases:['Founding Banquet'],kind:book==='events'?'thread':'card',status:'closed'}),index=select.buildLoreIndex([e]);
    const phrase='Attend Founders’  Reception.';
    assert.deepEqual(plain(select.findMentions(phrase,index,book)),[e.id]);
    assert.equal(select.findMentionOccurrences(phrase,index,book)[0].start,7);
    for(const text of ['Arvayne','Reception','UnFounding Banquets'])assert.equal(select.findMentions(text,index,book).length,0);
  }
  const closed=h.lore.makeEntry('events',"Founders' Reception",{kind:'thread',status:'closed'});
  const missed=select.selectEntries([closed],h.mem,'Arvayne',null);
  assert.equal(missed.selected.events.length,0);assert.equal(missed.skipped[0].reason,'no name or alias match');
});

test('extraction supplies naming contract with custom prompts and matched closed-thread identities with status',async()=>{
  const h=await setup(),prompts=await h.use('memory-prompts.js');
  const closed=h.lore.makeEntry('events','Reception invitation',{kind:'thread',status:'closed',aliases:["Founders' Reception"]});
  const built=await prompts.buildExtractionMessages({settings:{...settings,memoryExtractionPrompt:'CUSTOM EXTRACTION'},mem:h.mem,entries:[closed],messages:history,range:h.range,count:async t=>Math.ceil(t.length/4)});
  assert.ok(built.messages[0].content.startsWith('CUSTOM EXTRACTION'));
  assert.match(built.messages[0].content,/CARD NAMING AND RECALL CONTRACT/);
  assert.match(built.messages[0].content,/\[alias\] BOOK \| EXACT NEW CARD NAME \| PHRASE/);
  assert.ok(built.messages[1].content.includes(JSON.stringify({name:closed.name,aliases:closed.aliases,status:'closed'})));
  const long=h.lore.makeEntry('facts','An existing imported card with a deliberately very long canonical name beyond sixty characters');
  const parsed=h.lore.parseMemoryLines('T1 [fact] '+long.name+' | Updated detail.',{...h.ctx,entries:[long]});
  assert.equal(parsed.ops.length,1);assert.equal(h.lore.applyOps([long],parsed.ops).appends[0].entryId,long.id);
});

test('legacy category JSON preserves fact and thread aliases without a v2 entries array',async()=>{
  const h=await setup(),format=await h.use('lore-format.js'),entries=h.lore.applyOps([],h.lore.parseMemoryLines(output,h.ctx).ops).entries;
  const json=JSON.parse(format.toJson(entries));delete json.entries;json.version=1;
  const restored=format.fromJson(JSON.stringify(json)).entries;
  for(const e of entries)assert.deepEqual(plain(restored.find(r=>r.book===e.book&&r.name===e.name).aliases),plain(e.aliases));
});
