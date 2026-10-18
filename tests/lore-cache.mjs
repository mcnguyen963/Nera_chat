import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
import {indexedDBFixture} from './indexeddb-fixture.mjs';

const snapshot=(entries=[],revision=0)=>({initialized:true,entries,loadedRevision:revision,lastCommittedRevision:revision,schemaVersion:2,generation:null,entryRevisions:{}});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const delta=(revision,changes,extra={})=>({uid:'u',sid:'s',revision,changes,generation:null,schemaVersion:2,...extra});
async function setup(fixture=indexedDBFixture()){
 const load=appHarness({globals:{indexedDB:fixture.indexedDB}});
 return {fixture,load,cache:await load('lore-cache.js'),storage:await load('chat-cache.js')};
}

test('200 entries download once across concurrent callers and survive a device reload',async()=>{
 const h=await setup(),entries=Array.from({length:200},(_,i)=>({id:'e'+i,name:'Entry '+i}));let reads=0;
 const download=async()=>{reads++;return snapshot(entries,7);};
 const all=await Promise.all(Array.from({length:10},()=>h.cache.getCachedLoreSnapshot('u','s',download)));
 assert.equal(reads,1);assert.ok(all.every(s=>s.entries.length===200));
 all[0].entries[0].name='Draft';assert.equal(all[1].entries[0].name,'Entry 0');assert.equal((await h.cache.getCachedLoreSnapshot('u','s',download)).entries[0].name,'Entry 0');
 const reopened=await setup(h.fixture);assert.equal((await reopened.cache.getCachedLoreSnapshot('u','s',download)).loadedRevision,7);assert.equal(reads,1);
 assert.ok(h.fixture.stores.has('loreCache'));
});
test('lore survives the three-story history eviction and remains scoped by account',async()=>{
 const h=await setup();
 for(const sid of ['s','a','b','c','d']){
  await h.cache.replaceLoreSnapshot('u',sid,snapshot([{id:sid,name:sid}]));
  await h.storage.saveChatCache('u',sid,{session:{id:sid},recent:[]});
 }
 assert.equal(await h.storage.loadChatCache('u','s'),null);
 const reopened=await setup(h.fixture);
 for(const sid of ['s','a','b','c','d'])assert.equal((await reopened.cache.getCachedLoreSnapshot('u',sid,()=>{throw Error('must use cache');})).entries[0].id,sid);
 assert.equal(await reopened.cache.cachedLoreSnapshot('other','s'),null);
 await reopened.cache.initializeLoreCache('other','s');
 assert.equal((await reopened.cache.cachedLoreSnapshot('u','s')).entries.length,1);
});
test('initialized empty lore and new stories do not keep downloading',async()=>{
 const h=await setup();let reads=0;
 const download=async()=>{reads++;return snapshot();};
 await h.cache.getCachedLoreSnapshot('u','s',download);await h.cache.getCachedLoreSnapshot('u','s',download);
 await h.cache.initializeLoreCache('u','new');await h.cache.getCachedLoreSnapshot('u','new',download);
 const reopened=await setup(h.fixture);await reopened.cache.getCachedLoreSnapshot('u','s',download);assert.equal(reads,1);
});
test('existing version-two lore is adopted without a download',async()=>{
 const h=await setup();await h.storage.saveStoryData('u','s',{lore:{revision:4,entries:[{id:'old',sourceRevision:2}]}});
 const value=await h.cache.getCachedLoreSnapshot('u','s',()=>{throw Error('must adopt persisted lore');});
 assert.equal(value.loadedRevision,4);assert.equal(value.entries[0].sourceRevision,2);assert.equal((await h.storage.loadLoreCache('u','s')).initialized,true);
});
for(const mode of ['unavailable','failed'])test('memory copy remains usable when IndexedDB is '+mode,async()=>{
 const load=appHarness(mode==='failed'?{stubs:{'chat-cache.js':{loadLoreCache:async()=>{throw Error('offline');},saveLoreCache:async()=>{throw Error('quota');}}}}:{}),cache=await load('lore-cache.js');let reads=0;
 await cache.getCachedLoreSnapshot('u','s',async()=>{reads++;return snapshot([{id:'a',name:'Original'}],1);});
 await cache.applyLoreDelta(delta(2,[{id:'a',type:'patch',data:{name:'Saved'}}]));
 const value=await cache.getCachedLoreSnapshot('u','s',()=>{reads++;throw Error('unexpected');});assert.equal(value.entries[0].name,'Saved');assert.equal(reads,1);
});
test('an IndexedDB upgrade blocked by another tab falls back to memory instead of hanging',async()=>{
 const load=appHarness({globals:{indexedDB:{open:()=>{const request={};queueMicrotask(()=>request.onblocked?.());return request;}}}}),cache=await load('lore-cache.js');let reads=0;
 await cache.getCachedLoreSnapshot('u','s',async()=>{reads++;return snapshot([{id:'a'}]);});
 assert.equal((await cache.getCachedLoreSnapshot('u','s',()=>{throw Error('unexpected');})).entries[0].id,'a');assert.equal(reads,1);
});
test('cache serialization preserves dates and Firestore timestamps without storing transform objects',async()=>{
 const {cache}=await setup();const value=cache.loreData({createdAt:new Date(1234),updatedAt:{seconds:2,nanoseconds:500,toDate(){return new Date(2000);}},pending:{_methodName:'serverTimestamp'}});
 assert.equal(value.createdAt.seconds,1);assert.equal(value.createdAt.nanoseconds,234000000);assert.equal(value.updatedAt.nanoseconds,500);assert.equal(typeof value.pending.seconds,'number');assert.equal(value.pending._methodName,undefined);
});
test('failed initial downloads stay unavailable until manual replacement succeeds',async()=>{
 const h=await setup();let reads=0;const fail=async()=>{reads++;throw Error('limit');};
 await assert.rejects(h.cache.getCachedLoreSnapshot('u','s',fail),/limit/);
 await assert.rejects(h.cache.getCachedLoreSnapshot('u','s',fail),/limit/);assert.equal(reads,1);
 assert.equal(await h.cache.cachedLoreSnapshot('u','s'),null);
 await h.cache.replaceLoreSnapshot('u','s',snapshot([{id:'recovered'}],9));
 assert.equal((await h.cache.getCachedLoreSnapshot('u','s',fail)).entries[0].id,'recovered');assert.equal(reads,1);
});
test('committed replacements, dotted patches and deletes persist without claiming a full refresh',async()=>{
 const h=await setup();await h.cache.replaceLoreSnapshot('u','s',snapshot([{id:'a',name:'Before',sections:{notes:{text:'Keep',lines:[]}}},{id:'b'}],2));
 await h.cache.applyLoreDelta(delta(5,[{id:'a',type:'patch',data:{name:'After','sections.notes.lines':[{id:'n',text:'Saved',src:10}]}},{id:'b',type:'delete'},{id:'c',type:'set',data:{name:'Created',schedule:{status:'pending'}}}]));
 const value=await h.cache.cachedLoreSnapshot('u','s');assert.equal(value.loadedRevision,2);assert.equal(value.lastCommittedRevision,5);
 assert.equal(value.entries.find(e=>e.id==='a').sections.notes.text,'Keep');assert.equal(value.entries.find(e=>e.id==='a').sections.notes.lines[0].src,10);assert.equal(value.entries.some(e=>e.id==='b'),false);
 const reopened=await setup(h.fixture);assert.equal((await reopened.cache.cachedLoreSnapshot('u','s')).entries.find(e=>e.id==='c').schedule.status,'pending');
 assert.equal(h.cache.loreSnapshotInfo(value).source,'device-cache');
});
test('out-of-order and duplicate acknowledgements cannot overwrite newer entries or resurrect tombstones',async()=>{
 const h=await setup();await h.cache.replaceLoreSnapshot('u','s',snapshot([{id:'a',name:'Base'},{id:'b',name:'Base'}],2));
 await h.cache.applyLoreDelta(delta(5,[{id:'a',type:'set',data:{name:'Newest'}},{id:'b',type:'delete'}]));
 await h.cache.applyLoreDelta(delta(4,[{id:'a',type:'set',data:{name:'Older'}},{id:'b',type:'set',data:{name:'Resurrect'}},{id:'c',type:'set',data:{name:'Independent older commit'}}]));
 await h.cache.applyLoreDelta(delta(5,[{id:'a',type:'delete'}]));
 const value=await h.cache.cachedLoreSnapshot('u','s');assert.equal(value.entries.find(e=>e.id==='a').name,'Newest');assert.equal(value.entries.some(e=>e.id==='b'),false);assert.equal(value.entries.find(e=>e.id==='c').name,'Independent older commit');
});
test('an initial download preserves a newer commit received before it finished',async()=>{
 const h=await setup(),gate=deferred();const pending=h.cache.getCachedLoreSnapshot('u','s',()=>gate.promise);
 await new Promise(r=>setImmediate(r));await h.cache.applyLoreDelta(delta(6,[{id:'a',type:'set',data:{name:'Local saved'}},{id:'gone',type:'delete'}]));
 gate.resolve(snapshot([{id:'a',name:'Old server'},{id:'gone'}],5));
 const value=await pending;assert.equal(value.entries[0].name,'Local saved');assert.equal(value.entries.length,1);assert.equal(value.loadedRevision,5);assert.equal(value.lastCommittedRevision,6);
});
test('stale Sync is rejected before touching persistent storage',async()=>{
 const h=await setup();await h.cache.replaceLoreSnapshot('u','s',snapshot([{id:'a',name:'Before'}],2));
 const expectedVersion=h.cache.loreCacheVersion('u','s');
 await h.cache.applyLoreDelta(delta(3,[{id:'a',type:'patch',data:{name:'Saved'}}]));let replacements=0;
 await assert.rejects(h.cache.replaceLoreSnapshot('u','s',snapshot([{id:'a',name:'Old Sync'}],2),{expectedVersion,commit:async()=>{replacements++;}}),/changed locally/);
 assert.equal(replacements,0);assert.equal((await h.storage.loadLoreCache('u','s')).entries[0].name,'Saved');
});
test('failed complete Sync replacement retains the previous memory and disk copy',async()=>{
 const h=await setup();await h.cache.replaceLoreSnapshot('u','s',snapshot([{id:'a',name:'Keep'}],2));
 await assert.rejects(h.cache.replaceLoreSnapshot('u','s',snapshot([{id:'b'}],9),{commit:async()=>{throw Error('cache failed');}}),/cache failed/);
 assert.equal((await h.cache.cachedLoreSnapshot('u','s')).entries[0].name,'Keep');assert.equal((await h.storage.loadLoreCache('u','s')).loadedRevision,2);
});
test('writes queued during Sync publish after the complete replacement',async()=>{
 const h=await setup(),gate=deferred();await h.cache.replaceLoreSnapshot('u','s',snapshot([{id:'a'}],1));
 const syncing=h.cache.replaceLoreSnapshot('u','s',snapshot([{id:'a',name:'Sync'}],2),{commit:()=>gate.promise});
 const saving=h.cache.applyLoreDelta(delta(3,[{id:'a',type:'patch',data:{name:'Saved after Sync'}}]));gate.resolve();await Promise.all([syncing,saving]);
 assert.equal((await h.cache.cachedLoreSnapshot('u','s')).entries[0].name,'Saved after Sync');
 assert.equal((await h.storage.loadLoreCache('u','s')).lastCommittedRevision,3);
});
test('deletion cancels a delayed initial download without recreating a deleted story cache',async()=>{
 const h=await setup(),gate=deferred();const pending=h.cache.getCachedLoreSnapshot('u','s',()=>gate.promise);await new Promise(r=>setImmediate(r));
 await h.cache.forgetLoreCache('u','s');gate.resolve(snapshot([{id:'old'}]));await assert.rejects(pending,/Story changed/);
 assert.equal(await h.cache.cachedLoreSnapshot('u','s'),null);assert.equal(await h.storage.loadLoreCache('u','s'),null);
});
