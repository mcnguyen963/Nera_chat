import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const URL_FIRESTORE = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
const card = lines => ({id:'mira',name:'Mira',sections:{notes:{text:'',lines}}});
const note = (id,src) => ({id,src,text:id,by:'auto',at:1});
async function setup(history, entry, { failHistory = false } = {}) {
  const sessionPath = 'users/u/sessions/s', docs = new Map([[sessionPath,{loreRevision:0}],[sessionPath+'/lore/mira',structuredClone(entry)],[sessionPath+'/loreMeta/backups',{groups:[]}]]);
  const counts = {history:0, backups:0, loreWrites:0, loreWriteIds:[]}, controls={failCard:null}; let id=0;
  const ref = (...parts) => ({path:parts.slice(1).join('/')});
  const snapshot = target => ({id:target.path.split('/').at(-1),exists:()=>docs.has(target.path),data:()=>structuredClone(docs.get(target.path))});
  function apply(method,target,value) {
    if(target.path.includes('/loreBackups/'))counts.backups++;
    if(target.path.includes('/lore/')){counts.loreWrites++;counts.loreWriteIds.push(target.path.split('/').at(-1));}
    if(method==='delete') {docs.delete(target.path);return;}
    const data=method==='set' ? {} : structuredClone(docs.get(target.path));
    for(const [key,v] of Object.entries(value)) {const path=key.split('.');let out=data;for(const part of path.slice(0,-1))out=out[part]??={};out[path.at(-1)]=v?.increment ? (out[path.at(-1)]??0)+v.increment : v;}
    docs.set(target.path,data);
  }
  const firestore = {
    doc:ref, collection:ref, getDocFromServer:async target=>snapshot(target), getDocsFromServer:async()=>({docs:[]}),
    setDoc:async(target,value)=>apply('set',target,value), updateDoc:async(target,value)=>apply('update',target,value),deleteDoc:async target=>apply('delete',target),
    onSnapshot(){return ()=>{};}, arrayUnion:(...values)=>values, serverTimestamp:()=>1, Timestamp:class {}, increment:amount=>({increment:amount}),
    runTransaction:async(_db,action)=> {const writes=[];const result=await action({get:async target=>{assert.equal(writes.length,0,'transaction reads precede writes');if(controls.failCard && target.path.endsWith('/lore/'+controls.failCard))throw new Error('offline');return snapshot(target);},set:(...args)=>writes.push(['set',...args]),update:(...args)=>writes.push(['update',...args]),delete:(...args)=>writes.push(['delete',...args])});for(const write of writes)apply(...write);return result;},
    writeBatch:()=>({set(){},delete(){},commit:async()=>{}}),
  };
  const stubs = {
    [URL_FIRESTORE]:firestore,'db.js':{db:{}},'auth.js':{currentUid:()=> 'u'},
    'continuity.js':{assertSource(){},noteNeedsReview(){return false;},sectionMeta(){return {};},assertExtractionSource(){}},
    'lore-lines.js':{newLoreId:()=> 'id'+ ++id, normalizeName:value=>String(value).toLowerCase()},
    'messages.js':{getMessages:async sid=>{assert.equal(sid,'s');counts.history++;if(failHistory)throw new Error('offline');return structuredClone(history);}},
  };
  const context=vm.createContext({console,TextEncoder,structuredClone,Date,Map,Set}), cache=new Map();
  async function load(path) {
    if(cache.has(path))return cache.get(path);
    const pending=(async()=>{const stub=stubs[path];const m=stub ? new vm.SyntheticModule(Object.keys(stub),function(){for(const [k,v]of Object.entries(stub))this.setExport(k,v);},{context,identifier:path}) : new vm.SourceTextModule(await readFile(new URL('../js/'+path,import.meta.url),'utf8'),{context,identifier:path});await m.link((specifier,parent)=>load(specifier.startsWith('https:')?specifier:new URL(specifier,'https://local/'+parent.identifier).pathname.slice(1)));return m;})();cache.set(path,pending);return pending;
  }
  const module=await load('lore-store.js');await module.evaluate();
  return {api:module.namespace,docs,counts,sessionPath,controls};
}

test('D3 removal ignores stale caller orders and preserves old and future notes using full 300-message history',async()=>{
  const history=Array.from({length:300},(_,i)=>({order:i+1})).filter(m=>m.order!==5);
  const entry=card([note('first',1),note('old',4),note('deleted',5),note('future',301),note('manual',null)]);
  const h=await setup(history,entry);
  const backup=await h.api.removeDeletedLines('s',[entry],new Set([299,300]),1);
  assert.equal(h.counts.history,1);
  assert.ok(backup);
  assert.deepEqual(h.docs.get(h.sessionPath+'/lore/mira').sections.notes.lines.map(l=>l.id),['first','old','future','manual']);
});

