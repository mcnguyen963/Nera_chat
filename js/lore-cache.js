import * as storage from './chat-cache.js';

const records=new Map(),hydrating=new Map(),downloads=new Map(),failures=new Map(),journals=new Map(),versions=new Map();
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
function serial(key,work){const job=(journals.get(key) ?? Promise.resolve()).catch(()=>{}).then(work);journals.set(key,job);return job;}
async function persist(uid,sid,snapshot){try{await storage.saveLoreCache?.(uid,sid,loreData(snapshot));}catch{/* The in-memory copy remains usable. */}}
export async function cachedLoreSnapshot(uid,sid){
  const key=keyOf(uid,sid);
  if(records.has(key))return structuredClone(records.get(key));
  if(hydrating.has(key))return structuredClone(await hydrating.get(key));
  const version=loreCacheVersion(uid,sid);
  const job=(async()=>{
    let saved;
    try{saved=await storage.loadLoreCache?.(uid,sid);if(!saved){const old=await storage.loadStoryData?.(uid,sid);if(Array.isArray(old?.lore?.entries))saved={version:1,initialized:true,entries:old.lore.entries,loadedRevision:old.lore.revision ?? 0,lastCommittedRevision:old.lore.revision ?? 0,schemaVersion:old.lore.entries.some(e=>e.schemaVersion===3)?3:2,generation:old.lore.generation ?? null,entryRevisions:{}};}}catch{}
    if(loreCacheVersion(uid,sid)!==version)return records.has(key)?structuredClone(records.get(key)):null;
    if(saved && Array.isArray(saved.entries)){records.set(key,loreData(saved));await persist(uid,sid,saved);return structuredClone(records.get(key));}
    return null;
  })().finally(()=>hydrating.delete(key));
  hydrating.set(key,job);return structuredClone(await job);
}
export async function replaceLoreSnapshot(uid,sid,snapshot,{persist:save=true,expectedVersion,commit}={}){
  const key=keyOf(uid,sid);
  return serial(key,async()=>{
    if(expectedVersion!=null && loreCacheVersion(uid,sid)!==expectedVersion)throw new Error('Lore changed locally during Sync. Local data was kept.');
    const {cacheVersion,...data}=snapshot;
    const next=loreData({version:1,initialized:true,entryRevisions:{},...data});
    // Stage the complete story replacement before publishing any part of Sync.
    if(commit)await commit();
    records.set(key,next);failures.delete(key);bump(key);
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
      records.set(key,next);bump(key);await persist(uid,sid,next);return structuredClone(next);
    });
  })().catch(error=>{if(loreCacheVersion(uid,sid)===version)failures.set(key,error);throw error;}).finally(()=>downloads.delete(key));
  downloads.set(key,job);return structuredClone(await job);
}
function patchFields(entry,fields){const out=structuredClone(entry);for(const [path,value]of Object.entries(fields)){const parts=path.split('.');let target=out;for(const part of parts.slice(0,-1))target=target[part]={...target[part]};target[parts.at(-1)]=loreData(value);}return out;}
export async function applyLoreDelta(delta){
  const {uid,sid,revision,generation}=delta,key=keyOf(uid,sid);
  await cachedLoreSnapshot(uid,sid);
  return serial(key,async()=>{
    const current=records.get(key) ?? {version:1,initialized:false,entries:[],loadedRevision:null,lastCommittedRevision:0,entryRevisions:{},generation,schemaVersion:delta.schemaVersion};
    const next=structuredClone(current),entries=new Map(next.entries.map(e=>[e.id,e]));
    for(const change of delta.changes){
      if(revision<=Math.max(next.loadedRevision ?? -1,next.entryRevisions[change.id] ?? -1))continue;
      if(change.type==='delete')entries.delete(change.id);
      else if(change.type==='set')entries.set(change.id,{...loreData(change.data),id:change.id});
      else if(entries.has(change.id))entries.set(change.id,patchFields(entries.get(change.id),change.data));
      next.entryRevisions[change.id]=revision;
    }
    next.entries=[...entries.values()];next.lastCommittedRevision=Math.max(next.lastCommittedRevision ?? 0,revision);
    records.set(key,next);bump(key);await persist(uid,sid,next);return structuredClone(next);
  });
}
export async function initializeLoreCache(uid,sid,{schemaVersion=2,generation=null}={}){return replaceLoreSnapshot(uid,sid,{entries:[],loadedRevision:0,lastCommittedRevision:0,schemaVersion,generation});}
export async function forgetLoreCache(uid,sid){const key=keyOf(uid,sid);bump(key);records.delete(key);failures.delete(key);await serial(key,async()=>{records.delete(key);failures.delete(key);try{await storage.deleteLoreCache?.(uid,sid);}catch{}});}
export function loreSnapshotInfo(snapshot){return {source:'device-cache',loadedRevision:snapshot.loadedRevision,lastCommittedRevision:snapshot.lastCommittedRevision,schemaVersion:snapshot.schemaVersion,generation:snapshot.generation};}
