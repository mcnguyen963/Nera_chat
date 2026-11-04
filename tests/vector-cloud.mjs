import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
import {indexedDBFixture} from './indexeddb-fixture.mjs';
const row=(id,vector=[1,0])=>({id:id+':0',messageId:id,revision:0,order:1,role:'assistant',start:0,end:6,sourceHash:'a'.repeat(64),sourceRevision:1,modelKey:'model-A',text:'private story text',vector});
function adapter(){const chunks=new Map(),manifests=new Map(),writes=[];return {chunks,manifests,writes,async writeChunk(id,payload){chunks.set(id,payload);writes.push(id);},async readChunk(id){return chunks.get(id);},async loadManifest(kind){return manifests.get(kind)??null;},async commitManifest(kind,expected,next){if((manifests.get(kind)?.revision??0)!==expected)throw Error('Vector index changed on another device.');manifests.set(kind,next);}};}
test('vector sync stores no source text, checks chunks and reuses unchanged chunks',async()=>{
  const {uploadVectorIndex,downloadVectorIndex}=await appHarness()('vector-cloud-core.js'),remote=adapter(),a=row('a'),b={...row('b'),order:101};
  const first=await uploadVectorIndex({adapter:remote,kind:'history',rows:[a,b]});
  for(const text of remote.chunks.values())assert.doesNotMatch(text,/private story text/);
  const localCache=new Map(),loaded=await downloadVectorIndex({adapter:remote,kind:'history',cache:localCache});
  assert.equal(loaded.rows.length,2);assert.equal(loaded.reads,first.manifest.chunks.length+1);
  assert.deepEqual(Array.from(loaded.rows.find(r=>r.messageId==='a').vector),[1,0]);
  const repeat=await uploadVectorIndex({adapter:remote,kind:'history',rows:[a,b],previousManifest:first.manifest});
  assert.equal(repeat.writes,0);assert.equal((await downloadVectorIndex({adapter:remote,kind:'history',cache:localCache})).reads,1);
  const edited=await uploadVectorIndex({adapter:remote,kind:'history',rows:[a,{...b,vector:[0,1]}],previousManifest:repeat.manifest});
  assert.ok(edited.writes>1);assert.ok(edited.reused>0);
  const victim=edited.manifest.chunks[0].id;remote.chunks.set(victim,'[]');
  await assert.rejects(downloadVectorIndex({adapter:remote,kind:'history'}),/damaged/);
  const repaired=await uploadVectorIndex({adapter:remote,kind:'history',rows:[a,{...b,vector:[0,1]}],previousManifest:edited.manifest,force:true});
  assert.equal(repaired.writes,repaired.manifest.chunks.length+1);assert.equal((await downloadVectorIndex({adapter:remote,kind:'history'})).rows.length,2);
});
test('an interrupted or conflicting upload preserves the active manifest',async()=>{
  const {uploadVectorIndex}=await appHarness()('vector-cloud-core.js'),remote=adapter();
  const first=await uploadVectorIndex({adapter:remote,kind:'history',rows:[row('a')]});
  await assert.rejects(uploadVectorIndex({adapter:remote,kind:'history',rows:[row('b')]}),/changed on another device/);
  assert.equal(remote.manifests.get('history').revision,first.manifest.revision);
});
test('large vector encoding preserves exact Float32 bytes and Base64 padding',async()=>{
  const {encodeVectorChunks,uploadVectorIndex,downloadVectorIndex}=await appHarness()('vector-cloud-core.js');
  const values=[1,-0,Math.fround(.1),-5.5,1e-38,3.4028234663852886e38];
  for(const size of [1,2,3,1024,2560,8192]){
    const vector=Float32Array.from({length:size},(_,i)=>values[i%values.length]),source={...row('exact',vector),modelId:'qwen3-embedding:4b',dimensions:size};
    const chunks=await encodeVectorChunks('history',[source]),saved=JSON.parse(chunks[0].payload)[0],expected=Buffer.alloc(size*4);
    for(let i=0;i<size;i++)expected.writeFloatLE(vector[i],i*4);
    assert.equal(saved.vector,expected.toString('base64'));
    const remote=adapter();await uploadVectorIndex({adapter:remote,kind:'history',rows:[source]});
    assert.deepEqual(Array.from((await downloadVectorIndex({adapter:remote,kind:'history'})).rows[0].vector),Array.from(vector));
  }
});
test('incompatible vectors and invalid source metadata cannot be uploaded',async()=>{
  const {encodeVectorChunks}=await appHarness()('vector-cloud-core.js');
  await assert.rejects(encodeVectorChunks('history',[row('a',[0,0])]),/Invalid embedding/);
  await assert.rejects(encodeVectorChunks('history',[{...row('a'),sourceHash:''}]),/Invalid historical/);
});
test('cloud records keep the embedding model and reject duplicated sources',async()=>{
  const {uploadVectorIndex,downloadVectorIndex}=await appHarness()('vector-cloud-core.js'),remote=adapter(),source={...row('a'),modelId:'qwen3-embedding:0.6b'};
  await uploadVectorIndex({adapter:remote,kind:'history',rows:[source]});
  const downloaded=await downloadVectorIndex({adapter:remote,kind:'history'});assert.equal(downloaded.rows[0].modelId,'qwen3-embedding:0.6b');
  await assert.rejects(uploadVectorIndex({adapter:remote,kind:'history',rows:[source,source]}),/Duplicate/);
});
test('Firestore adapter scopes writes and rejects a stale manifest before publishing',async()=>{
  let owner='owner',reads=0;const docs=new Map(),paths=[];
  const firestore={doc:(_db,...parts)=>{const path=parts.join('/');paths.push(path);return path;},getDocFromServer:async ref=>({exists:()=>docs.has(ref),data:()=>docs.get(ref)}),setDoc:async(ref,value)=>docs.set(ref,value),runTransaction:async(_db,fn)=>fn({get:async ref=>{reads++;return {exists:()=>docs.has(ref),data:()=>docs.get(ref)};},set:(ref,value)=>docs.set(ref,value)})};
  const use=appHarness({stubs:{'auth.js':{currentUid:()=>owner},'db.js':{db:{}},'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':firestore}}),{createVectorCloudAdapter}=await use('vector-cloud-firestore.js'),remote=createVectorCloudAdapter('owner','story');
  await remote.writeChunk('abc','[]');await remote.commitManifest('history',0,{revision:1,kind:'history'});
  await assert.rejects(remote.commitManifest('history',0,{revision:1}),/changed on another device/);
  assert.equal(reads,2);assert.ok(paths.every(path=>path.startsWith('users/owner/sessions/story/vectorIndexes/')));
  owner='other';await assert.rejects(remote.writeChunk('def','[]'),/Account changed/);
});
test('empty cloud indexes replace deleted vectors and survive a round trip',async()=>{
  const {uploadVectorIndex,downloadVectorIndex}=await appHarness()('vector-cloud-core.js'),remote=adapter();
  const original=await uploadVectorIndex({adapter:remote,kind:'history',rows:[row('a')]});
  const empty=await uploadVectorIndex({adapter:remote,kind:'history',rows:[],previousManifest:original.manifest});
  assert.equal(empty.manifest.count,0);assert.equal(empty.manifest.revision,2);
  const restored=await downloadVectorIndex({adapter:remote,kind:'history'});assert.equal(restored.rows.length,0);
});
test('a chunk-write interruption leaves the previous complete cloud index downloadable',async()=>{
  const {uploadVectorIndex,downloadVectorIndex}=await appHarness()('vector-cloud-core.js'),remote=adapter();
  const first=await uploadVectorIndex({adapter:remote,kind:'history',rows:[row('old')]});let writes=0;
  const broken={...remote,writeChunk:async(id,payload)=>{if(++writes===2)throw Error('Interrupted upload');return remote.writeChunk(id,payload);}};
  await assert.rejects(uploadVectorIndex({adapter:broken,kind:'history',rows:[row('new'),{...row('other'),order:201}],previousManifest:first.manifest}),/Interrupted/);
  assert.equal(remote.manifests.get('history').revision,1);const back=await downloadVectorIndex({adapter:remote,kind:'history'});assert.equal(back.rows[0].messageId,'old');
});