test('D3 a changed server count requires fresh confirmation before deleting or backing up cards',async()=>{
  const entry=card([note('deleted',5),note('also-deleted',7)]), h=await setup([{order:1},{order:10}],entry);
  const staleUI=card([note('deleted',5)]);
  await assert.rejects(h.api.removeDeletedLines('s',[staleUI],new Set([1,10]),1),error=>error.name==='DeletedNotesChanged' && error.count===2);
  assert.equal(h.counts.backups,0);assert.equal(h.counts.loreWrites,0);
  assert.equal(h.docs.get(h.sessionPath+'/lore/mira').sections.notes.lines.length,2);
});

test('D3 an empty server history cannot prove a source was deleted',async()=>{
  const entry=card([note('old',5)]),h=await setup([],entry);
  assert.equal(await h.api.removeDeletedLines('s',[entry],new Set(),0),null);
  assert.equal(h.counts.loreWrites,0);assert.equal(h.counts.backups,0);
});

test('D3 full-history read failure leaves lore untouched',async()=>{
  const entry=card([note('old',5)]),h=await setup([],entry,{failHistory:true});
  await assert.rejects(h.api.removeDeletedLines('s',[entry],new Set(),1),/offline/);
  assert.equal(h.counts.loreWrites,0);assert.equal(h.counts.backups,0);
});

test('B3 a server-side full card drops only that card and atomically commits other notes and checkpoint',async()=>{
 const full=card([]);full.name='Mira';full.sections.notes.text='x'.repeat(899650);
 const h=await setup([],full),before=structuredClone(h.docs.get(h.sessionPath+'/lore/mira'));
 const other={id:'world',name:'World',book:'facts',sections:{text:{text:'',lines:[{id:'other',text:'A valid fact.',by:'auto'}]}}};
 const result=await h.api.commitExtraction('s',{appends:[{entryId:'mira',section:'notes',line:{id:'new',text:'y'.repeat(400),by:'auto'}}],aliases:[],statusChanges:[],creates:[other]},{endOrder:4,fromTurn:1,toTurn:2,skipped:[{reason:'empty or oversized note'}]});
 assert.deepEqual(h.docs.get(h.sessionPath+'/lore/mira'),before);
 assert.equal(h.docs.get(h.sessionPath+'/lore/world').sections.text.lines.length,1);assert.equal(result.notes,1);
 assert.equal(result.skipped[0].card,'Mira');assert.equal(result.skipped[0].reason,'card full');
 const state=h.docs.get(h.sessionPath).memoryState;assert.equal(state.extractedThroughOrder,4);
 assert.equal(state.lastSkipped.length,2);assert.equal(state.lastSkipped[1].card,'Mira');
 assert.deepEqual(JSON.parse(JSON.stringify(result.lastSkipped)),JSON.parse(JSON.stringify(state.lastSkipped)));
 assert.equal(h.counts.loreWrites,1,'no write is made to the full card');
});
test('B3 valid extraction with only a full new card advances without pausing and caps persisted skip reasons',async()=>{
 const h=await setup([],card([]));
 const result=await h.api.commitExtraction('s',{appends:[],aliases:[],statusChanges:[],creates:[{id:'full',name:'Full',sections:{notes:{text:'x'.repeat(900000),lines:[]}}}]},{endOrder:4,fromTurn:1,toTurn:2,skipped:Array.from({length:12},()=>({card:'c'.repeat(200),reason:'r'.repeat(200)}))});
 assert.equal(h.docs.has(h.sessionPath+'/lore/full'),false);assert.equal(result.notes,0);
 const state=h.docs.get(h.sessionPath).memoryState;assert.equal(state.extractedThroughOrder,4);assert.equal(state.failureStreak,0);assert.equal(state.paused,false);
 assert.equal(state.lastSkipped.length,10);assert.ok(state.lastSkipped.every(note=>JSON.stringify(note).length<=200));
 assert.equal(result.skipped[0].reason,'card full');
});

