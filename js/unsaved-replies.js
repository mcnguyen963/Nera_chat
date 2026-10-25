// Paid narration is retained independently of the evictable three-story cache.
// Storage is best effort; an unavailable database must never hide the local text.
let opening;
const memory=new Map();
const STORE='replies';
const key=(uid,sid)=>`nera.unsaved.${uid}.${sid}`;
async function database() {
  if(typeof indexedDB==='undefined')return null;
  if(!opening)opening=new Promise((resolve,reject)=>{
    const r=indexedDB.open('nera-unsaved-replies',1);
    r.onupgradeneeded=()=>r.result.createObjectStore(STORE);
    let blocked=false;
    r.onblocked=()=>{blocked=true;resolve(null);};
    r.onsuccess=()=>{if(blocked){r.result.close?.();return;}r.result.onversionchange=()=>{r.result.close?.();opening=undefined;};resolve(r.result);};r.onerror=()=>reject(r.error);
  }).catch(()=>null);
  return opening;
}
export async function loadUnsavedReply(uid,sid) {
  const id=key(uid,sid);
  if(memory.has(id))return structuredClone(memory.get(id));
  try {const db=await database();if(memory.has(id))return structuredClone(memory.get(id));if(!db)return null;return await new Promise(resolve=>{
    const r=db.transaction(STORE,'readonly').objectStore(STORE).get(id);
    r.onsuccess=()=>resolve(structuredClone(memory.has(id)?memory.get(id):r.result ?? null));r.onerror=()=>resolve(structuredClone(memory.get(id) ?? null));
  });}catch{return null;}
}
export async function storeUnsavedReply(uid,sid,value) {
  const id=key(uid,sid),saved=structuredClone(value ?? null);memory.set(id,saved);
  try {const db=await database();if(!db)return false;return await new Promise(resolve=>{
    const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);
    if(saved)store.put(saved,id);else store.delete(id);
    tx.oncomplete=()=>resolve(true);tx.onerror=tx.onabort=()=>resolve(false);
  });}catch{return false;}
}
