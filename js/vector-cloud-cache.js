const DATABASE='nera-vector-cloud-cache-v1';
let pending;
function open(){
  if(typeof indexedDB==='undefined')return Promise.resolve(null);
  if(pending)return pending;
  pending=new Promise(resolve=>{let done=false;const finish=db=>{if(done){db?.close();return;}done=true;clearTimeout(timer);resolve(db);};const timer=setTimeout(()=>finish(null),3000);
    try{const request=indexedDB.open(DATABASE,1);request.onupgradeneeded=()=>request.result.createObjectStore('items',{keyPath:'key'});request.onerror=request.onblocked=()=>finish(null);request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();pending=null;};finish(request.result);};}catch{finish(null);}});return pending;
}
async function operation(mode,act){const db=await open();if(!db)return null;return new Promise(resolve=>{try{const tx=db.transaction('items',mode),request=act(tx.objectStore('items'));let value=null;request.onsuccess=()=>{value=request.result??true;};tx.oncomplete=()=>resolve(value);tx.onabort=tx.onerror=()=>resolve(null);}catch{resolve(null);}});}
const key=(owner,sid,kind,id)=>JSON.stringify([owner,sid,kind,id]);
export async function readCachedVectorManifest(owner,sid,kind){const v=await operation('readonly',s=>s.get(key(owner,sid,kind,'manifest')));return v?.value??null;}
export async function saveCachedVectorManifest(owner,sid,kind,manifest){return !!await operation('readwrite',s=>s.put({key:key(owner,sid,kind,'manifest'),value:manifest}));}
export async function readCachedVectorChunk(owner,sid,kind,id){const v=await operation('readonly',s=>s.get(key(owner,sid,kind,id)));return v?.value??null;}
export async function saveCachedVectorChunk(owner,sid,kind,id,payload){return !!await operation('readwrite',s=>s.put({key:key(owner,sid,kind,id),value:payload}));}
export async function clearVectorCloudAccount(owner){const db=await open();if(!db)return;return new Promise(resolve=>{const tx=db.transaction('items','readwrite'),s=tx.objectStore('items'),r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;try{if(JSON.parse(c.key)[0]===owner)c.delete();}catch{}c.continue();};tx.oncomplete=tx.onabort=tx.onerror=resolve;});}
export async function deleteVectorCloudStory(owner,sid){const db=await open();if(!db)return;return new Promise(resolve=>{const tx=db.transaction('items','readwrite'),s=tx.objectStore('items'),r=s.openCursor();r.onsuccess=()=>{const c=r.result;if(!c)return;try{const parts=JSON.parse(c.key);if(parts[0]===owner && parts[1]===sid)c.delete();}catch{}c.continue();};tx.oncomplete=tx.onabort=tx.onerror=resolve;});}