test('F13 unreproduced-note cleanup backs up fresh server cards and skips already-clean cards',async()=>{
  const stale=card([{...note('remove',4),needsReview:true}]),h=await setup([],stale);
  const fresh={...stale,sections:{notes:{text:'Edited on another device',lines:[...stale.sections.notes.lines,note('new',10)]}}};
  h.docs.set(h.sessionPath+'/lore/mira',structuredClone(fresh));
  const clean={id:'clean',name:'Clean',sections:{notes:{text:'Kept',lines:[note('survives',4)]}}};
  h.docs.set(h.sessionPath+'/lore/clean',structuredClone(clean));
  const staleClean={...clean,sections:{notes:{text:'Old',lines:[{...note('survives',4),needsReview:true}]}}};
  const backup=await h.api.removeReviewedLines('s',[stale,staleClean],1,8);
  const saved=await h.api.loadBackupGroup('s',backup);
  assert.equal(saved.length,1);
  assert.equal(saved[0].entries[0].data.sections.notes.text,'Edited on another device');
  assert.deepEqual(saved[0].entries[0].data.sections.notes.lines,fresh.sections.notes.lines);
  assert.deepEqual(h.counts.loreWriteIds,['mira']);
  assert.deepEqual(h.docs.get(h.sessionPath+'/lore/mira').sections.notes.lines.map(l=>l.id),['new']);
});

test('F13 failure on card three leaves two atomic backups and Undo restores only those cards',async()=>{
  const entries=Array.from({length:5},(_,i)=>({id:'c'+(i+1),name:'Card '+(i+1),sections:{notes:{text:'',lines:[{...note('remove',4),needsReview:true}]}}}));
  const h=await setup([],card([]));
  for(const entry of entries)h.docs.set(h.sessionPath+'/lore/'+entry.id,structuredClone(entry));
  h.controls.failCard='c3';
  await assert.rejects(h.api.removeReviewedLines('s',entries,1,8),/Removed notes from 2 of 5 cards\. Undo in Backups restores those 2\./);
  assert.deepEqual(h.counts.loreWriteIds,['c1','c2']);
  for(const [i,entry] of entries.entries())assert.equal(h.docs.get(h.sessionPath+'/lore/'+entry.id).sections.notes.lines.length,i<2 ? 0 : 1);
  const group=h.docs.get(h.sessionPath+'/loreMeta/backups').groups[0];
  assert.equal(group.parts.length,2);assert.equal(new Set(group.parts).size,2);
  h.controls.failCard=null;
  const saved=await h.api.loadBackupGroup('s',group.id);
  assert.deepEqual(Array.from(saved,part=>Array.from(part.entries,entry=>entry.id)).flat(),['c1','c2']);
  const writes=h.counts.loreWriteIds.length;
  await h.api.restoreBackup('s',group.id,entries);
  assert.deepEqual(h.counts.loreWriteIds.slice(writes),['c1','c2']);
  for(const entry of entries)assert.deepEqual({id:entry.id,...h.docs.get(h.sessionPath+'/lore/'+entry.id)},entry);
});

for(const scenario of ['identical','reorganized','later-extraction','created-after-backup'])test(`F14 restore ${scenario} flags only newer lost source orders`,async()=>{
  const restored=card([note('old',3),note('latest',200)]);restored.updatedAt=1;
  let current;
  if(scenario==='identical')current=structuredClone(restored);
  if(scenario==='reorganized')current=card([{...note('new-id',200),text:'Merged original facts.'}]);
  if(scenario==='later-extraction')current=card([...restored.sections.notes.lines,note('later',300),note('newest',310)]);
  if(scenario==='created-after-backup')current=card([note('created',250),note('newest',260)]);
  const h=await setup([],current);
  const id=await h.api.writeBackup('s','test','Saved card',scenario==='created-after-backup' ? [] : [restored],scenario==='created-after-backup' ? ['mira'] : []);
  const session=h.docs.get(h.sessionPath);session.memoryState={lastUpdateAt:Date.now()+1000};h.docs.set(h.sessionPath,session);
  await h.api.restoreBackup('s',id,[]);
  const state=h.docs.get(h.sessionPath).memoryState;
  if(['identical','reorganized'].includes(scenario))assert.equal(state.needsRebuild,undefined);
  else {assert.equal(state.needsRebuild,true);assert.equal(state.rebuildFromOrder,scenario==='later-extraction' ? 300 : 250);}
  if(scenario==='created-after-backup')assert.equal(h.docs.has(h.sessionPath+'/lore/mira'),false);
});

test('E4 restore recognizes Admin SDK JSON timestamps in extraction state',async()=>{
  const restored=card([note('old',3)]);restored.updatedAt=1;
  const h=await setup([],card([note('old',3),note('lost',300)]));
  const id=await h.api.writeBackup('s','test','Saved card',[restored]);
  const session=h.docs.get(h.sessionPath);session.memoryState={lastUpdateAt:{_seconds:100,_nanoseconds:500000000}};h.docs.set(h.sessionPath,session);
  await h.api.restoreBackup('s',id,[]);
  assert.equal(h.docs.get(h.sessionPath).memoryState.rebuildFromOrder,300);
});
