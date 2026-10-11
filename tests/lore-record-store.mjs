import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const FIRESTORE='https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
async function setup(){
 const path='users/u/sessions/s',docs=new Map([[path,{loreRevision:0}]]),control={failStage:false,failActivation:false,uid:'u'},listeners=[];
 const ref=(_db,...p)=>({path:p.join('/'),id:p.at(-1)});
 const snap=r=>({id:r.id,ref:r,exists:()=>docs.has(r.path),data:()=>structuredClone(docs.get(r.path))});
 const apply=(method,r,data)=>{
   if(method==='delete'){docs.delete(r.path);return;}
   const out=method==='set'?{}:structuredClone(docs.get(r.path));
   for(const [key,value] of Object.entries(data)){const parts=key.split('.');let node=out;for(const p of parts.slice(0,-1))node=node[p]??={};const last=parts.at(-1);node[last]=value?.increment?(node[last]??0)+value.increment:value;}
   docs.set(r.path,out);
 };
 const firestore={doc:ref,collection:ref,serverTimestamp:()=>123,Timestamp:class{},increment:n=>({increment:n}),getDocFromServer:async r=>snap(r),getDocsFromServer:async r=>({docs:[...docs.keys()].filter(p=>p.startsWith(r.path+'/')&&!p.slice(r.path.length+1).includes('/')).map(p=>snap({path:p,id:p.split('/').at(-1)}))}),onSnapshot:(r,cb)=>{listeners.push({r,cb});return ()=>{};},
 runTransaction:async(_db,action)=>{const writes=[];const result=await action({get:async r=>{assert.equal(writes.length,0,'all native reads before writes');return snap(r);},set:(...args)=>writes.push(['set',...args]),update:(...args)=>writes.push(['update',...args]),delete:(...args)=>writes.push(['delete',...args])});if(control.failStage&&writes.some(([m,r])=>m==='set'&&r.path.includes('/entries/')))throw Error('stage failed');if(control.failActivation&&writes.some(([,r,d])=>r.path===path&&d?.loreSchemaVersion===3))throw Error('activation failed');for(const w of writes)apply(...w);return result;},
 writeBatch:()=>{const writes=[];return {set:(...args)=>writes.push(['set',...args]),delete:(...args)=>writes.push(['delete',...args]),commit:async()=>{for(const w of writes)apply(...w);}};}};
 const use=appHarness({stubs:{[FIRESTORE]:firestore,'db.js':{db:{}},'auth.js':{currentUid:()=>control.uid},'messages.js':{getMessages:async()=>[]}}}),store=await use('lore-store.js'),l=await use('lore-lines.js'),records=await use('lore-records.js');
 const e=l.makeEntry('characters','Mira');e.id='mira';e.sections.notes.text='Obedient, not affectionate.';docs.set(path+'/lore/mira',structuredClone(e));
 return {store,l,records,docs,control,path,entry:e,firestore};
}
test('migration stages canonical sources and records before atomically activating a generation',async()=>{
 const {store,docs,path,entry}=await setup();const result=await store.migrateRecords('s',[entry],{expectedRevision:0});const session=docs.get(path);assert.equal(session.loreGeneration,result.generation);assert.equal(session.loreSchemaVersion,3);assert.equal(session.loreRevision,1);assert.equal(docs.get(path+'/lore/mira').sections.notes.text,entry.sections.notes.text);
 const active=docs.get(path+'/loreV3/'+result.generation+'/entries/mira');assert.equal(active.schemaVersion,3);assert.equal(active.sections,undefined);assert.ok(active.sources.length);assert.ok(active.records.length);assert.equal((await store.getLore('s'))[0].sections.notes.text,entry.sections.notes.text);
});
for(const failure of ['failStage','failActivation'])test(failure+' leaves the old generation active and releases the write barrier',async()=>{
 const {store,docs,path,entry,control}=await setup();control[failure]=true;await assert.rejects(()=>store.migrateRecords('s',[entry],{expectedRevision:0}));assert.equal(docs.get(path).loreGeneration,undefined);assert.equal(docs.get(path).loreRevision,0);assert.equal(docs.get(path).loreMigration.active,false);assert.equal((await store.getLore('s'))[0].sections.notes.text,entry.sections.notes.text);
});
test('versioned saves preserve concurrent source notes, invalidate cores and create new records',async()=>{
 const {store,docs,path,entry,records}=await setup();let prepared=records.reconcileRecords(entry);records.approveRecord(prepared,prepared.recordLayout.records[0]);await store.migrateRecords('s',[prepared],{expectedRevision:0});const before=(await store.getLore('s'))[0],edited=structuredClone(before);edited.sections.notes.text='Obedient, with independent judgment.';await store.saveEntry('s',edited,before);const saved=(await store.getLore('s'))[0];assert.equal(saved.sections.notes.text,edited.sections.notes.text);assert.equal(records.approvedRecord(saved,saved.recordLayout.records[0]),false);assert.equal(saved.recordLayout.records[0].approval,undefined);assert.equal(records.archivedRecord(saved,saved.recordLayout.records[0])[0].text,entry.sections.notes.text);assert.ok(saved.recordLayout.records.some(r=>records.resolveRecord(saved,r).text===edited.sections.notes.text));assert.equal(docs.get(path).loreRevision,2);
});
test('source and revision mismatches reject migration without activating or deleting information',async()=>{
 const {store,docs,path,entry}=await setup();await assert.rejects(()=>store.migrateRecords('s',[entry],{expectedRevision:4}),/changed/);const edited=structuredClone(entry);edited.sections.notes.text='Changed';await assert.rejects(()=>store.migrateRecords('s',[edited],{expectedRevision:0}),/sources changed/i);assert.equal(docs.get(path).loreGeneration,undefined);
});
test('rollback reconstructs legacy sources including notes added after migration and removes archived deleted subjects',async()=>{
 const {store,docs,path,entry}=await setup();await store.migrateRecords('s',[entry],{expectedRevision:0});let before=(await store.getLore('s'))[0],edited=structuredClone(before);edited.sections.notes.lines.push({id:'later',text:'Later event.',by:'user',turn:7,at:10});await store.saveEntry('s',edited,before);docs.set(path+'/lore/deleted',{...entry,id:'deleted'});await store.rollbackRecords('s',{expectedRevision:2});assert.equal(docs.get(path).loreSchemaVersion,2);assert.equal(docs.get(path).loreGeneration,null);assert.equal(docs.get(path+'/lore/mira').sections.notes.lines[0].text,'Later event.');assert.equal(docs.has(path+'/lore/deleted'),false);
});
test('backup restore on a migrated story uses canonical writes and retains restored sources',async()=>{
 const {store,entry}=await setup();await store.migrateRecords('s',[entry],{expectedRevision:0});const before=(await store.getLore('s'))[0],backup=await store.writeBackup('s','test','Original',[before]),edited=structuredClone(before);edited.sections.notes.text='Changed';await store.saveEntry('s',edited,before);await store.restoreBackup('s',backup);assert.equal((await store.getLore('s'))[0].sections.notes.text,entry.sections.notes.text);
});
test('copying a migrated story preserves records and creates a generation header for cleanup',async()=>{
 const {store,docs,path,entry}=await setup();await store.migrateRecords('s',[entry],{expectedRevision:0});docs.set('users/u/sessions/copy',{loreRevision:0,loreSchemaVersion:3,loreGeneration:'copy-gen'});await store.copyLore('s','copy',100);assert.equal((await store.getLore('copy'))[0].sections.notes.text,entry.sections.notes.text);assert.equal(docs.get('users/u/sessions/copy/loreV3/copy-gen').state,'active');
 await store.deleteRecordGenerations('copy');assert.equal([...docs.keys()].some(k=>k.startsWith('users/u/sessions/copy/loreV3/')),false);
});
