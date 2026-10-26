// Small transactional IndexedDB fixture with serial native-style transactions.
export function indexedDBFixture(initial={}) {
 const stores=new Map(Object.entries(initial).map(([name,entries])=>[name,new Map(entries)]));let version=1,bulkReads=0,tail=Promise.resolve();
 const db={objectStoreNames:{contains:name=>stores.has(name)},createObjectStore(name){stores.set(name,new Map());},transaction(names,mode='readonly'){
   names=Array.isArray(names)?names:[names];let working,active=false,pending=0,completed=false,release;const waiting=[];
   const previous=tail;tail=new Promise(resolve=>release=resolve);
   const tx={abort(){if(completed)return;completed=true;queueMicrotask(()=>{tx.onabort?.();release();});}};
   const finish=()=>{queueMicrotask(()=>{if(!active || pending || completed)return;completed=true;if(mode==='readwrite')for(const [name,values]of working)stores.set(name,values);tx.oncomplete?.();release();});};
   const request=read=>{const r={};pending++;const run=()=>queueMicrotask(()=>{if(completed)return;try{r.result=structuredClone(read());r.onsuccess?.();}catch(error){r.error=error;tx.error=error;r.onerror?.();tx.onerror?.();tx.abort();}finally{pending--;finish();}});if(active)run();else waiting.push(run);return r;};
   const values=name=>working.get(name);
   tx.objectStore=name=>({get:key=>request(()=>values(name).get(key)),getAll:()=>{bulkReads++;return request(()=>[...values(name).values()]);},getAllKeys:()=>request(()=>[...values(name).keys()]),put:value=>request(()=>{values(name).set(value.key,structuredClone(value));return value.key;}),delete:key=>request(()=>values(name).delete(key))});
   previous.then(()=>{if(completed)return;working=new Map(names.map(name=>[name,new Map(stores.get(name) ?? [])]));active=true;for(const run of waiting)run();finish();});
   return tx;
 }};
 return {stores,get bulkReads(){return bulkReads;},indexedDB:{open:(_name,nextVersion)=>{const r={result:db};queueMicrotask(()=>{if(nextVersion>version){r.onupgradeneeded?.();version=nextVersion;}r.onsuccess?.();});return r;}},db};
}
