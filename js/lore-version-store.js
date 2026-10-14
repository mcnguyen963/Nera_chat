import { doc, collection, getDocFromServer, getDocsFromServer, onSnapshot } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { db } from './db.js';
import { currentUid } from './auth.js';
import { fromRecordDocument, toRecordDocument } from './lore-records.js';
const parts=sid=>['users',sid?.uid ?? currentUid(),'sessions',sid?.id ?? sid];
export const versionSessionRef=sid=>doc(db,...parts(sid));
export const versionRoot=(sid,generation)=>collection(db,...parts(sid),...(generation ? ['loreV3',generation,'entries'] : ['lore']));
export const versionRef=(sid,id,generation)=>doc(db,...parts(sid),...(generation ? ['loreV3',generation,'entries',id] : ['lore',id]));
export function decodeLoreSnapshot(snap) {
  if(!snap.exists() || snap.data()?.schemaVersion!==3)return snap;
  const entry=fromRecordDocument(snap.data());
  return {id:snap.id,ref:snap.ref,exists:()=>true,data:()=>{const {id,...data}=cloneData(entry);return data;}};
}
function cloneData(value) {
  if(Array.isArray(value))return value.map(cloneData);
  if(value&&typeof value==='object'&&value.constructor?.name==='Object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,cloneData(v)]));
  return value;
}
export async function readLoreCard(sid,id) {
  const session=await getDocFromServer(versionSessionRef(sid));
  return decodeLoreSnapshot(await getDocFromServer(versionRef(sid,id,session.data()?.loreGeneration)));
}
export async function readLoreCards(sid) {
  for(let attempt=0;attempt<3;attempt++) {
    const before=(await getDocFromServer(versionSessionRef(sid))).data(),snap=await getDocsFromServer(versionRoot(sid,before?.loreGeneration)),after=(await getDocFromServer(versionSessionRef(sid))).data();
    if(before?.loreGeneration===after?.loreGeneration && before?.loreRevision===after?.loreRevision)return snap.docs.map(decodeLoreSnapshot);
  }
  throw Object.assign(new Error('Lorebooks changed while loading. Retry.'),{code:'lore-read-changed'});
}
export function subscribeVersionedLore(sid,callback,onError) {
  let stop=null,generation=undefined,epoch=0;
  const outer=onSnapshot(versionSessionRef(sid),snapshot=>{
    const next=snapshot.data()?.loreGeneration ?? null;if(next===generation)return;
    generation=next;const token=++epoch;stop?.();callback([]);
    stop=onSnapshot(versionRoot(sid,generation),snap=>{if(token===epoch)callback(snap.docs.map(d=>({id:d.id,...decodeLoreSnapshot(d).data()})));},onError);
  },onError);
  return ()=>{epoch++;outer();stop?.();};
}
function applyFields(data,fields) {
  const out={...data};
  for(const [key,value] of Object.entries(fields)) {
    const path=key.split('.');let target=out;
    for(const part of path.slice(0,-1)){target[part]={...target[part]};target=target[part];}
    target[path.at(-1)]=value;
  }
  return out;
}
// Existing store operations address logical /lore paths. This boundary translates
// them to the active generation and projects canonical records back to sections.
// All reads finish before any native transaction write, including blind updates.
export function wrapLoreTransaction(tx,sid,session) {
  const generation=session.loreGeneration,queue=[],cache=new Map();
  const logical=target=>target.path?.split('/').slice(-2,-1)[0]==='lore';
  const actual=target=>logical(target)&&generation ? versionRef(sid,target.id ?? target.path.split('/').at(-1),generation) : target;
  const get=async target=>{
    const key=target.path;if(cache.has(key))return cache.get(key);
    const snap=await tx.get(actual(target)),decoded=logical(target) ? decodeLoreSnapshot(snap) : snap;cache.set(key,decoded);return decoded;
  };
  const wrapped={get};for(const method of ['set','update','delete'])wrapped[method]=(target,data,options)=>{queue.push({method,target,data,options});};
  wrapped.flush=async()=>{
    if(session.loreMigration?.active && session.loreMigration.expiresAt>Date.now() && queue.some(w=>logical(w.target)))throw new Error('Lorebook migration is in progress. Try again after it finishes.');
    for(const w of queue)if(generation&&logical(w.target)&&w.method==='update')await get(w.target);
    const state=new Map();
    for(const w of queue) {
      if(!generation||!logical(w.target)){if(w.method==='delete')tx.delete(w.target);else if(w.options)tx[w.method](w.target,w.data,w.options);else tx[w.method](w.target,w.data);continue;}
      const key=w.target.path,id=w.target.id ?? key.split('/').at(-1),target=actual(w.target);
      if(w.method==='delete'){tx.delete(target);state.set(key,null);continue;}
      const previous=state.has(key) ? state.get(key) : cache.get(key)?.data();
      if(w.method==='update'&&!previous)throw new Error('This lorebook subject was deleted');
      const data=w.method==='update' ? applyFields(previous,w.data) : w.options?.merge ? {...previous,...w.data} : w.data;
      const canonical=toRecordDocument({...data,id},previous?{...previous,id}:null);
      if(new TextEncoder().encode(JSON.stringify(canonical)).length>900000)throw new Error('card storage full');
      state.set(key,fromRecordDocument(canonical));tx.set(target,canonical);
    }
  };
  return wrapped;
}