async function syncFixture(){
  const remote=adapter();let cached=null,exports=0,pending=null,staleLore=false;
  const snapshot={historyComplete:true,storyEpoch:1,session:{id:'s',historyRevision:1,loreRevision:1,memory:{}},messages:[],entries:[]};
  const use=appHarness({stubs:{'auth.js':{currentUid:()=> 'u'},'vector-cloud-firestore.js':{createVectorCloudAdapter:()=>remote},'vector-cloud-cache.js':{readCachedVectorManifest:async()=>cached,saveCachedVectorManifest:async(_o,_s,_k,value)=>{cached=value;return true;},readCachedVectorChunk:async()=>null,saveCachedVectorChunk:async()=>{}},'history-recall-storage.js':{recallStorage:{loadPendingBatch:async()=>pending}},'history-recall.js':{exportHistoryVectors:async(_sid,options)=>{assert.equal(options.messages,snapshot.messages);exports++;return [];},importHistoryVectors:async()=>({restored:0,skipped:0,persisted:true})},'lore-semantic.js':{loreSemantic:{exportVectors:async()=>[],needsRefresh:async()=>staleLore,importVectors:async()=>({restored:0,skipped:0})}}}});
  return {remote,snapshot,sync:await use('vector-cloud-sync.js'),setCached:value=>cached=value,getCached:()=>cached,exports:()=>exports,setPending:value=>pending=value,setStaleLore:value=>staleLore=value};
}
test('manual sync detects a newer remote revision even if local vectors would be unchanged',async()=>{
  const h=await syncFixture();h.setCached({kind:'history',revision:1,count:0,chunks:[]});h.remote.manifests.set('history',{kind:'history',revision:2,count:0,chunks:[]});
  await assert.rejects(h.sync.uploadStoryVectors(h.snapshot,'history'),/another device/);assert.equal(h.exports(),0);
  await assert.rejects(h.sync.uploadStoryVectors(h.snapshot,'history',{force:true}),/another device/);
});
test('explicit repair recreates a missing cloud manifest and empty sync remains valid',async()=>{
  const h=await syncFixture();h.setCached({kind:'history',revision:5,count:1,chunks:[]});
  await assert.rejects(h.sync.uploadStoryVectors(h.snapshot,'history'),/another device/);
  const repaired=await h.sync.uploadStoryVectors(h.snapshot,'history',{force:true});assert.equal(repaired.manifest.revision,1);assert.equal(repaired.manifest.count,0);assert.equal(h.getCached().revision,1);
  assert.equal((await h.sync.downloadStoryVectors(h.snapshot,'history')).restored,0);
  await assert.rejects(h.sync.uploadStoryVectors({...h.snapshot,historyComplete:false},'history'),/Complete local history/);
});
test('a late cloud-cache write cannot recreate data after its account scope changes',async()=>{
  const fixture=indexedDBFixture({items:[]}),cache=await appHarness({globals:{indexedDB:fixture.indexedDB}})('vector-cloud-cache.js');let active=true;
  const check=()=>{if(!active)throw Error('Account changed');},manifest=cache.saveCachedVectorManifest('u','s','history',{revision:1},check),chunk=cache.saveCachedVectorChunk('u','s','history','chunk','[]',check);
  active=false;assert.equal(await manifest,false);assert.equal(await chunk,false);assert.equal(fixture.stores.get('items').size,0);
});
test('manual upload preserves the complete cloud index while device indexing is pending or stale',async()=>{
  const h=await syncFixture(),manifest={version:1,kind:'history',revision:1,count:1,chunks:[]};h.setCached(manifest);h.remote.manifests.set('history',manifest);h.setPending({fromOrder:1,throughOrder:2});
  await assert.rejects(h.sync.uploadStoryVectors(h.snapshot,'history'),/still updating/);assert.equal(h.remote.manifests.get('history').count,1);assert.equal(h.exports(),0);
  h.setPending(null);h.setStaleLore(true);h.snapshot.session.memory.semanticLore=true;h.setCached(null);
  await assert.rejects(h.sync.uploadStoryVectors(h.snapshot,'lore'),/out of date/);assert.equal(h.remote.manifests.has('lore'),false);
});

