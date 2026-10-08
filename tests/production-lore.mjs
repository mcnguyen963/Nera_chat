import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const URL_FIRESTORE = 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
const card = lines => ({id:'mira',name:'Mira',sections:{notes:{text:'',lines}}});
const note = (id,src) => ({id,src,text:id,by:'auto',at:1});
async function setup(history, entry, { failHistory = false } = {}) {
  const sessionPath = 'users/u/sessions/s', docs = new Map([[sessionPath,{loreRevision:0}],[sessionPath+'/lore/mira',structuredClone(entry)],[sessionPath+'/loreMeta/backups',{groups:[]}]]);
  const counts = {history:0, backups:0, loreWrites:0}; let id=0;
  const ref = (...parts) => ({path:parts.slice(1).join('/')});
  const snapshot = target => ({id:target.path.split('/').at(-1),exists:()=>docs.has(target.path),data:()=>structuredClone(docs.get(target.path))});
  function apply(method,target,value) {
    if(target.path.includes('/loreBackups/'))counts.backups++;
    if(target.path.includes('/lore/'))counts.loreWrites++;
    if(method==='delete') {docs.delete(target.path);return;}
    const data=method==='set' ? {} : structuredClone(docs.get(target.path));
    for(const [key,v] of Object.entries(value)) {const path=key.split('.');let out=data;for(const part of path.slice(0,-1))out=out[part]??={};out[path.at(-1)]=v?.increment ? (out[path.at(-1)]??0)+v.increment : v;}
    docs.set(target.path,data);
  }
  const firestore = {
    doc:ref, collection:ref, getDocFromServer:async target=>snapshot(target), getDocsFromServer:async()=>({docs:[]}),
    setDoc:async(target,value)=>apply('set',target,value), updateDoc:async(target,value)=>apply('update',target,value),deleteDoc:async target=>apply('delete',target),
    onSnapshot(){return ()=>{};}, arrayUnion:(...values)=>values, serverTimestamp:()=>1, Timestamp:class {}, increment:amount=>({increment:amount}),
    runTransaction:async(_db,action)=> {const writes=[];const result=await action({get:async target=>snapshot(target),set:(...args)=>writes.push(['set',...args]),update:(...args)=>writes.push(['update',...args]),delete:(...args)=>writes.push(['delete',...args])});for(const write of writes)apply(...write);return result;},
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
  return {api:module.namespace,docs,counts,sessionPath};
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
