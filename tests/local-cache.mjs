import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
import {indexedDBFixture} from './indexeddb-fixture.mjs';
const base={session:{id:'s',nextOrder:1,historyRevision:0,nextNarratorTurn:1},messages:[{id:'u',role:'user',order:1,revision:0,content:'old'}],turns:{}};
const operation=(id,text)=>({id,kind:'edit',payload:{id:'u',order:1,content:text},createdAt:1});
async function harness(extra={}){const fixture=indexedDBFixture({sessions:[['u:s',{key:'u:s',uid:'u',value:{session:{id:'s'},recent:[]}}]]});const load=appHarness({globals:{indexedDB:fixture.indexedDB},...extra});return {fixture,load,cache:await load('chat-cache.js')};}
test('IndexedDB upgrade preserves version-one sessions and adds independent journal stores',async()=>{const {fixture,cache}=await harness();assert.equal((await cache.loadChatCache('u','s')).session.id,'s');for(const key of ['sessions','outbox','operations','storyData'])assert.ok(fixture.stores.has(key));});
test('Outbox persists individual operation records and compacts atomically after the final acknowledgement',async()=>{const {fixture,cache,load}=await harness();const reducer=(await load('local-story.js')).applyStoryOperation;const one=operation('one','first'),two=operation('two','second');await cache.storyQueueStorage.put('u','s',one,base);await cache.storyQueueStorage.put('u','s',two,base);let saved=await cache.storyQueueStorage.load('u','s');assert.equal(saved.records.length,2);assert.equal(fixture.stores.get('operations').size,2);const v1=reducer(base,one);await cache.storyQueueStorage.ack('u','s','one',v1);saved=await cache.storyQueueStorage.load('u','s');assert.equal(saved.records[0].acknowledged,true);assert.equal(saved.records[1].acknowledged,false);assert.equal(saved.base.messages[0].content,'old');const v2=reducer(v1,two);await cache.storyQueueStorage.ack('u','s','two',v2);assert.equal(await cache.storyQueueStorage.load('u','s'),null);assert.equal(fixture.stores.get('operations').size,0);assert.equal((await cache.loadStoryData('u','s')).confirmed.messages[0].content,'second');});
test('Pending stories are pinned while the latest three ordinary caches evict normally',async()=>{const {cache}=await harness();await cache.storyQueueStorage.put('u','s',operation('one','unsaved'),base);for(const sid of ['s','a','b','c','d'])await cache.saveChatCache('u',sid,{session:{id:sid},recent:[]});assert.ok(await cache.loadChatCache('u','s'));assert.equal(await cache.loadChatCache('u','a'),null);assert.deepEqual(Array.from(await cache.cachedSessionIds('u')),['d','c','b']);await cache.clearChatCache('u');assert.ok(await cache.storyQueueStorage.load('u','s'),'clearing the display cache must preserve pending work');});
test('Auxiliary caches merge independent lore, settings and confirmed history without account leakage',async()=>{const {cache}=await harness();await cache.saveStoryData('u','s',{lore:{revision:2,entries:[{name:'Lysia'}]}});await cache.saveStoryData('u','s',{storySettings:{revision:1,values:{narratorSystemPrompt:'Narrate'}}});const data=await cache.loadStoryData('u','s');assert.equal(data.lore.entries[0].name,'Lysia');assert.equal(data.storySettings.revision,1);assert.equal(await cache.loadStoryData('other','s'),null);assert.ok(!JSON.stringify(data).includes('apiKey'));});
test('Reopening replays only the unacknowledged suffix and retains both edits',async()=>{const fixture=indexedDBFixture({sessions:[]});let writes=0;const load=appHarness({globals:{indexedDB:fixture.indexedDB},stubs:{'auth.js':{currentUid:()=> 'u'},'messages.js':{editMessage:async(_sid,_id,content,_order,options)=>{writes++;return {session:{...options.session,historyRevision:2},replacement:{id:'u',role:'user',order:1,revision:2,content}};}}}});const cache=await load('chat-cache.js'),reducer=(await load('local-story.js')).applyStoryOperation;const one=operation('one','first'),two=operation('two','second');await cache.storyQueueStorage.put('u','s',one,base);await cache.storyQueueStorage.put('u','s',two,base);await cache.storyQueueStorage.ack('u','s','one',reducer(base,one));const store=await (await load('local-story-store.js')).openStoryStore('s',base,()=>{});assert.equal(store.view.messages[0].content,'second');await store.flush();assert.equal(writes,1);assert.equal(store.view.messages[0].revision,2);assert.equal(store.status.pending,0);});
test('Server replacement atomically removes only the active story journal and survives reopening',async()=>{
 const {cache,fixture}=await harness();
 for(const [owner,sid]of [['u','s'],['u','other'],['other','s']])await cache.storyQueueStorage.put(owner,sid,operation('pending','Local text'),base);
 const fresh={...base,messages:[{...base.messages[0],content:'Firebase text'}],turns:{checkpoint:{id:'checkpoint'}}};
 await cache.replaceStoryCache('u','s',{session:fresh.session,recent:fresh.messages,history:fresh.messages},{confirmed:fresh,turns:fresh.turns},{discardPending:true});
 const reopened=await appHarness({globals:{indexedDB:fixture.indexedDB}})('chat-cache.js');
 assert.equal(await reopened.storyQueueStorage.load('u','s'),null);assert.equal((await reopened.loadChatCache('u','s')).history[0].content,'Firebase text');
 assert.equal((await reopened.loadStoryData('u','s')).queueBase,undefined);
 assert.ok(await reopened.storyQueueStorage.load('u','other'));assert.ok(await reopened.storyQueueStorage.load('other','s'));
 assert.equal(fixture.stores.get('operations').size,2);
});

