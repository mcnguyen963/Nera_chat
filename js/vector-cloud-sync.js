import {currentUid} from './auth.js';
import {createVectorCloudAdapter} from './vector-cloud-firestore.js';
import {uploadVectorIndex,downloadVectorIndex} from './vector-cloud-core.js';
import {readCachedVectorManifest,saveCachedVectorManifest,readCachedVectorChunk,saveCachedVectorChunk} from './vector-cloud-cache.js';
import {exportHistoryVectors,importHistoryVectors} from './history-recall.js';
import {loreSemantic} from './lore-semantic.js';
import {usableLore} from './continuity.js';

function scope(snapshot,getLive){const owner=currentUid(),sid=snapshot.session.id,epoch=snapshot.storyEpoch;return {owner,sid,check(){const now=getLive();if(currentUid()!==owner || !now || now.session.id!==sid || now.storyEpoch!==epoch || now.session.historyRevision!==snapshot.session.historyRevision || now.session.loreRevision!==snapshot.session.loreRevision)throw new Error('Story or account changed; vector sync stopped.');}};}
export async function uploadStoryVectors(snapshot,kind,{getLive=()=>snapshot,onProgress=()=>{},force=false}={}){
  const {owner,sid,check}=scope(snapshot,getLive),adapter=createVectorCloudAdapter(owner,sid,check),previousManifest=await readCachedVectorManifest(owner,sid,kind);check();
  const rows=kind==='history' ? await exportHistoryVectors(sid) : await loreSemantic.exportVectors({owner,sid,mem:snapshot.session.memory});check();
  if(!rows.length)throw new Error('There are no local vectors to upload. Build the index first.');
  const result=await uploadVectorIndex({adapter,kind,rows,previousManifest,check,onProgress,force});check();
  await saveCachedVectorManifest(owner,sid,kind,result.manifest);return result;
}
export async function downloadStoryVectors(snapshot,kind,{getLive=()=>snapshot,onProgress=()=>{}}={}){
  if(!snapshot.historyComplete)throw new Error('Complete local history is needed to verify downloaded vectors.');
  const {owner,sid,check}=scope(snapshot,getLive),adapter=createVectorCloudAdapter(owner,sid,check),manifest=await adapter.loadManifest(kind);check();
  if(!manifest)throw new Error('No cloud vector index exists for this story.');
  const cached=new Map();for(const chunk of manifest.chunks ?? []){const payload=await readCachedVectorChunk(owner,sid,kind,chunk.id);if(payload)cached.set(chunk.id,payload);check();}
  const result=await downloadVectorIndex({adapter:{...adapter,loadManifest:async()=>manifest},kind,cache:cached,check,onProgress});check();
  const imported=kind==='history' ? await importHistoryVectors(snapshot,result.rows,{check:()=>{check();return true;}}) : await loreSemantic.importVectors({owner,sid,mem:snapshot.session.memory,entries:usableLore(snapshot.entries,snapshot.messages,snapshot.session).entries,rows:result.rows,check});check();
  if(imported.persisted===false)throw new Error('Device storage is unavailable; downloaded vectors were not saved.');
  for(const [id,payload] of cached)await saveCachedVectorChunk(owner,sid,kind,id,payload);
  await saveCachedVectorManifest(owner,sid,kind,manifest);return {...imported,reads:result.reads,modelIds:[...new Set(result.rows.map(r=>r.modelId).filter(Boolean))]};
}
