import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const FIRESTORE='https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
const planFixture=l=>{const e=l.makeEntry('plan','Festival',{schedule:{start:'1/10/738',end:'20/10/738',status:'pending',phases:[{id:'intro',title:'Introduction',start:'1/10/738',end:'5/10/738',text:'Introduce A, B, C.',status:'pending'}]}});e.id='festival';e.sections.text.text='Shared festival goals.';return e;};
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
 runTransaction:async(_db,action)=>{const writes=[];const result=await action({get:async r=>{assert.equal(writes.length,0,'all native reads before writes');return snap(r);},set:(...args)=>writes.push(['set',...args]),update:(...args)=>writes.push(['update',...args]),delete:(...args)=>writes.push(['delete',...args])});if(control.failRollback&&writes.some(([m,r])=>m==='set'&&r.path.includes('/lore/')))throw Error('rollback interrupted');if(control.failStage&&writes.some(([m,r])=>m==='set'&&r.path.includes('/entries/')))throw Error('stage failed');if(control.failActivation&&writes.some(([,r,d])=>r.path===path&&d?.loreSchemaVersion===3))throw Error('activation failed');for(const w of writes)apply(...w);return result;},
 writeBatch:()=>{const writes=[];return {set:(...args)=>writes.push(['set',...args]),delete:(...args)=>writes.push(['delete',...args]),commit:async()=>{for(const w of writes)apply(...w);}};}};
 const use=appHarness({stubs:{[FIRESTORE]:firestore,'db.js':{db:{}},'auth.js':{currentUid:()=>control.uid},'messages.js':{getMessages:async()=>[]}}}),store=await use('lore-store.js'),l=await use('lore-lines.js'),records=await use('lore-records.js');
 const e=l.makeEntry('characters','Mira');e.id='mira';e.sections.notes.text='Obedient, not affectionate.';docs.set(path+'/lore/mira',structuredClone(e));
 return {use,store,l,records,docs,control,path,entry:e,firestore};
}
test('migration stages canonical sources and records before atomically activating a generation',async()=>{
 const {store,docs,path,entry}=await setup();const result=await store.migrateRecords('s',[entry],{expectedRevision:0});const session=docs.get(path);assert.equal(session.loreGeneration,result.generation);assert.equal(session.loreSchemaVersion,3);assert.equal(session.loreRevision,1);assert.equal(docs.get(path+'/lore/mira').sections.notes.text,entry.sections.notes.text);
 const active=docs.get(path+'/loreV3/'+result.generation+'/entries/mira');assert.equal(active.schemaVersion,3);assert.equal(active.sections,undefined);assert.ok(active.sources.length);assert.ok(active.records.length);assert.equal((await store.getLore('s'))[0].sections.notes.text,entry.sections.notes.text);
});
for(const migrated of [false,true])test(`scheduled plans persist completion and copy independently in ${migrated?'record':'legacy'} storage`,async()=>{
 const h=await setup(),e=planFixture(h.l);await h.store.createEntry('s',e);
 if(migrated)await h.store.migrateRecords('s',await h.store.getLore('s'),{expectedRevision:1});
 const base=(await h.store.getLore('s')).find(x=>x.id===e.id),edited=structuredClone(base);edited.schedule.phases[0].status='completed';await h.store.saveEntry('s',edited,base);
 const saved=(await h.store.getLore('s')).find(x=>x.id===e.id);assert.equal(saved.schedule.phases[0].status,'completed');
 h.docs.set('users/u/sessions/dst',migrated?{loreSchemaVersion:3,loreGeneration:'dst-generation',loreRevision:0}:{loreRevision:0});await h.store.copyLore('s','dst',0);
 const copy=(await h.store.getLore('dst')).find(x=>x.id===e.id);assert.equal(JSON.stringify(copy.schedule),JSON.stringify(saved.schedule));
 const next=structuredClone(saved);next.schedule.status='completed';await h.store.saveEntry('s',next,saved);assert.equal((await h.store.getLore('dst')).find(x=>x.id===e.id).schedule.status,'pending');
});
test('concurrent phase changes reject stale edits without losing author completion',async()=>{
 const h=await setup(),e=planFixture(h.l);await h.store.createEntry('s',e);const base=(await h.store.getLore('s')).find(x=>x.id===e.id),mine=structuredClone(base),other=structuredClone(base);
 mine.schedule.phases[0].text='My revised instructions.';other.schedule.phases[0].status='completed';await h.store.saveEntry('s',other,base);await assert.rejects(()=>h.store.saveEntry('s',mine,base),/phases changed/);assert.equal((await h.store.getLore('s')).find(x=>x.id===e.id).schedule.phases[0].status,'completed');
 const staleOverview=structuredClone(base);staleOverview.sections.text.text='Revised overview.';await h.store.saveEntry('s',staleOverview,base);const saved=(await h.store.getLore('s')).find(x=>x.id===e.id);assert.equal(saved.schedule.phases[0].status,'completed');assert.equal(saved.sections.text.text,'Revised overview.');
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

test('interrupted rollback keeps the active canonical generation and newer notes recoverable',async()=>{
 const {store,docs,path,entry,control}=await setup();await store.migrateRecords('s',[entry],{expectedRevision:0});const generation=docs.get(path).loreGeneration;
 const before=(await store.getLore('s'))[0],edited=structuredClone(before);edited.sections.notes.lines.push({id:'after-migration',text:'Keep this newer note.',by:'user',turn:2,at:2});await store.saveEntry('s',edited,before);
 control.failRollback=true;await assert.rejects(()=>store.rollbackRecords('s',{expectedRevision:2}),/interrupted/);assert.equal(docs.get(path).loreGeneration,generation);assert.equal(docs.get(path).loreMigration.active,false);assert.equal((await store.getLore('s'))[0].sections.notes.lines[0].text,'Keep this newer note.');
 control.failRollback=false;await store.rollbackRecords('s',{expectedRevision:2});assert.equal(docs.get(path).loreSchemaVersion,2);assert.equal((await store.getLore('s'))[0].sections.notes.lines[0].text,'Keep this newer note.');
});
test('version 3 imports require explicit migration before writing legacy cards',async()=>{
 const {store,docs,path,records,entry}=await setup();const data=records.reconcileRecords(entry),before=JSON.stringify([...docs]);
 await assert.rejects(()=>store.importLore('s',{writes:[{id:data.id,data}]},[]),/Migrate this story/);assert.equal(JSON.stringify([...docs]),before);
});

test('extracted notes commit to canonical storage and become selectable in the next real request',async()=>{
 const {use,store,l,records,docs,path,entry}=await setup();await store.migrateRecords('s',[entry],{expectedRevision:0});
 const messages=[{id:'u1',role:'user',order:1,revision:0,content:'Continue.'},{id:'a1',role:'assistant',order:2,revision:0,content:'Mira locked the letter in the blue chest.'}],range={fromTurn:1,toTurn:1,endOrder:2,assistants:[{id:'a1',turn:1,order:2}],messages};
 const {normalizeMemory}=await use('memory-settings.js'),mem=normalizeMemory({lorebooks:true,protagonist:'Mira'}),session={...docs.get(path),id:'s',memory:mem},before=await store.getLore('s');
 const parsed=l.parseMemoryLines('T1 [char] Mira | status: Locked the letter in the blue chest.',{range,mem,messages}),changes=l.applyOps(before,parsed.ops,{mem,messages,session});assert.equal(parsed.valid,true);
 await store.commitExtraction('s',changes,range);assert.equal(docs.get(path).memoryState.extractedThroughOrder,2);
 const lore=await store.getLore('s');assert.ok(lore[0].recordLayout.records.some(r=>records.resolveRecord(lore[0],r).text.includes('blue chest')));
 const builder=await use('context-builder.js'),built=await builder.buildContextForRequest({...session,...docs.get(path)}, {narratorSystemPrompt:'Narrate.',maxContextTokens:10000,maxResponseTokens:1000,keepRecentMessagesAfterSummary:4},{messages:[...messages,{id:'u2',role:'user',order:3,content:'Where did Mira put the letter?'}],loreEntries:lore});
 const selected=built.report.recordSelection.characters.entries.map(e=>e.text).join('\n');assert.match(selected,/blue chest/);assert.match(built.apiMessages.map(m=>m.content).join('\n'),/blue chest/);
});
