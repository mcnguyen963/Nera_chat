import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';
import {indexedDBFixture} from './indexeddb-fixture.mjs';

const snapshot=(id,revision=1)=>({initialized:true,entries:[{id,name:id,sections:{notes:{text:'Synthetic lore '.repeat(100),lines:[]}}}],loadedRevision:revision,lastCommittedRevision:revision,schemaVersion:2,generation:null,entryRevisions:{}});
const plain=x=>JSON.parse(JSON.stringify(x));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const tick=()=>new Promise(r=>setImmediate(r));
async function setup(options={}){
 // Inspect private ownership only in this loader; ship no session/cache seeding export.
 const source=await readFile(new URL('../js/lore-cache.js',import.meta.url),'utf8');
 const load=appHarness({globals:{indexedDB:indexedDBFixture().indexedDB},...options,sources:{'lore-cache.js':source+'\nexport const retention=()=>({records:[...records.keys()],journals:journals.size,hydrating:hydrating.size,downloads:downloads.size});'}});
 return {cache:await load('lore-cache.js'),storage:await load('chat-cache.js')};
}
async function fill(cache,start=0,count=20){for(let i=start;i<start+count;i++)await cache.replaceLoreSnapshot('u','s'+i,snapshot('e'+i));}

test('twenty stories retain only three durable lore snapshots and no settled journal promises',async()=>{
 const {cache,storage}=await setup();let reads=0;
 for(let i=0;i<20;i++)await cache.getCachedLoreSnapshot('u','s'+i,async()=>{reads++;return snapshot('e'+i);});
 assert.equal(cache.retention().records.length,3);assert.equal(cache.retention().journals,0);
 for(let i=0;i<20;i++){
  const value=await cache.getCachedLoreSnapshot('u','s'+i,()=>{throw Error('eviction must use device storage');});
  assert.deepEqual(plain(value),plain(await storage.loadLoreCache('u','s'+i)));
  assert.equal(value.entries[0].id,'e'+i);assert.ok(cache.retention().records.length<=3);
 }
 assert.equal(reads,20);assert.equal(cache.retention().journals,0);
 assert.equal(await cache.cachedLoreSnapshot('other','s0'),null);
});

test('queued journals stay pinned until the last writer settles and are released on rejection',async()=>{
 const {cache}=await setup(),gate=deferred();
 const first=cache.replaceLoreSnapshot('u','held',snapshot('first'),{commit:()=>gate.promise});
 const second=cache.replaceLoreSnapshot('u','held',snapshot('second'));
 await tick();await fill(cache);assert.equal(cache.retention().journals,1);
 gate.resolve();await Promise.all([first,second]);assert.equal(cache.retention().journals,0);
 assert.equal((await cache.cachedLoreSnapshot('u','held')).entries[0].id,'second');
 await assert.rejects(cache.replaceLoreSnapshot('u','held',snapshot('bad'),{commit:()=>{throw Error('rejected');}}),/rejected/);
 assert.equal(cache.retention().journals,0);
});

for(const mode of ['false','throw'])test('non-durable snapshots survive cache pressure when persistence returns '+mode,async()=>{
 const {cache}=await setup({stubs:{'chat-cache.js':{loadLoreCache:async()=>null,saveLoreCache:async()=>{if(mode==='throw')throw Error('quota');return false;}}}});
 await fill(cache);assert.equal(cache.retention().records.length,20);assert.equal(cache.retention().journals,0);
 for(let i=0;i<20;i++)assert.equal((await cache.getCachedLoreSnapshot('u','s'+i,()=>{throw Error('must retain unsaved copy');})).entries[0].id,'e'+i);
});

test('a pending initial download retains newer deltas while other stories churn',async()=>{
 const {cache}=await setup(),gate=deferred();
 const pending=cache.getCachedLoreSnapshot('u','s',()=>gate.promise);await tick();
 await cache.applyLoreDelta({uid:'u',sid:'s',generation:null,schemaVersion:2,revision:3,changes:[{id:'new',type:'set',data:{name:'saved while loading'}}]});
 await fill(cache);assert.equal(cache.retention().downloads,1);
 gate.resolve(snapshot('old',1));const value=await pending;
 assert.equal(value.entries.find(e=>e.id==='new').name,'saved while loading');
 assert.equal(cache.retention().downloads,0);assert.ok(cache.retention().records.length<=3);
 assert.equal((await cache.getCachedLoreSnapshot('u','s',()=>{throw Error('must recover device copy');})).lastCommittedRevision,3);
});

test('evicted story deltas rehydrate under their writer pin without losing existing entries',async()=>{
 const {cache}=await setup();await cache.replaceLoreSnapshot('u','s',snapshot('original'));await fill(cache);
 await Promise.all([cache.applyLoreDelta({uid:'u',sid:'s',generation:null,schemaVersion:2,revision:2,changes:[{id:'new',type:'set',data:{name:'new'}}]}),fill(cache,20)]);
 const value=await cache.cachedLoreSnapshot('u','s');assert.deepEqual(Array.from(value.entries,e=>e.id),['original','new']);assert.ok(cache.retention().records.length<=3);
});

test('successful atomic device replacements are evictable without a second save',async()=>{
 const {cache,storage}=await setup();
 for(let i=0;i<20;i++){
  const value=snapshot('e'+i);
  await cache.replaceLoreSnapshot('u','s'+i,value,{persist:false,commit:()=>storage.replaceStoryCache('u','s'+i,{session:{id:'s'+i},recent:[]},{loreSnapshot:value})});
 }
 assert.equal(cache.retention().records.length,3);
 assert.equal((await cache.getCachedLoreSnapshot('u','s0',()=>{throw Error('must use atomic device copy');})).entries[0].id,'e0');
 const noDisk=await appHarness()('chat-cache.js');assert.equal(await noDisk.replaceStoryCache('u','s',{},{}),false);
});

test('eviction keeps version tombstones and stale Sync guards intact',async()=>{
 const {cache}=await setup();await cache.replaceLoreSnapshot('u','s',snapshot('keep'));const version=cache.loreCacheVersion('u','s');
 await cache.applyLoreDelta({uid:'u',sid:'s',generation:null,schemaVersion:2,revision:2,changes:[{id:'keep',type:'delete'}]});await fill(cache);
 await assert.rejects(cache.replaceLoreSnapshot('u','s',snapshot('stale'),{expectedVersion:version}),/changed locally/);
 assert.equal((await cache.cachedLoreSnapshot('u','s')).entries.length,0);
 const gate=deferred(),pending=cache.getCachedLoreSnapshot('u','deleted',()=>gate.promise);await tick();
 await cache.forgetLoreCache('u','deleted');await fill(cache,20);gate.resolve(snapshot('resurrect'));
 await assert.rejects(pending,/Story changed/);assert.equal(await cache.cachedLoreSnapshot('u','deleted'),null);assert.equal(cache.retention().journals,0);
});