test('Sync cannot reopen the old account journal under a new account after a device read',async()=>{
 let owner='u',release;const reads=[];
 const load=appHarness({stubs:{'auth.js':{currentUid:()=>owner},'messages.js':{},'chat-cache.js':{
  storyQueueStorage:{load:async(uid,sid)=>{reads.push([uid,sid]);return reads.length===1?new Promise(resolve=>release=()=>resolve({base,records:[]})):null;}},
  loadStoryData:async()=>null,saveStoryData:async()=>true,
 }}});
 const stores=await load('local-story-store.js');const pending=stores.flushStory('s');owner='other';release();
 await assert.rejects(pending,/Account changed/);assert.equal(stores.storyStore('s'),undefined);
 assert.deepEqual(reads,[['u','s']],'recovery must not read the next account or add a server refresh');
});

test('opening a local story stops if the account changes while restoring chunk metadata',async()=>{
 let owner='u',release;const restored=[];
 const load=appHarness({stubs:{'auth.js':{currentUid:()=>owner},'messages.js':{restoreMessageChunkCache:async sid=>{restored.push(sid);await new Promise(resolve=>release=resolve);}},
  'chat-cache.js':{storyQueueStorage:{load:async()=>null},loadStoryData:async()=>null,saveStoryData:async()=>true}}});
 const stores=await load('local-story-store.js');const pending=stores.openStoryStore('s',base,()=>{throw Error('stale observer');});
 await new Promise(resolve=>setImmediate(resolve));owner='other';release();
 await assert.rejects(pending,/Account changed/);assert.equal(stores.storyStore('s'),undefined);assert.deepEqual(restored,['s']);
});