for(const failure of ['error','blocked','timeout','throw'])test('vector cache retries after initial open '+failure,async()=>{
 const fixture=indexedDBFixture({items:[]});let opens=0,timeout,late,closed=0;
 const indexedDB={open(...args){if(++opens>1)return fixture.indexedDB.open(...args);if(failure==='throw')throw Error('temporary open failure');const request={result:{close(){closed++;}}};late=request;queueMicrotask(()=>{if(failure==='timeout')timeout();else request[failure==='error'?'onerror':'onblocked']();});return request;}};
 const cache=await appHarness({globals:{indexedDB,setTimeout:fn=>{timeout=fn;return 1;},clearTimeout:()=>{}}})('vector-cloud-cache.js');
 assert.equal(await cache.saveCachedVectorManifest('u','s','history',{revision:1}),false);
 assert.equal(await cache.saveCachedVectorManifest('u','s','history',{revision:2}),true);assert.equal(opens,2);
 if(failure==='timeout'){late.onsuccess();assert.equal(closed,1);}
 assert.equal((await cache.readCachedVectorManifest('u','s','history')).revision,2);assert.equal(opens,2);
});
for(const direction of ['upload','download'])test('vector '+direction+' reports a failed device manifest save',async()=>{
 const remote=adapter(),snapshot={historyComplete:true,storyEpoch:1,session:{id:'s',historyRevision:1,loreRevision:1,memory:{}},messages:[],entries:[]};
 const use=appHarness({stubs:{'auth.js':{currentUid:()=> 'u'},'vector-cloud-firestore.js':{createVectorCloudAdapter:()=>remote},'vector-cloud-cache.js':{readCachedVectorManifest:async()=>null,saveCachedVectorManifest:async()=>false,readCachedVectorChunk:async()=>null,saveCachedVectorChunk:async()=>true},'history-recall-storage.js':{recallStorage:{loadPendingBatch:async()=>null}},'history-recall.js':{exportHistoryVectors:async()=>[],importHistoryVectors:async()=>({restored:0,persisted:true})},'lore-semantic.js':{loreSemantic:{}}}});
 if(direction==='download')await (await use('vector-cloud-core.js')).uploadVectorIndex({adapter:remote,kind:'history',rows:[]});
 const sync=await use('vector-cloud-sync.js');await assert.rejects(sync[direction+'StoryVectors'](snapshot,'history'),/device.*manifest|manifest.*device/i);
});
