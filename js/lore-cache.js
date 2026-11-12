import { applyDottedPatch } from './dotted-patch.js';
import * as storage from './chat-cache.js';

const records=new Map(),hydrating=new Map(),downloads=new Map(),failures=new Map(),journals=new Map(),versions=new Map();
// Only complete, durably saved snapshots may leave memory. Active operations
// and failed-storage fallbacks stay pinned; versions retain deletion tombstones.
const durable=new WeakSet(),MAX_SNAPSHOTS=3;
function remember(key,value){records.delete(key);records.set(key,value);}
function prune(){
  for(const [key,value]of records){
    if(records.size<=MAX_SNAPSHOTS)break;
    if(durable.has(value) && !journals.has(key) && !hydrating.has(key) && !downloads.has(key))records.delete(key);
  }
}
const keyOf=(uid,sid)=>JSON.stringify([uid,sid]);
export const loreCacheVersion=(uid,sid)=>versions.get(keyOf(uid,sid)) ?? 0;
function bump(key){versions.set(key,(versions.get(key) ?? 0)+1);}
// Firestore transforms are not data. Keep local timestamp estimates serializable.
export function loreData(value){
  if(value?._methodName==='serverTimestamp')return {seconds:Math.floor(Date.now()/1000),nanoseconds:0};
  if(value instanceof Date)return {seconds:Math.floor(value.getTime()/1000),nanoseconds:(value.getTime()%1000)*1e6};
  if(typeof value?.seconds==='number' && typeof value?.nanoseconds==='number' && typeof value?.toDate==='function')return {seconds:value.seconds,nanoseconds:value.nanoseconds};
  if(Array.isArray(value))return value.map(loreData);
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([,v])=>typeof v!=='function').map(([k,v])=>[k,loreData(v)]));
  return value;
}
function serial(key,work){
  const job=(journals.get(key) ?? Promise.resolve()).catch(()=>{}).then(work);
  journals.set(key,job);
  const settled=()=>{if(journals.get(key)===job)journals.delete(key);prune();};
  // Observe both outcomes without retaining fulfilled snapshot promises or
  // creating an unhandled rejection from a detached finally chain.
  job.then(settled,settled);return job;
}
async function persist(uid,sid,snapshot){try{if(await storage.saveLoreCache?.(uid,sid,loreData(snapshot))===true)durable.add(snapshot);}catch{/* The in-memory copy remains usable. */}}
export async function cachedLoreSnapshot(uid,sid){
  const key=keyOf(uid,sid);
  if(records.has(key)){const value=records.get(key);remember(key,value);return structuredClone(value);}
  if(hydrating.has(key))return structuredClone(await hydrating.get(key));
  const version=loreCacheVersion(uid,sid);
  const job=(async()=>{
    let saved;
    try{saved=await storage.loadLoreCache?.(uid,sid);if(!saved){const old=await storage.loadStoryData?.(uid,sid);if(Array.isArray(old?.lore?.entries))saved={version:1,initialized:true,entries:old.lore.entries,loadedRevision:old.lore.revision ?? 0,lastCommittedRevision:old.lore.revision ?? 0,schemaVersion:old.lore.entries.some(e=>e.schemaVersion===3)?3:2,generation:old.lore.generation ?? null,entryRevisions:{}};}}catch{}
    if(loreCacheVersion(uid,sid)!==version)return records.has(key)?structuredClone(records.get(key)):null;
    if(saved && Array.isArray(saved.entries)){const next=loreData(saved);remember(key,next);durable.add(next);await persist(uid,sid,next);return structuredClone(next);}
    return null;
  })().finally(()=>{hydrating.delete(key);prune();});
  hydrating.set(key,job);return structuredClone(await job);
}
export async function replaceLoreSnapshot(uid,sid,snapshot,{persist:save=true,expectedVersion,commit}={}){
  const key=keyOf(uid,sid);
  return serial(key,async()=>{
    if(expectedVersion!=null && loreCacheVersion(uid,sid)!==expectedVersion)throw new Error('Lore changed locally during Sync. Local data was kept.');
    const {cacheVersion,...data}=snapshot;
    const next=loreData({version:1,initialized:true,entryRevisions:{},...data});
    // Stage the complete story replacement before publishing any part of Sync.
    // A true commit result confirms the caller saved this lore atomically.
    const committed=commit ? await commit() : false;
    remember(key,next);if(committed===true)durable.add(next);failures.delete(key);bump(key);
    if(save)await persist(uid,sid,next);
    return structuredClone(next);
  });
}
export async function getCachedLoreSnapshot(uid,sid,download){
  const key=keyOf(uid,sid),cached=await cachedLoreSnapshot(uid,sid);
  if(cached?.initialized)return cached;
  if(downloads.has(key))return structuredClone(await downloads.get(key));
  if(failures.has(key))throw failures.get(key);
  const version=loreCacheVersion(uid,sid);
  const job=(async()=>{
    const fetched=await download();
    return serial(key,async()=>{
      const current=records.get(key);
      if(loreCacheVersion(uid,sid)!==version && !current)throw new Error('Story changed while loading lorebooks.');
      if(loreCacheVersion(uid,sid)!==version && current?.initialized)return structuredClone(current);
      const next=loreData({version:1,initialized:true,entryRevisions:{},...fetched});
      // A save acknowledged during the initial download must survive its result.
      if(current && current.generation===next.generation){
        const entries=new Map(next.entries.map(e=>[e.id,e]));
        for(const [id,revision]of Object.entries(current.entryRevisions ?? {}))if(revision>(next.loadedRevision ?? 0)){
          const entry=current.entries.find(e=>e.id===id);if(entry)entries.set(id,entry);else entries.delete(id);next.entryRevisions[id]=revision;
        }
        next.entries=[...entries.values()];next.lastCommittedRevision=Math.max(next.lastCommittedRevision ?? 0,current.lastCommittedRevision ?? 0);
      }
      remember(key,next);bump(key);await persist(uid,sid,next);return structuredClone(next);
    });
  })().catch(error=>{if(loreCacheVersion(uid,sid)===version)failures.set(key,error);throw error;}).finally(()=>{downloads.delete(key);prune();});
  downloads.set(key,job);return structuredClone(await job);
}

