import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
async function setup({fail=false}={}){const calls=[],sessions=[{id:'s',title:'Story',storySettingsRevision:1}],lore=[];const use=appHarness({globals:{document:{dispatchEvent:e=>calls.push(['notice',e.detail])},CustomEvent:class{constructor(type,v){this.type=type;Object.assign(this,v);}}},stubs:{'auth.js':{currentUid:()=> 'owner'},'sessions.js':{createSession:async(...args)=>{calls.push(['create',...args]);return 's';},updateSession:async(...args)=>calls.push(['publish',...args]),deleteSession:async id=>calls.push(['delete',id]),getSession:async()=>sessions[0],listSessions:async()=>sessions},'messages.js':{getMessages:async()=>[{id:'u',order:1,role:'user',content:'Text'}],addMessagesBulk:async()=>{calls.push(['chunks']);if(fail)throw Error('write failed');}},'lore-store.js':{migrateRecords:async(...args)=>calls.push(['migrate',...args]),getLore:async()=>lore,importLore:async(_sid,plan)=>{lore.push(...plan.writes.map(w=>w.data));calls.push(['lore']);}},'ui/memory-ui.js':{download:(...args)=>calls.push(['download',...args])}}});return {api:await use('import-export.js'),calls,lore,sessions,use};}
const file=(head={})=>({name:'story.jsonl',size:200,text:async()=>[JSON.stringify({character_name:'Story',nera:{version:2,session:head,lore:[{book:'characters',name:'Mira'},null]}}),'null','[1]',JSON.stringify({mes:'Hi',is_user:true})].join('\n')});
test('D5 import publishes only after chunks and normalized lore; no imported revision',async()=>{const h=await setup();await h.api.importSillyTavern(file({historyRevision:999,memory:{autoUpdate:true,sceneFallback:true,updateMaxTokens:32000}}));assert.equal(h.calls[0][2].importing,true);assert.deepEqual(h.calls.slice(0,4).map(c=>c[0]),['create','chunks','lore','publish']);const patch=h.calls[3][2];assert.equal('historyRevision'in patch,false);assert.equal(patch.importing,false);assert.equal(patch.memory.autoUpdate,false);assert.equal(patch.memory.sceneFallback,false);assert.equal(patch.memory.updateMaxTokens,2000);assert.ok(h.lore[0].id);assert.ok(h.lore[0].sections.notes.lines);assert.equal(h.calls.at(-1)[1].droppedLore,1);});
test('D5 failed import stays unpublished and requests resumable cleanup',async()=>{const h=await setup({fail:true});await assert.rejects(h.api.importSillyTavern(file()),/write failed/);assert.deepEqual(h.calls.map(c=>c[0]),['create','chunks','delete']);});
test('R4 null lines are skipped and files over sixty-four MB rejected before reading',async()=>{const h=await setup();assert.equal(h.api.parseSillyTavernJsonl('null\n'+JSON.stringify({mes:'Hi',is_user:true})).messages.length,1);let read=false;await assert.rejects(h.api.importSillyTavern({size:65*1024*1024,text:async()=>{read=true;}}),/64 MB/);assert.equal(read,false);});
test('Full story backups over twenty MB remain importable',async()=>{
 const h=await setup(),backup={format:'nera-chat-backup',session:{title:'Long story'},messages:[{id:'u',order:1,role:'user',content:'Continue.'}],lore:[]};
 // Whitespace reproduces pretty-printed backup overhead without an oversized document.
 const text=JSON.stringify(backup)+' '.repeat(21*1024*1024);
 await h.api.importSillyTavern({name:'long-backup.json',size:new TextEncoder().encode(text).length,text:async()=>text});
 assert.equal(h.calls.find(c=>c[0]==='publish')[2].importing,false);
});
test('Story import verifies UTF-8 bytes when supplied file size is missing or inaccurate',async()=>{
 const h=await setup(),text='é'.repeat(33*1024*1024);
 await assert.rejects(h.api.importSillyTavern({name:'large.json',size:1,text:async()=>text}),/64 MB/);
 assert.equal(h.calls.length,0);
});
test('P2 account download contains every story, reports progress and cancels without a download',async()=>{const h=await setup(),progress=[];h.sessions.push({id:'b',title:'B',storySettingsRevision:1});assert.equal(await h.api.exportAllStories({onProgress:p=>progress.push(p)}),2);const download=h.calls.at(-1);assert.equal(download[0],'download');assert.equal((download[1].match(/neraStorySeparator/g) ?? []).length,2);assert.equal(progress.at(-1).done,2);const controller=new AbortController();h.calls.length=0;await assert.rejects(h.api.exportAllStories({signal:controller.signal,onProgress:()=>controller.abort()}),e=>e.name==='AbortError');assert.equal(h.calls.length,0);});

