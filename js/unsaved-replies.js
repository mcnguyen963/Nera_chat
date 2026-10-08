// Paid narration is retained independently of the evictable three-story cache.
// Storage is best effort; an unavailable database must never hide the local text.
let opening;
const STORE='replies';
const key=(uid,sid)=>`nera.unsaved.${uid}.${sid}`;
async function database() {
  if(typeof indexedDB==='undefined')return null;
  if(!opening)opening=new Promise((resolve,reject)=>{
    const r=indexedDB.open('nera-unsaved-replies',1);
    r.onupgradeneeded=()=>r.result.createObjectStore(STORE);
    r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);
  }).catch(()=>null);
  return opening;
}
export async function loadUnsavedReply(uid,sid) {
  try {const db=await database();if(!db)return null;return await new Promise(resolve=>{
    const r=db.transaction(STORE,'readonly').objectStore(STORE).get(key(uid,sid));
    r.onsuccess=()=>resolve(r.result ?? null);r.onerror=()=>resolve(null);
  });}catch{return null;}
}
export async function storeUnsavedReply(uid,sid,value) {
  try {const db=await database();if(!db)return;await new Promise(resolve=>{
    const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);
    if(value)store.put(value,key(uid,sid));else store.delete(key(uid,sid));
    tx.oncomplete=resolve;tx.onerror=resolve;tx.onabort=resolve;
  });}catch{/* The visible local reply is still available to copy. */}
}
