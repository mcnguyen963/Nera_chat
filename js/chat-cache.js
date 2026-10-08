// Device-local chat cache. Firestore remains the source for a session that has
// never been opened here; the three most recently used sessions stay in IDB.
const DATABASE = "roleplay-chat-cache";
const STORE = "sessions";
let opening;

function database() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "key" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }).catch(() => null);
  return opening;
}

export async function loadChatCache(uid, sessionId) {
  const db = await database();
  if (!db) return null;
  return new Promise((resolve) => {
    const request = db.transaction(STORE, "readonly").objectStore(STORE).get(`${uid}:${sessionId}`);
    request.onsuccess = () => resolve(request.result?.value ?? null);
    request.onerror = () => resolve(null);
  });
}

export function nextOrder(order,sid) {return [sid,...order.filter(id=>id!==sid)].slice(0,3);}
export async function saveChatCache(uid,sessionId,value) {
  const db=await database();if(!db)return;
  await new Promise(resolve=>{
    const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE);
    const request=store.get('meta:'+uid);
    const apply=order=>{store.put({key:`${uid}:${sessionId}`,uid,savedAt:Date.now(),value});if(request.result && order[0]===sessionId)return;const all=[sessionId,...order.filter(id=>id!==sessionId)];store.put({key:'meta:'+uid,order:all.slice(0,3)});for(const id of all.slice(3))store.delete(`${uid}:${id}`);};
    request.onsuccess=()=>{if(request.result)apply(request.result.order);else{const old=store.getAll();old.onsuccess=()=>apply((old.result ?? []).filter(e=>e.uid===uid).sort((a,b)=>b.savedAt-a.savedAt).map(e=>e.key.slice(uid.length+1)));}};
    tx.oncomplete=resolve;tx.onerror=resolve;tx.onabort=resolve;
  });
}
export async function clearChatCache(uid) {
  const db=await database();if(!db)return;
  await new Promise(resolve=>{const tx=db.transaction(STORE,'readwrite'),store=tx.objectStore(STORE),req=store.getAllKeys();req.onsuccess=()=>{for(const key of req.result)if(key.startsWith(uid+':') || key==='meta:'+uid)store.delete(key);};tx.oncomplete=resolve;tx.onerror=resolve;tx.onabort=resolve;});
}

export async function deleteChatCache(uid, sessionId) {
  const db = await database();
  if (!db) return;
  await new Promise((resolve) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store=transaction.objectStore(STORE);store.delete(`${uid}:${sessionId}`);const request=store.get('meta:'+uid);request.onsuccess=()=>{if(request.result)store.put({...request.result,order:request.result.order.filter(id=>id!==sessionId)});};
    transaction.oncomplete = resolve;
    transaction.onerror = resolve;
    transaction.onabort = resolve;
  });
}

export async function cachedSessionIds(uid){
  try{const db=await database();if(!db || !uid)return [];return await new Promise(resolve=>{const r=db.transaction(STORE,'readonly').objectStore(STORE).get('meta:'+uid);r.onsuccess=()=>resolve(r.result?.order ?? []);r.onerror=()=>resolve([]);});}catch{return [];}
}
