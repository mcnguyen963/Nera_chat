// Small transactional IndexedDB fixture with separate stores and request ordering.
export function indexedDBFixture(initial={}) {
 const stores=new Map(Object.entries(initial).map(([name,entries])=>[name,new Map(entries)]));let version=1,bulkReads=0;
 const db={objectStoreNames:{contains:name=>stores.has(name)},createObjectStore(name){stores.set(name,new Map());},transaction(names,mode='readonly'){
   names=Array.isArray(names)?names:[names];const working=new Map(names.map(n=>[n,new Map(stores.get(n) ?? [])]));let pending=0,completed=false;
   const tx={};
   const finish=()=>{queueMicrotask(()=>{if(pending || completed)return;completed=true;if(mode==='readwrite')for(const [name,values]of working)stores.set(name,values);tx.oncomplete?.();});};
   const request=read=>{const r={};pending++;queueMicrotask(()=>{try{r.result=structuredClone(read());r.onsuccess?.();}catch(error){r.error=error;r.onerror?.();tx.onerror?.();}finally{pending--;finish();}});return r;};
   tx.objectStore=name=>{if(!working.has(name))working.set(name,new Map(stores.get(name) ?? []));const values=working.get(name);return {get:key=>request(()=>values.get(key)),getAll:()=>{bulkReads++;return request(()=>[...values.values()]);},getAllKeys:()=>request(()=>[...values.keys()]),put:value=>request(()=>{values.set(value.key,structuredClone(value));return value.key;}),delete:key=>request(()=>values.delete(key))};};
   finish();return tx;
 }};
 return {stores,get bulkReads(){return bulkReads;},indexedDB:{open:(_name,nextVersion)=>{const r={result:db};queueMicrotask(()=>{if(nextVersion>version){r.onupgradeneeded?.();version=nextVersion;}r.onsuccess?.();});return r;}},db};
}
