// Device-local chat cache. Firestore remains the source for a session that has
// never been opened here; the three most recently used sessions stay in IDB.
const DATABASE = "roleplay-chat-cache";
const STORE = "sessions";
let opening;

function database() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!opening) opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 3);
    let blocked=false;
    request.onupgradeneeded = () => {
      for(const name of [STORE,'outbox','storyData','operations','loreCache'])if(!request.result.objectStoreNames.contains(name))request.result.createObjectStore(name,{keyPath:'key'});
    };
    request.onblocked=()=>{blocked=true;resolve(null);};
    request.onsuccess = () => {
      if(blocked){request.result.close?.();return;}
      request.result.onversionchange=()=>{request.result.close?.();opening=undefined;};
      resolve(request.result);
    };
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
    const tx=db.transaction([STORE,'outbox','storyData'],'readwrite'),store=tx.objectStore(STORE);
    const pins=tx.objectStore('outbox').getAllKeys(),keys=store.getAllKeys();
    const request=store.get('meta:'+uid);
    const apply=order=>{
      store.put({key:`${uid}:${sessionId}`,uid,savedAt:Date.now(),value});
      const recent=[sessionId,...order.filter(id=>id!==sessionId)].slice(0,3);
      if(!request.result || order[0]!==sessionId)store.put({key:'meta:'+uid,order:recent});
      for(const key of keys.result ?? [])if(key.startsWith(uid+':') && !recent.includes(key.slice(uid.length+1)) && !(pins.result ?? []).includes(key)){store.delete(key);tx.objectStore('storyData').delete(key);}
    };
    request.onsuccess=()=>{if(request.result)apply(request.result.order);else{const old=store.getAll();old.onsuccess=()=>apply((old.result ?? []).filter(e=>e.uid===uid).sort((a,b)=>b.savedAt-a.savedAt).map(e=>e.key.slice(uid.length+1)));}};
    tx.oncomplete=resolve;tx.onerror=resolve;tx.onabort=resolve;
  });
}
export async function replaceStoryCache(uid,sid,snapshot,data,{discardPending=false}={}) {
  const db=await database();if(!db){if(discardPending)throw new Error('Could not replace local story data.');return;}
  await new Promise((resolve,reject)=>{
    const tx=db.transaction(discardPending?[STORE,'storyData','outbox','operations','loreCache']:[STORE,'storyData','loreCache'],'readwrite'),key=`${uid}:${sid}`;
    if(data.loreSnapshot)tx.objectStore('loreCache').put({key,value:data.loreSnapshot});
    tx.objectStore(STORE).put({key,uid,savedAt:Date.now(),value:snapshot});
    const aux=tx.objectStore('storyData'),request=aux.get(key);
    request.onsuccess=()=>{const value={...request.result?.value,...data};if(discardPending)delete value.queueBase;aux.put({key,value});};
    if(discardPending){
      const outbox=tx.objectStore('outbox'),header=outbox.get(key);
      header.onsuccess=()=>{for(const id of header.result?.value?.ids ?? [])tx.objectStore('operations').delete(key+':'+id);outbox.delete(key);};
    }
    tx.oncomplete=resolve;tx.onerror=tx.onabort=()=>reject(tx.error ?? new Error('Could not cache refreshed story.'));
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
    const transaction = db.transaction([STORE,'outbox','storyData','loreCache'], "readwrite");
    transaction.objectStore('loreCache').delete(`${uid}:${sessionId}`);
    const pin=transaction.objectStore('outbox').get(`${uid}:${sessionId}`);pin.onsuccess=()=>{if(!pin.result)transaction.objectStore('storyData').delete(`${uid}:${sessionId}`);};
    const store=transaction.objectStore(STORE);store.delete(`${uid}:${sessionId}`);const request=store.get('meta:'+uid);request.onsuccess=()=>{if(request.result)store.put({...request.result,order:request.result.order.filter(id=>id!==sessionId)});};
    transaction.oncomplete = resolve;
    transaction.onerror = resolve;
    transaction.onabort = resolve;
  });
}

