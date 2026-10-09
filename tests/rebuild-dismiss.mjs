import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
for(const concurrent of [false,true])test(`F16 dismiss preserves extraction state and ${concurrent?'new invalidations':'clears observed invalidations'}`,async()=>{
 const data={memoryInvalidations:[{revision:4,fromOrder:1},...(concurrent?[{revision:6,fromOrder:30}]:[])],memoryState:{extractedThroughOrder:400,paused:true,failureStreak:2,needsRebuild:true,rebuildFromOrder:1}};
 const before=structuredClone(data.memoryState);
 const api=await appHarness({stubs:{'db.js':{db:{}},'auth.js':{currentUid:()=> 'owner'},'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js':{
  doc:(...parts)=>parts,increment:n=>n,serverTimestamp:()=>1,runTransaction:async(db,run)=>{const writes=[];const result=await run({get:async()=>({exists:()=>true,data:()=>structuredClone(data)}),update:(_ref,patch)=>writes.push(patch)});for(const patch of writes)for(const [key,value]of Object.entries(patch)){if(key.startsWith('memoryState.'))data.memoryState[key.slice(12)]=value;else data[key]=value;}return result;}
 }}})('session-memory.js');
 await api.dismissRebuild('story',5);
 assert.equal(data.memoryState.needsRebuild,concurrent);assert.equal(data.memoryState.rebuildFromOrder,concurrent?30:null);
 assert.equal(data.memoryInvalidations.length,concurrent?1:0);
 for(const key of ['extractedThroughOrder','paused','failureStreak'])assert.equal(data.memoryState[key],before[key]);
});
test('F16 rebuild banner estimates turns and calls from configured batch size',async()=>{
 const {rebuildLabel}=await appHarness()('memory-rebuild.js');
 const messages=Array.from({length:12},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'x'}));
 assert.equal(rebuildLabel({session:{memory:{batchTurns:2,lagTurns:1},memoryState:{rebuildFromOrder:1}},messages}),'History edited at T1 — re-extract 5 turns (~3 extraction calls)');
});