test('Newest and middle acknowledgements preserve other-tab edits and compact only confirmed prefixes',async()=>{
 const {cache,fixture,load}=await harness(),apply=(await load('local-story.js')).applyStoryOperation;
 const original={...base,messages:[...base.messages,{id:'v',role:'assistant',order:2,revision:0,content:'before'},{id:'w',role:'user',order:3,revision:0,content:'before'}]};
 const a=operation('A','Unsent A'),b={...operation('B','Saved B'),payload:{id:'v',order:2,content:'Saved B'}},c={...operation('C','Saved C'),payload:{id:'w',order:3,content:'Saved C'}};
 for(const op of[a,b,c])assert.equal(await cache.storyQueueStorage.put('u','s',op,original),true);
 await cache.storyQueueStorage.ack('u','s','C',apply(original,c));
 await cache.storyQueueStorage.ack('u','s','B',apply(original,b));
 const reopened=await appHarness({globals:{indexedDB:fixture.indexedDB}})('chat-cache.js');let journal=await reopened.storyQueueStorage.load('u','s');
 assert.deepEqual(Array.from(journal.records,r=>[r.op.id,r.acknowledged]),[['A',false],['B',true],['C',true]]);
 assert.equal(journal.base.messages[0].content,'old');
 // A retry may not duplicate or unacknowledge the already saved B record.
 await reopened.storyQueueStorage.put('u','s',b,original);journal=await reopened.storyQueueStorage.load('u','s');assert.equal(journal.records.length,3);assert.equal(journal.records[1].acknowledged,true);
 // Every tab's confirmed snapshot contains only that tab's edit. Final durable
 // compaction must compose all three effects, rather than trusting the last one.
 await reopened.storyQueueStorage.ack('u','s','A',{...apply(original,a),session:{...original.session,historyRevision:3}});
 assert.equal(await reopened.storyQueueStorage.load('u','s'),null);
 assert.deepEqual(Array.from((await reopened.loadStoryData('u','s')).confirmed.messages,m=>m.content),['Unsent A','Saved B','Saved C']);
 assert.equal((await reopened.loadStoryData('u','s')).confirmed.session.historyRevision,3);
});

test('A lost older acknowledgement cannot regress a newer confirmed message or revision',async()=>{
 const {cache,load}=await harness(),apply=(await load('local-story.js')).applyStoryOperation;
 const older=operation('older','old saved text'),newer=operation('newer','new saved text'),first=apply(base,older),last=apply(first,newer);
 await cache.storyQueueStorage.put('u','s',newer,base);await cache.storyQueueStorage.put('u','s',older,base);
 await cache.storyQueueStorage.ack('u','s','newer',last);
 await cache.storyQueueStorage.ack('u','s','older',first);
 const confirmed=(await cache.loadStoryData('u','s')).confirmed;
 assert.equal(confirmed.session.historyRevision,2);assert.equal(confirmed.messages[0].revision,2);assert.equal(confirmed.messages[0].content,'new saved text');
 // A late acknowledgement after journal removal is harmless.
 await cache.storyQueueStorage.ack('u','s','older',first);assert.equal((await cache.loadStoryData('u','s')).confirmed.messages[0].content,'new saved text');
});

test('Loading a journal reads the header, original base and operations in one readonly transaction',async()=>{
 const {cache,fixture}=await harness();await cache.storyQueueStorage.put('u','s',operation('one','local'),base);
 const transactions=[],original=fixture.db.transaction;
 fixture.db.transaction=function(names,mode){transactions.push({names:Array.from(names),mode});return original.call(this,names,mode);};
 const journal=await cache.storyQueueStorage.load('u','s');assert.equal(journal.records.length,1);
 assert.deepEqual(transactions,[{names:['outbox','storyData','operations'],mode:'readonly'}]);
 fixture.stores.get('operations').delete('u:s:one');await assert.rejects(cache.storyQueueStorage.load('u','s'),/journal is incomplete/);
 fixture.stores.get('operations').set('u:s:one',{key:'u:s:one',value:{op:operation('one','local'),acknowledged:false}});
 fixture.stores.get('storyData').get('u:s').value.queueBase=null;await assert.rejects(cache.storyQueueStorage.load('u','s'),/journal is incomplete/);
});

test('Blocked opens share one attempt and recover after the upgrade finishes without reloading',async()=>{
 const fixture=indexedDBFixture(),requests=[];let blocked=true;
 const indexedDB={open:(...args)=>{
  if(!blocked)return fixture.indexedDB.open(...args);
  const r={result:fixture.db};requests.push(r);queueMicrotask(()=>r.onblocked?.());return r;
 }};
 const cache=await appHarness({globals:{indexedDB}})('chat-cache.js');
 assert.equal(await cache.saveStoryData('u','s',{first:true}),false);assert.equal(await cache.saveStoryData('u','s',{second:true}),false);assert.equal(requests.length,1);
 blocked=false;requests[0].onsuccess();
 assert.equal(await cache.saveStoryData('u','s',{after:'unblocked'}),true);assert.equal((await cache.loadStoryData('u','s')).after,'unblocked');
});

