import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
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
