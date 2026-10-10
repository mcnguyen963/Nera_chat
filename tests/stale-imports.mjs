import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {appHarness} from './app-harness.mjs';

const now=1800000000000,hour=60*60*1000;
const source=process.env.F15_BEFORE_SOURCE ? await readFile(process.env.F15_BEFORE_SOURCE,'utf8') : undefined;
async function harness(sessions,{fail=false}={}) {
  let subscriber;const marked=[],removed=[],errors=[],reads=[];
  const docs=sessions.map(data=>({id:data.id,data:()=>data}));
  class Clock extends Date {static now(){return now;}}
  const use=appHarness({sources:source?{'sessions.js':source}:{},globals:{Date:Clock,console:{error:()=>{}}},stubs:{
    'db.js':{db:{}},'auth.js':{currentUid:()=> 'owner'},
    'messages.js':{ensureChunked:async()=>{},ensureContinuityMetadata:async()=>{}},
    'lore-store.js':{copyLore:async()=>{},waitForStoryWrites:async()=>{}},
    'chat-cache.js':{deleteChatCache:async()=>{}},
    'unsaved-replies.js':{loadUnsavedReply:async()=>null,storeUnsavedReply:async()=>{}},
    'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':{
      doc:(_db,...path)=>path.join('/'),collection:(_db,...path)=>path.join('/'),query:path=>path,orderBy:()=>{},serverTimestamp:()=>null,
      getDocs:async()=>({docs}),getDocsFromServer:async path=>{reads.push(path);return {docs:[]};},
      getDoc:async()=>{},getDocFromServer:async()=>({exists:()=>true,data:()=>({deleting:true})}),setDoc:async()=>{},updateDoc:async()=>{},
      deleteDoc:async ref=>removed.push(ref),writeBatch:()=>({delete:()=>{},commit:async()=>{}}),
      runTransaction:async(_db,fn)=>fn({get:async ref=>({exists:()=>true,data:()=>sessions.find(s=>ref.endsWith('/'+s.id))}),update:(ref)=>{marked.push(ref);if(fail)throw new Error('offline');}}),
      onSnapshot:(_q,cb)=>{subscriber=cb;return()=>{};}
    }
  }});
  const api=await use('sessions.js');api.subscribeSessions(()=>{},error=>errors.push(error));
  return {api,marked,removed,errors,reads,snapshot:()=>subscriber({docs,metadata:{fromCache:false}})};
}
async function settle(){for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));}
test('F15 abandons imports older than one day once across repeated sidebar snapshots and listings',async()=>{
  const h=await harness([{id:'abandoned',importing:true,createdAt:{toMillis:()=>now-25*hour}}]);
  h.snapshot();h.snapshot();await h.api.listSessions();await settle();
  assert.deepEqual(h.marked,['users/owner/sessions/abandoned']);
  assert.deepEqual(h.removed,['users/owner/sessions/abandoned']);
  assert.equal(h.reads.length,6);
});
test('F15 preserves recent, pending timestamps and exact 24-hour imports while hiding them',async()=>{
  const h=await harness([{id:'recent',importing:true,createdAt:{seconds:(now-23*hour)/1000}},{id:'pending',importing:true,createdAt:null},{id:'boundary',importing:true,createdAt:{toMillis:()=>now-24*hour}},{id:'old',importing:true,createdAt:{seconds:(now-25*hour)/1000}},{id:'visible',title:'Ready'}]);
  h.snapshot();const result=await h.api.listSessions();await settle();
  assert.deepEqual(h.marked,['users/owner/sessions/old']);assert.deepEqual(Array.from(result,s=>s.id),['visible']);
});
test('F15 handles serialized old server timestamps and reports failed cleanup once',async()=>{
  const h=await harness([{id:'old',importing:true,createdAt:{seconds:(now-25*hour)/1000}}],{fail:true});
  h.snapshot();h.snapshot();await settle();
  assert.equal(h.marked.length,1);assert.equal(h.removed.length,0);assert.equal(h.errors.length,1);assert.equal(h.errors[0].deletionPending,true);
});