test('Transient IndexedDB open errors permit one shared later attempt',async()=>{
 const fixture=indexedDBFixture();let attempts=0;
 const indexedDB={open:(...args)=>{attempts++;if(attempts>1)return fixture.indexedDB.open(...args);const r={error:Error('temporary device failure')};queueMicrotask(()=>r.onerror());return r;}};
 const cache=await appHarness({globals:{indexedDB}})('chat-cache.js');
 assert.equal(await cache.saveStoryData('u','s',{first:true}),false);
 const saves=await Promise.all([cache.saveStoryData('u','s',{after:true}),cache.saveStoryData('other','s',{isolated:true})]);
 assert.deepEqual(saves,[true,true]);assert.equal(attempts,2);assert.equal((await cache.loadStoryData('u','s')).after,true);assert.equal((await cache.loadStoryData('other','s')).isolated,true);
});

test('Reopening retains unsynced text and a saved other-tab edit as an explicit recoverable conflict',async()=>{
 const fixture=indexedDBFixture(),original={...base,messages:[...base.messages,{id:'other',role:'assistant',order:2,revision:0,content:'old B'}]},commits=[];
 const options={globals:{indexedDB:fixture.indexedDB},stubs:{'auth.js':{currentUid:()=> 'u'},'messages.js':{editMessage:async(...args)=>{commits.push(args);throw Object.assign(Error('story changed'),{code:'story-conflict'});}}}};
 const first=appHarness(options),cache=await first('chat-cache.js'),pure=await first('local-story.js'),source=(await first('continuity.js')).requestSource(original.session);
 const a={...operation('A','Unique unsaved text from A'),source},b={...operation('B','Saved in B'),source,payload:{id:'other',order:2,content:'Saved in B'}};
 await cache.storyQueueStorage.put('u','s',a,original);await cache.storyQueueStorage.put('u','s',b,original);await cache.storyQueueStorage.ack('u','s','B',pure.applyStoryOperation(original,b));
 const next=appHarness(options),store=await (await next('local-story-store.js')).openStoryStore('s',original,()=>{});
 assert.equal(store.status.error.code,'story-conflict');assert.equal(store.status.pending,1);assert.equal(store.status.durable,true);assert.equal(commits.length,0);
 assert.equal(store.view.messages.find(m=>m.id==='u').content,'Unique unsaved text from A');assert.equal(store.view.messages.find(m=>m.id==='other').content,'Saved in B');
 await assert.rejects(store.flush(),/story changed/);assert.equal(commits.length,1);assert.equal(commits[0][4].operationId,'A');assert.equal(commits[0][4].expectedSource.historyRevision,0);
 const durable=await (await next('chat-cache.js')).storyQueueStorage.load('u','s');assert.equal(durable.records.length,2);assert.equal(durable.records[0].acknowledged,false);assert.equal(durable.records[1].acknowledged,true);
});


test('Reversed header and receipt orders retain newer deletions and older unrelated confirmed effects',async()=>{
 for(const kind of ['edit','add']){
  const {cache,load}=await harness(),apply=(await load('local-story.js')).applyStoryOperation;
  const initial=kind==='edit'?base:{...base,messages:[],session:{...base.session,nextOrder:0}};
  const older=kind==='edit'?operation('older','older saved edit'):{id:'older',kind:'add',payload:{id:'u',message:{role:'user',content:'older saved add'}}};
  const first=apply(initial,older),newer={id:'newer',kind:'delete',payload:{id:'u'}},last=apply(first,newer);
  await cache.storyQueueStorage.put('u','s',newer,initial);await cache.storyQueueStorage.put('u','s',older,initial);
  await cache.storyQueueStorage.ack('u','s','newer',last);
  const intermediate=await cache.storyQueueStorage.load('u','s');assert.equal(intermediate.records.length,2);assert.equal(intermediate.base.session.historyRevision,0);
  await cache.storyQueueStorage.ack('u','s','older',first);
  const saved=(await cache.loadStoryData('u','s')).confirmed;assert.equal(saved.session.historyRevision,2);assert.equal(saved.messages.length,0);
 }
});

