import {currentUid} from './auth.js';
import {createVectorCloudAdapter} from './vector-cloud-firestore.js';
import {uploadVectorIndex,downloadVectorIndex} from './vector-cloud-core.js';
import {readCachedVectorManifest,saveCachedVectorManifest,readCachedVectorChunk,saveCachedVectorChunk} from './vector-cloud-cache.js';
import {exportHistoryVectors,importHistoryVectors} from './history-recall.js';
import {loreSemantic} from './lore-semantic.js';
import {usableLore} from './continuity.js';
import {recallStorage} from './history-recall-storage.js';

function scope(snapshot,getLive){const owner=currentUid(),sid=snapshot.session.id,epoch=snapshot.storyEpoch;return {owner,sid,check(){const now=getLive();if(currentUid()!==owner || !now || now.session.id!==sid || now.storyEpoch!==epoch || now.session.historyRevision!==snapshot.session.historyRevision || now.session.loreRevision!==snapshot.session.loreRevision)throw new Error('Story or account changed; vector sync stopped.');}};}
export async function uploadStoryVectors(snapshot,kind,{getLive=()=>snapshot,onProgress=()=>{},force=false}={}){
  if(!snapshot.historyComplete)throw new Error('Complete local history is needed to verify uploaded vectors.');
  const {owner,sid,check}=scope(snapshot,getLive),adapter=createVectorCloudAdapter(owner,sid,check);let previousManifest=await readCachedVectorManifest(owner,sid,kind);check();
  const remoteManifest=await adapter.loadManifest(kind);check();
  if(force && !remoteManifest)previousManifest=null;
  if((remoteManifest?.revision ?? 0)!==(previousManifest?.revision ?? 0))throw new Error('Vector index changed on another device. Download it before syncing again.');
  const entries=kind==='lore'?usableLore(snapshot.entries,snapshot.messages,snapshot.session).entries:null;
  if(kind==='history' && await recallStorage.loadPendingBatch(owner,sid))throw new Error('Historical search is still updating. Finish or retry indexing before uploading.');check();
  if(kind==='lore' && snapshot.session.memory?.semanticLore && await loreSemantic.needsRefresh?.({owner,sid,mem:snapshot.session.memory,entries}))throw new Error('Lore search is still updating or out of date. Finish or retry indexing before uploading.');check();
  const rows=kind==='history' ? await exportHistoryVectors(sid,{messages:snapshot.messages}) : await loreSemantic.exportVectors({owner,sid,mem:snapshot.session.memory,entries});check();
  const result=await uploadVectorIndex({adapter,kind,rows,previousManifest,check,onProgress,force});check();
  await saveCachedVectorManifest(owner,sid,kind,result.manifest,check);check();return result;
}
export async function downloadStoryVectors(snapshot,kind,{getLive=()=>snapshot,onProgress=()=>{}}={}){
  if(!snapshot.historyComplete)throw new Error('Complete local history is needed to verify downloaded vectors.');
  const {owner,sid,check}=scope(snapshot,getLive),adapter=createVectorCloudAdapter(owner,sid,check),manifest=await adapter.loadManifest(kind);check();
  if(!manifest)throw new Error('No cloud vector index exists for this story.');
  const cached=new Map();for(const chunk of manifest.chunks ?? []){const payload=await readCachedVectorChunk(owner,sid,kind,chunk.id);if(payload)cached.set(chunk.id,payload);check();}
  const result=await downloadVectorIndex({adapter:{...adapter,loadManifest:async()=>manifest},kind,cache:cached,check,onProgress});check();
  const imported=kind==='history' ? await importHistoryVectors(snapshot,result.rows,{check:()=>{check();return true;}}) : await loreSemantic.importVectors({owner,sid,mem:snapshot.session.memory,entries:usableLore(snapshot.entries,snapshot.messages,snapshot.session).entries,rows:result.rows,check});check();
  if(imported.persisted===false)throw new Error('Device storage is unavailable; downloaded vectors were not saved.');
  for(const [id,payload] of cached){check();await saveCachedVectorChunk(owner,sid,kind,id,payload,check);check();}
  await saveCachedVectorManifest(owner,sid,kind,manifest,check);check();return {...imported,reads:result.reads,modelIds:[...new Set(result.rows.map(r=>r.modelId).filter(Boolean))]};
}