export async function applyLoreDelta(delta){
  const {uid,sid,revision,generation}=delta,key=keyOf(uid,sid);
  return serial(key,async()=>{
    // Pin before hydration: another story's completion may otherwise evict the
    // recovered base between this await and admission to the write journal.
    await cachedLoreSnapshot(uid,sid);
    const current=records.get(key) ?? {version:1,initialized:false,entries:[],loadedRevision:null,lastCommittedRevision:0,entryRevisions:{},generation,schemaVersion:delta.schemaVersion};
    const next=structuredClone(current),entries=new Map(next.entries.map(e=>[e.id,e]));
    for(const change of delta.changes){
      if(revision<=Math.max(next.loadedRevision ?? -1,next.entryRevisions[change.id] ?? -1))continue;
      if(change.type==='delete')entries.delete(change.id);
      else if(change.type==='set')entries.set(change.id,{...loreData(change.data),id:change.id});
      else if(entries.has(change.id))entries.set(change.id,applyDottedPatch(structuredClone(entries.get(change.id)),change.data,loreData));
      next.entryRevisions[change.id]=revision;
    }
    next.entries=[...entries.values()];next.lastCommittedRevision=Math.max(next.lastCommittedRevision ?? 0,revision);
    remember(key,next);bump(key);await persist(uid,sid,next);return structuredClone(next);
  });
}
export async function initializeLoreCache(uid,sid,{schemaVersion=2,generation=null}={}){return replaceLoreSnapshot(uid,sid,{entries:[],loadedRevision:0,lastCommittedRevision:0,schemaVersion,generation});}
export async function forgetLoreCache(uid,sid){const key=keyOf(uid,sid);bump(key);records.delete(key);failures.delete(key);await serial(key,async()=>{records.delete(key);failures.delete(key);try{await storage.deleteLoreCache?.(uid,sid);}catch{}});}
export function loreSnapshotInfo(snapshot){return {source:'device-cache',loadedRevision:snapshot.loadedRevision,lastCommittedRevision:snapshot.lastCommittedRevision,schemaVersion:snapshot.schemaVersion,generation:snapshot.generation};}
