const DATABASE='nera-history-recall-v1';
let pending;
// A forced re-embedding may change values without changing the model or vector
// length. Include the float bytes in the incremental-write signature.
function vectorFingerprint(vector){
  if(!vector)return '';
  const values=Object.prototype.toString.call(vector)==='[object Float32Array]' ? vector : Float32Array.from(vector);
  const bytes=new Uint8Array(values.buffer,values.byteOffset,values.byteLength);let a=2166136261,b=2246822519;
  for(const value of bytes){a=Math.imul(a^value,16777619);b=Math.imul(b^value,3266489917);}
  return `${bytes.length}:${a>>>0}:${b>>>0}`;
}
function open() {
  if(typeof indexedDB==='undefined')return Promise.resolve(null);
  if(pending)return pending;
  pending=new Promise(resolve=>{
    let settled=false;
    const done=value=>{if(settled){value?.close();return;}settled=true;clearTimeout(timer);resolve(value);};
    const timer=setTimeout(()=>done(null),3000);
    try {
      const request=indexedDB.open(DATABASE,1);
      request.onupgradeneeded=()=>request.result.createObjectStore('stories',{keyPath:'key'}).createIndex('storyKey','storyKey');
      request.onerror=request.onblocked=()=>done(null);
      request.onsuccess=()=>{request.result.onversionchange=()=>{request.result.close();pending=null;};done(request.result);};
    } catch {done(null);}
  });
  return pending;
}
async function transaction(mode,action) {
  const db=await open();if(!db)return null;
  return new Promise(resolve=>{
    let result=null;
    try {
      const tx=db.transaction('stories',mode),request=action(tx.objectStore('stories'),value=>{result=value;});
      if(request)request.onsuccess=()=>{result=request.result ?? true;};
      tx.oncomplete=()=>resolve(result);tx.onabort=tx.onerror=()=>resolve(null);
    }catch{resolve(null);}
  });
}
export const recallStorage={
  loadPendingBatch:(owner,sid)=>transaction('readonly',(store,result)=>{const request=store.get(JSON.stringify([owner,sid,'pending-batch']));request.onsuccess=()=>result(request.result?.value ?? null);return null;}),
  savePendingBatch:(owner,sid,value)=>transaction('readwrite',(store,result)=>{store.put({key:JSON.stringify([owner,sid,'pending-batch']),owner,value});result(true);return null;}),
  mergePendingBatch:(owner,sid,value,check=()=>true)=>transaction('readwrite',(store,result)=>{
    const key=JSON.stringify([owner,sid,'pending-batch']),request=store.get(key);
    request.onsuccess=()=>{try{if(check()===false)return;const old=request.result?.value,merged={fromOrder:Math.min(value.fromOrder,old?.fromOrder??value.fromOrder),throughOrder:Math.max(value.throughOrder,old?.throughOrder??value.throughOrder),version:(old?.version??0)+1};store.put({key,owner,value:merged});result(merged);}catch{}};
    return null;
  }),
  clearPendingBatch:(owner,sid,expectedVersion)=>transaction('readwrite',(store,result)=>{
    const key=JSON.stringify([owner,sid,'pending-batch']);
    if(expectedVersion==null){store.delete(key);result(true);return null;}
    const request=store.get(key);request.onsuccess=()=>{if(request.result?.value?.version===expectedVersion){store.delete(key);result(true);}else result(false);};return null;
  }),
  loadStage:stageKey=>transaction('readonly',(store,result)=>{
    const request=store.index('storyKey').getAll(stageKey);request.onsuccess=()=>result((request.result ?? []).map(item=>item.row));return null;
  }),
  saveStage:(stageKey,owner,rows)=>transaction('readwrite',(store,result)=>{
    for(const row of rows)store.put({key:JSON.stringify([stageKey,row.id]),owner,storyKey:stageKey,row});result(true);return null;
  }),
  removeStage:stageKey=>transaction('readwrite',(store,result)=>{
    const request=store.index('storyKey').getAllKeys(stageKey);request.onsuccess=()=>{for(const key of request.result)store.delete(key);result(true);};return null;
  }),
  load:key=>transaction('readonly',(store,result)=>{
    let meta,rows,metaReady=false,rowsReady=false;
    const finish=()=>{if(metaReady && rowsReady){const byId=new Map(rows.map(r=>[r.row.id,r.row]));result(meta ? {...meta,rows:(meta.rowIds ?? []).map(id=>byId.get(id)).filter(Boolean)} : null);}};
    const metadata=store.get(key);metadata.onsuccess=()=>{meta=metadata.result;metaReady=true;finish();};
    const passages=store.index('storyKey').getAll(key);passages.onsuccess=()=>{rows=passages.result;rowsReady=true;finish();};
    return null;
  }),
  save:(record,check=()=>true)=>transaction('readwrite',(store,result)=>{
    const request=store.get(record.key);
    request.onsuccess=()=>{
      try{if(check()===false)return;}catch{return;}
      const previous=request.result,signatures={},rowIds=record.rows.map(r=>r.id);
      for(const row of record.rows) {
        const signature=JSON.stringify([row.sourceHash,row.revision,row.order,row.role,row.start,row.end,row.sourceRevision,row.modelKey,row.modelId,row.dimensions,row.formatVersion,vectorFingerprint(row.vector)]);
        signatures[row.id]=signature;
        if(previous?.signatures?.[row.id]!==signature)store.put({key:JSON.stringify([record.key,row.id]),owner:record.owner,storyKey:record.key,row});
      }
      const ids=new Set(rowIds);
      for(const id of previous?.rowIds ?? [])if(!ids.has(id))store.delete(JSON.stringify([record.key,id]));
      const meta={...record,rowIds,signatures};delete meta.rows;
      store.put(meta);result(true);
    };
    return null;
  }),
  remove:key=>transaction('readwrite',(store,result)=>{
    const request=store.index('storyKey').getAllKeys(key);
    request.onsuccess=()=>{for(const id of request.result)store.delete(id);store.delete(key);result(true);};
    return null;
  }),
};
export async function clearRecallAccount(uid) {
  globalThis.document?.dispatchEvent(new CustomEvent('history-recall-cleared',{detail:{owner:uid}}));
  return transaction('readwrite',store=>{
    const request=store.openCursor();
    request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;if(cursor.value.owner===uid)cursor.delete();cursor.continue();};
    return null;
  });
}
export async function deleteRecallStory(owner,sid) {
  globalThis.document?.dispatchEvent(new CustomEvent('history-recall-cleared',{detail:{owner,sid}}));
  await recallStorage.remove(JSON.stringify([owner,sid]));
  await recallStorage.clearPendingBatch(owner,sid);
  return transaction('readwrite',store=>{const request=store.openCursor();request.onsuccess=()=>{const cursor=request.result;if(!cursor)return;try{const parts=JSON.parse(cursor.value.storyKey ?? '');if(parts[0]===owner && parts[1]===sid && parts[2]==='embedding-stage-v1')cursor.delete();}catch{}cursor.continue();};return null;});
}