test('Recovered lost acknowledgements reuse authoritative receipts without duplicate writes or metadata regression',async()=>{
 for(const secondKind of ['edit-other','delete-same']){
  const fixture=indexedDBFixture(),initial={...base,messages:[...base.messages,{id:'other',role:'assistant',order:2,revision:0,content:'old B'}]},original=appHarness({globals:{indexedDB:fixture.indexedDB}}),cache=await original('chat-cache.js'),pure=await original('local-story.js');
  const source=(await original('continuity.js')).requestSource(initial.session),a={...operation('A','Saved A with lost acknowledgement'),source},savedA=pure.applyStoryOperation(initial,a),b=secondKind==='edit-other'?{...operation('B','Saved B'),payload:{id:'other',order:2,content:'Saved B'}}:{id:'B',kind:'delete',payload:{id:'u'}};
  const savedB=pure.applyStoryOperation(savedA,b);
  await cache.storyQueueStorage.put('u','s',a,initial);await cache.storyQueueStorage.put('u','s',b,initial);await cache.storyQueueStorage.ack('u','s','B',savedB);
  let receipts=0;const restarted=appHarness({globals:{indexedDB:fixture.indexedDB},stubs:{'auth.js':{currentUid:()=> 'u'},'messages.js':{editMessage:async(_sid,_id,_text,_order,options)=>{receipts++;assert.equal(options.operationId,'A');return {session:savedA.session,replacement:savedA.messages.find(m=>m.id==='u')};}}}});
  const store=await (await restarted('local-story-store.js')).openStoryStore('s',savedB,()=>{});await store.flush();assert.equal(receipts,1);assert.equal(store.status.pending,0);assert.equal(store.confirmed.session.historyRevision,2);
  assert.equal(store.confirmed.messages.some(m=>m.id==='u'),secondKind==='edit-other');if(secondKind==='edit-other')assert.equal(store.confirmed.messages.find(m=>m.id==='other').content,'Saved B');
  const reopened=await (await restarted('chat-cache.js')).loadStoryData('u','s');assert.equal(reopened.confirmed.session.historyRevision,2);assert.equal(reopened.confirmed.messages.some(m=>m.id==='u'),secondKind==='edit-other');
 }
});


test('A lost Director contract acknowledgement cannot restore pending state after a completed reply',async()=>{
 const fixture=indexedDBFixture(),original=appHarness({globals:{indexedDB:fixture.indexedDB}}),cache=await original('chat-cache.js'),pure=await original('local-story.js'),source=(await original('continuity.js')).requestSource;
 const initial={...base,session:{...base.session,directorState:{scene:{location:'Inn'}}}},turn={id:'T',before:{scene:{location:'Inn'}},after:{scene:{location:'Hall'}},previousCheckpoint:null},director={id:'director',kind:'director',payload:{turn},source:source(initial.session)},pending=pure.applyStoryOperation(initial,director);
 const reply={id:'reply',kind:'add',payload:{id:'assistant',message:{role:'assistant',content:'Saved reply',directorTurnId:'T'}},source:source(pending.session)},completed=pure.applyStoryOperation(pending,reply);
 await cache.storyQueueStorage.put('u','s',director,initial);await cache.storyQueueStorage.put('u','s',reply,initial);
 await cache.storyQueueStorage.ack('u','s','reply',completed,{session:completed.session,message:completed.messages.at(-1)});
 let directorCalls=0;const reopened=appHarness({globals:{indexedDB:fixture.indexedDB},stubs:{'auth.js':{currentUid:()=> 'u'},'messages.js':{restoreMessageChunkCache:async()=>{}},'director-store.js':{savePendingDirectorTurn:async()=>{directorCalls++;return pending.turns.T;},discardPendingDirector:async()=>{},getDirectorTurn:async()=>null}}});
 const store=await (await reopened('local-story-store.js')).openStoryStore('s',completed,()=>{});await store.flush();assert.equal(directorCalls,1);assert.equal(store.status.pending,0);assert.equal(store.confirmed.session.directorPending,null);assert.equal(store.confirmed.turns.T.status,'completed');
 const durable=(await (await reopened('chat-cache.js')).loadStoryData('u','s')).confirmed;assert.equal(durable.session.directorPending,null);assert.equal(durable.turns.T.status,'completed');assert.equal(durable.messages.at(-1).directorTurnId,'T');
});
