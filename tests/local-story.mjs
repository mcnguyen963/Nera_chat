import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const tick=()=>new Promise(r=>setImmediate(r));
const base=()=>({session:{id:'s',historyRevision:0,nextOrder:2,nextNarratorTurn:2},messages:[{id:'u',role:'user',order:1,content:'Go',revision:0,narratorTurn:1},{id:'a',role:'assistant',order:2,content:'Here',revision:0,narratorTurn:1}],turns:{}});
const op=(id,kind,payload)=>({id,kind,payload,createdAt:123});
async function setup(commit=async()=>({}),extra={}){const api=await appHarness()('story-queue.js');const journal=[];const storage={put:async(_u,_s,op,base)=>{journal.push({op:structuredClone(op),base:structuredClone(base)});return true;},ack:async(_u,_s,id)=>{const i=journal.findIndex(x=>x.op.id===id);journal.splice(i,1);return true;}};const events=[];const q=api.createStoryQueue({owner:'u',sid:'s',base:base(),storage,currentOwner:()=> 'u',commit,onChange:(v,s)=>events.push([v,s]),...extra});return {q,journal,events};}
test('Local edit and delete update synchronously while Firebase is hung; next generation sees the edit',async()=>{let finish;const {q,journal}=await setup(()=>new Promise(r=>finish=r));q.enqueue(op('edit','edit',{id:'a',content:'Corrected',expectedRevision:0}));assert.equal(q.view.messages[1].content,'Corrected');q.enqueue(op('user','add',{id:'next',message:{role:'user',content:'Continue from correction'}}));assert.equal(q.view.messages.at(-1).order,3);assert.equal(q.view.messages[1].content,'Corrected');q.enqueue(op('delete','delete',{id:'u'}));assert.ok(!q.view.messages.some(m=>m.id==='u'));await q.settled();assert.equal(journal.length,3);q.close();finish({});await tick();});
test('Queue commits in strict order and rebases confirmed metadata without losing newer local content',async()=>{const pending=[],calls=[];const {q}=await setup((o,b)=>{calls.push([o.id,b.session.historyRevision]);return new Promise(r=>pending.push(r));});q.enqueue(op('1','edit',{id:'a',content:'one',expectedRevision:0}));q.enqueue(op('2','edit',{id:'a',content:'two',expectedRevision:1}));await tick();assert.deepEqual(calls,[['1',0]]);pending.shift()({});await tick();assert.equal(q.view.messages[1].content,'two');assert.deepEqual(calls,[['1',0],['2',1]]);pending.shift()({});await q.flush();assert.equal(q.status.pending,0);assert.equal(q.confirmed.messages[1].content,'two');});
test('Recovery reconstructs queued work and replays exactly once with stable operation IDs',async()=>{const pending=[op('stable','edit',{id:'a',content:'Recovered',expectedRevision:0})],receipts=new Map(),calls=[];const {q}=await setup(async o=>{calls.push(o.id);if(!receipts.has(o.id))receipts.set(o.id,{});return receipts.get(o.id);},{operations:pending});assert.equal(q.view.messages[1].content,'Recovered');await q.flush();assert.deepEqual(calls,['stable']);assert.equal(receipts.size,1);});
test('Permanent failure retains local work and pauses dependent saves until explicit retry',async()=>{let fail=true,calls=0;const {q}=await setup(async()=>{calls++;if(fail)throw Object.assign(Error('Denied'),{code:'permission-denied'});return {};});q.enqueue(op('1','edit',{id:'a',content:'kept'}));q.enqueue(op('2','add',{id:'u2',message:{role:'user',content:'Next'}}));await tick();assert.equal(calls,1);assert.equal(q.status.pending,2);assert.equal(q.view.messages[1].content,'kept');await assert.rejects(q.flush(),/Denied/);fail=false;await q.flush();assert.equal(q.status.pending,0);});
test('Transient failures back off without losing the operation and replay receipt after lost acknowledgement',async()=>{const timers=[],receipts=new Map();let effects=0,calls=0;const {q}=await setup(async o=>{calls++;if(receipts.has(o.id))return receipts.get(o.id);effects++;receipts.set(o.id,{});throw Object.assign(Error('Lost ack'),{code:'unavailable'});},{schedule:fn=>{timers.push(fn);return 1;},cancel:()=>{}});q.enqueue(op('stable','delete',{id:'u'}));await tick();assert.equal(q.status.pending,1);assert.equal(timers.length,1);timers.shift()();await tick();assert.equal(q.status.pending,0);assert.equal(effects,1);assert.equal(calls,2);});
test('A queue never starts another write for a changed account',async()=>{let owner='u',calls=0,finish;const {q}=await setup(()=>{calls++;return new Promise(r=>finish=r);},{currentOwner:()=>owner});q.enqueue(op('1','edit',{id:'a',content:'one'}));q.enqueue(op('2','edit',{id:'a',content:'two'}));await tick();owner='other';finish({});await tick();assert.equal(calls,1);assert.equal(q.status.pending,1);assert.throws(()=>q.enqueue(op('3','delete',{id:'u'})),/Account changed/);});
test('Storage failure retains in-memory changes and reports loss of durability',async()=>{const {q}=await setup(async()=>new Promise(()=>{}),{storage:{put:async()=>false,ack:async()=>false}});q.enqueue(op('1','edit',{id:'a',content:'Local'}));await q.settled();assert.equal(q.status.durable,false);assert.equal(q.view.messages[1].content,'Local');q.close();});
test('Refresh/adoption cannot overwrite pending local work',async()=>{const {q}=await setup(()=>new Promise(()=>{}));q.enqueue(op('1','delete',{id:'u'}));assert.throws(()=>q.adopt(base()),/Sync pending/);q.close();});
test('A turn checkpoint confirms its own operations without waiting for a later turn',async()=>{
 const finishes=[];const {q}=await setup(()=>new Promise(resolve=>finishes.push(resolve)));
 q.enqueue(op('turn1','edit',{id:'a',content:'First turn'}));const checkpoint=q.checkpoint();
 q.enqueue(op('turn2','edit',{id:'a',content:'Later turn'}));await tick();finishes.shift()({});
 assert.equal(await checkpoint,true);assert.equal(q.status.pending,1);assert.equal(q.status.synced,false);
 await tick();finishes.shift()({});await q.flush();assert.equal(q.status.synced,true);
});
test('Sync pause settles an underway write and blocks retries and dependent writes until replacement',async()=>{
 let finish,writes=0;const {q}=await setup(()=>{writes++;return new Promise(resolve=>finish=resolve);});
 q.enqueue(op('first','edit',{id:'a',content:'First'}));q.enqueue(op('dependent','edit',{id:'a',content:'Dependent'}));
 const checkpoint=q.checkpoint();await tick();const pause=q.pause();assert.equal(await checkpoint,false);
 assert.throws(()=>q.enqueue(op('extra','delete',{id:'u'})),/Sync/);q.retry();finish({});await pause;
 assert.equal(writes,1);assert.equal(q.status.pending,1);
 q.adopt(base(),{discardPending:true,serverConfirmed:true});q.resume();await tick();
 assert.equal(writes,1);assert.equal(q.status.pending,0);assert.equal(q.status.synced,true);
});
test('A failed checkpoint retains the complete local turn and reconnection retries persistence only',async()=>{
 let offline=true,writes=0;const {q}=await setup(async()=>{writes++;if(offline)throw Object.assign(Error('Offline'),{code:'permission-denied'});return {};});
 q.enqueue(op('user','add',{id:'u2',message:{role:'user',content:'Action'}}));q.enqueue(op('reply','add',{id:'a2',message:{role:'assistant',content:'Reply'}}));
 await assert.rejects(q.checkpoint(),/Offline/);assert.equal(q.status.pending,2);assert.equal(q.view.messages.at(-1).content,'Reply');
 offline=false;q.retry();assert.equal(await q.checkpoint(),true);assert.equal(q.status.pending,0);assert.equal(writes,3);
});
test('An operation queued during acknowledgement is journaled before its transport starts',async()=>{
 let acknowledge,persist;const calls=[];
 const storage={put:async(_u,_s,o)=>{if(o.id==='2')await new Promise(resolve=>persist=resolve);return true;},ack:async(_u,_s,id)=>{if(id==='1')await new Promise(resolve=>acknowledge=resolve);return true;}};
 const {q}=await setup(async o=>{calls.push(o.id);return {};},{storage});
 q.enqueue(op('1','edit',{id:'a',content:'one'}));await tick();assert.ok(acknowledge);
 q.enqueue(op('2','edit',{id:'a',content:'two'}));acknowledge();await tick();
 assert.ok(persist);assert.deepEqual(calls,['1']);persist();await q.flush();assert.deepEqual(calls,['1','2']);
});
test('Summary retirement, fallback and memory invalidation agree with historical edit semantics',async()=>{const {applyStoryOperation}=await appHarness()('local-story.js');const b=base();b.session={...b.session,activeSummaryMessageId:'sum2',breakpointOrder:8,memoryState:{extractedThroughOrder:8}};b.messages=[...b.messages,{id:'old',role:'summary',content:'old',order:4,coveredRange:{toOrder:1}},{id:'sum2',role:'summary',content:'new',order:10,coveredRange:{toOrder:8}}];const v=applyStoryOperation(b,op('1','edit',{id:'a',content:'changed'}));assert.equal(v.session.activeSummaryMessageId,'old');assert.equal(v.session.breakpointOrder,1);assert.equal(v.messages.find(m=>m.id==='sum2').retired,true);assert.equal(v.session.memoryState.needsRebuild,true);assert.equal(v.session.memoryInvalidations[0].fromOrder,2);});
test('Director pending contract is reusable after cancellation, superseded for new user input, and completes only with narration',async()=>{const {applyStoryOperation}=await appHarness()('local-story.js');const b=base();b.session.directorState={scene:{location:'Inn'}};const turn={id:'d',before:b.session.directorState,after:{scene:{location:'Hall'}},previousCheckpoint:null};let v=applyStoryOperation(b,op('d','director',{turn}));assert.equal(v.session.directorPending,'d');assert.equal(v.session.directorState.scene.location,'Inn');const retry=v.turns.d;assert.equal(retry.status,'pending');v=applyStoryOperation(v,op('a2','add',{id:'a2',message:{role:'assistant',content:'Arrive',directorTurnId:'d'}}));assert.equal(v.session.directorState.scene.location,'Hall');assert.equal(v.session.directorPending,null);assert.equal(v.turns.d.status,'completed');v=applyStoryOperation(v,op('d2','director',{turn:{...turn,id:'d2'}}));v=applyStoryOperation(v,op('discard','discardDirector',{}));assert.equal(v.turns.d2.status,'discarded');assert.equal(v.session.directorPending,null);v=applyStoryOperation(v,op('u2','add',{id:'u2',message:{role:'user',content:'Different'}}));assert.equal(v.messages.at(-1).id,'u2');});
test('Historical Director edits require review; deleting the last completed reply restores prior state',async()=>{const {applyStoryOperation}=await appHarness()('local-story.js');const b=base();b.session.directorState={scene:{location:'Hall'}};b.session.directorCheckpoint='d';b.messages[1].directorTurnId='d';b.turns.d={id:'d',before:{scene:{location:'Inn'}},after:b.session.directorState,previousCheckpoint:null,status:'completed',assistantId:'a'};const edited=applyStoryOperation(b,op('edit','edit',{id:'u',content:'Changed'}));assert.equal(edited.session.directorNeedsReview,true);const deleted=applyStoryOperation(b,op('delete','delete',{id:'a'}));assert.equal(deleted.session.directorState.scene.location,'Inn');assert.equal(deleted.session.directorCheckpoint,null);assert.equal(deleted.session.nextNarratorTurn,1);});