const importFile=(records)=>({name:'mixed.jsonl',size:500,text:async()=>records.map(record=>JSON.stringify(record)).join('\n')});
test('E5 mixed Nera and plain message orders reset imported extraction progress',async()=>{
 const h=await setup();
 await h.api.importSillyTavern(importFile([
  {character_name:'Mixed',nera:{version:2,session:{memoryState:{extractedThroughOrder:40}}}},
  {mes:'Nera narration.',nera:{message:{id:'a',role:'assistant',order:40}}},
  {mes:'Plain new input.',is_user:true},
 ]));
 assert.equal(h.calls.find(c=>c[0]==='publish')[2].memoryState.extractedThroughOrder,0);
});
test('E5 fully ordered Nera imports preserve and clamp extraction progress',async()=>{
 for (const [pointer,expected] of [[35,35],[90,40],[null,null]]) {
  const h=await setup();
  await h.api.importSillyTavern(importFile([
   {character_name:'Ordered',nera:{version:2,session:{memoryState:{extractedThroughOrder:pointer}}}},
   {mes:'Input.',nera:{message:{id:'u',role:'user',order:39}}},
   {mes:'Narration.',nera:{message:{id:'a',role:'assistant',order:40}}},
  ]));
  assert.equal(h.calls.find(c=>c[0]==='publish')[2].memoryState.extractedThroughOrder,expected);
 }
});
test('E13 reserved Firestore lore ids are regenerated without changing card names or text',async()=>{
 const use=appHarness(),{normalizeLoreEntry,fromJson}=await use('lore-format.js');
 for (const id of ['__x__','__init__','.','..','bad/id']) {
  const source={id,book:'characters',name:'__init__',sections:{notes:{text:'Preserve this note.'}}};
  const normalized=normalizeLoreEntry(source);
  assert.notEqual(normalized.id,id);assert.match(normalized.id,/^lore_/);
  assert.equal(normalized.name,'__init__');assert.equal(normalized.sections.notes.text,'Preserve this note.');assert.equal(source.id,id);
  const parsed=fromJson(JSON.stringify({version:2,characters:[],entries:[source]}));assert.notEqual(parsed.entries[0].id,id);
 }
 assert.equal(normalizeLoreEntry({id:'safe-card',book:'characters',name:'Mira'}).id,'safe-card');
});

test('full V3 backup import explicitly creates a selective destination before writing records and preserves calendar',async()=>{
 const h=await setup(),l=await h.use('lore-lines.js'),r=await h.use('lore-records.js'),entry=l.makeEntry('characters','Mira'),calendar={mode:'modern',anchor:'Friday 21/10/738'};
 entry.sections.personality.text='Reserved, not affectionate.';const record=r.toRecordDocument(entry);
 const backup={format:'nera-chat-backup',session:{title:'Story',memory:{calendar},memoryState:{extractedThroughOrder:2}},lore:[record],messages:[{id:'u',role:'user',order:1,content:'Begin.'},{id:'a',role:'assistant',order:2,content:'Reply.'}]};
 await h.api.importSillyTavern({name:'full.json',size:1000,text:async()=>JSON.stringify(backup)});
 assert.deepEqual(h.calls.slice(0,5).map(c=>c[0]),['create','chunks','migrate','lore','publish']);assert.equal(h.lore[0].schemaVersion,3);assert.equal(h.lore[0].sections.personality.text,entry.sections.personality.text);
 const patch=h.calls.find(c=>c[0]==='publish')[2];assert.equal(JSON.stringify(patch.memory.calendar),JSON.stringify(calendar));assert.equal(patch.memoryState.extractedThroughOrder,2);
});

for(const schema of [2,3])for(const format of ['json','jsonl'])for(const sameBook of [true,false])test(`full ${format} lore v${schema} rejects duplicate IDs across ${sameBook?'the same book':'different books'} before any writes`,async()=>{
 const h=await setup(),{makeEntry}=await h.use('lore-lines.js'),records=await h.use('lore-records.js');
 let entries=[makeEntry('characters','Mira'),makeEntry(sameBook?'characters':'locations','Different card')];
 for(const entry of entries){entry.id='duplicate';Object.values(entry.sections)[0].text='Keep '+entry.name;}
 if(schema===3)entries=entries.map(entry=>records.toRecordDocument(entry));
 const metadata={session:{title:'Story'},lore:entries},messages=[{id:'u',order:1,role:'user',content:'Begin.'}];
 const value=format==='json'?JSON.stringify({format:'nera-chat-backup',version:1,...metadata,messages}):JSON.stringify({character_name:'Story',nera:{version:2,...metadata}})+'\n'+JSON.stringify({mes:'Begin.',is_user:true,nera:{message:messages[0]}});
 const before=JSON.stringify(entries);
 await assert.rejects(h.api.importSillyTavern({name:'backup.'+format,size:value.length,text:async()=>value}),/Duplicate lore card ID "duplicate"/);
 assert.deepEqual(h.calls,[]);assert.equal(h.lore.length,0);assert.equal(JSON.stringify(entries),before);
});

for(const schema of [2,3])test(`full lore v${schema} preserves duplicate names with distinct IDs and card dependencies`,async()=>{
 const h=await setup(),{makeEntry}=await h.use('lore-lines.js'),records=await h.use('lore-records.js');
 let entries=[makeEntry('characters','Mira'),makeEntry('characters','Mira')];entries[0].id='mira-a';entries[1].id='mira-b';
 entries[0].sections.personality.text='Reserved.';entries[1].sections.personality.text='Another character with the same name.';
 if(schema===3){entries=entries.map(entry=>records.reconcileRecords(entry));entries[0].recordLayout.records[0].relatedEntryIds=['mira-b'];entries=entries.map(entry=>records.toRecordDocument(entry));}
 const backup={format:'nera-chat-backup',version:1,session:{title:'Story'},messages:[{id:'u',order:1,role:'user',content:'Begin.'}],lore:entries},before=JSON.stringify(backup);
 await h.api.importSillyTavern({name:'backup.json',size:1000,text:async()=>JSON.stringify(backup)});
 assert.deepEqual(h.lore.map(entry=>entry.id),['mira-a','mira-b']);assert.equal(h.lore[0].sections.personality.text,'Reserved.');assert.equal(h.lore[1].sections.personality.text,'Another character with the same name.');
 if(schema===3)assert.deepEqual(Array.from(h.lore[0].recordLayout.records[0].relatedEntryIds),['mira-b']);
 assert.equal(JSON.stringify(backup),before);assert.equal(h.calls.at(-1)[1].droppedLore,0);
});