export async function cachedSessionIds(uid){
  try{const db=await database();if(!db || !uid)return [];return await new Promise(resolve=>{const r=db.transaction(STORE,'readonly').objectStore(STORE).get('meta:'+uid);r.onsuccess=()=>resolve(r.result?.order ?? []);r.onerror=()=>resolve([]);});}catch{return [];}
}

// Auxiliary data contains story content only, never provider connection settings.
export async function loadStoryData(uid,sid) {return readRecord('storyData',`${uid}:${sid}`);}
export async function saveStoryData(uid,sid,value) {return writeRecords(['storyData'],tx=>(()=>{const store=tx.objectStore('storyData'),key=`${uid}:${sid}`,r=store.get(key);r.onsuccess=()=>store.put({key,value:{...r.result?.value,...value}});})());}
async function readRecord(store,key) {const db=await database();if(!db)return null;return new Promise(resolve=>{const tx=db.transaction(store,'readonly'),r=tx.objectStore(store).get(key);r.onsuccess=()=>resolve(r.result?.value ?? null);r.onerror=()=>resolve(null);});}
async function writeRecords(stores,action) {const db=await database();if(!db)return false;return new Promise(resolve=>{try{const tx=db.transaction(stores,'readwrite');action(tx);tx.oncomplete=()=>resolve(true);tx.onerror=tx.onabort=()=>resolve(false);}catch{resolve(false);}});}
export const loadLoreCache=(uid,sid)=>readRecord('loreCache',`${uid}:${sid}`);
export const saveLoreCache=(uid,sid,value)=>writeRecords(['loreCache'],tx=>tx.objectStore('loreCache').put({key:`${uid}:${sid}`,value}));
export const deleteLoreCache=(uid,sid)=>writeRecords(['loreCache'],tx=>tx.objectStore('loreCache').delete(`${uid}:${sid}`));
export const storyQueueStorage={
  async load(uid,sid){
    const key=`${uid}:${sid}`,header=await readRecord('outbox',key);if(!header)return null;
    const aux=await loadStoryData(uid,sid),records=await Promise.all(header.ids.map(id=>readRecord('operations',key+':'+id)));
    if(!aux?.queueBase || records.some(r=>!r))throw new Error('The local save journal is incomplete. Keep this page open and export your story.');
    return {base:aux.queueBase,records};
  },
  async put(uid,sid,op,base){return writeRecords(['outbox','storyData','operations'],tx=>{
    const key=`${uid}:${sid}`,headers=tx.objectStore('outbox'),r=headers.get(key);
    r.onsuccess=()=>{
      const header=r.result?.value;
      if(!header){const aux=tx.objectStore('storyData'),a=aux.get(key);a.onsuccess=()=>aux.put({key,value:{...a.result?.value,queueBase:base}});}
      tx.objectStore('operations').put({key:key+':'+op.id,value:{op,acknowledged:false}});
      headers.put({key,value:{ids:[...(header?.ids ?? []),op.id]}});
    };
  });},
  async ack(uid,sid,id,base){return writeRecords(['outbox','storyData','operations'],tx=>{
    const key=`${uid}:${sid}`,headers=tx.objectStore('outbox'),r=headers.get(key);
    r.onsuccess=()=>{
      const ids=r.result?.value?.ids ?? [],ops=tx.objectStore('operations');
      if(ids.at(-1)===id){
        const aux=tx.objectStore('storyData'),a=aux.get(key);a.onsuccess=()=>{const value={...a.result?.value,confirmed:base};delete value.queueBase;aux.put({key,value});};
        for(const prior of ids)ops.delete(key+':'+prior);headers.delete(key);
      }else{
        const record=ops.get(key+':'+id);record.onsuccess=()=>{const old=record.result?.value;if(!old)return;const message=base.messages.find(m=>m.id===old.op.payload.id);ops.put({key:key+':'+id,value:{...old,acknowledged:true,result:{session:base.session,...(message?{message}:{})}}});};
      }
    };
  });},
};