test('A failed Sync resumes network retry backoff without discarding local messages',async()=>{
 let offline=true;const timers=[];
 const {q}=await setup(async()=>{if(offline)throw Object.assign(Error('Offline'),{code:'unavailable'});return {};},{schedule:fn=>{timers.push(fn);return timers.length;},cancel:()=>{}});
 q.enqueue(op('local','add',{id:'local',message:{role:'user',content:'Keep this'}}));await tick();
 await q.pause();await assert.rejects(q.flush({whilePaused:true}),/Offline/);q.resume();
 assert.equal(q.status.pending,1);assert.equal(q.status.error,null);assert.equal(timers.length,2);
 offline=false;timers.at(-1)();assert.equal(await q.checkpoint(),true);assert.equal(q.status.pending,0);
});

test('A stale local receipt allows admissions and does not restore a persisted refresh lock',async()=>{
 const data=new Map([['s',{requiresReconciliation:true}]]),writes=[],stubs={
  'auth.js':{currentUid:()=> 'u'},'messages.js':{restoreMessageChunkCache:async()=>{},deleteMessage:async()=>({})},
  'chat-cache.js':{loadStoryData:async(_u,sid)=>structuredClone(data.get(sid) ?? null),saveStoryData:async(_u,sid,value)=>{writes.push(value);data.set(sid,{...data.get(sid),...structuredClone(value)});return true;},storyQueueStorage:{load:async()=>null,put:async()=>true,ack:async()=>true}},
 };
 const api=await appHarness({stubs})('local-story-store.js'),store=await api.openStoryStore('s',base(),()=>{});
 assert.equal(store.requiresReconciliation,false);
 store.invalidate();assert.equal(store.requiresReconciliation,true);
 assert.doesNotThrow(()=>store.enqueue('delete',{id:'u'}));await store.flush();
 store.adopt(base());await tick();api.forgetStoryStore('s');
 const reopened=await api.openStoryStore('s',base(),()=>{});assert.equal(reopened.requiresReconciliation,false);
 assert.ok(writes.every(value=>!Object.hasOwn(value,'requiresReconciliation')));
});
