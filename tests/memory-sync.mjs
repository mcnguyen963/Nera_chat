import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(hooks={}){
 const events=[],patches=[],providers=[],commits=[],failures=[],writes=[];let owner='u';
 const messages=[{id:'u1',role:'user',content:'Begin',order:1},{id:'a1',role:'assistant',content:'Reply',order:2}];
 const range={messages,endOrder:2,fromTurn:1,toTurn:1};
 const live={storyEpoch:1,session:{id:'s',historyRevision:0,loreRevision:0,memory:{autoUpdate:true},memoryState:{extractedThroughOrder:0}},messages,entries:[],settings:{}};
 const action=async(kind,args,fallback)=>{writes.push({kind,owner,args});return hooks[kind] ? hooks[kind](...args) : fallback;};
 const use=appHarness({globals:{document:{dispatchEvent:e=>events.push(e.detail)},CustomEvent:class{constructor(_type,{detail}){this.detail=detail;}}},stubs:{
  'auth.js':{currentUid:()=>{if(owner===null)throw Error('Not signed in');return owner;}},'sessions.js':{updateSession:async(...args)=>action('reset',args)},
  'turns.js':{dueRange:()=>live.session.memoryState.extractedThroughOrder>=2 ? null : range,alongsideTurnRange:()=>range},'continuity.js':{requestSource:()=>({}),usableLore:entries=>({entries}),effectivelyPaused:()=>false,StaleSourceError:class extends Error{},SupersededError:class extends Error{},assertExtractionSource(){}},
  'lore-lines.js':{parseMemoryLines:()=>({valid:true,ops:[],skipped:[]}),applyOps:()=>({entries:[],appends:[],creates:[],skipped:[]})},
  'memory-prompts.js':{buildExtractionMessages:async()=>({range,messages:[]})},'tokenizer.js':{countTokens:async()=>1},
  'llm-client.js':{chatCompletion:async()=>{const p=deferred();providers.push(p);return p.promise;}},
  'lore-store.js':{markGeneratedForReview:async(...args)=>action('mark',args,[]),commitExtraction:async()=>{const c=deferred();commits.push(c);return c.promise;}},
  'session-memory.js':{clearMemoryInvalidations:async(...args)=>action('clear',args,{memoryInvalidations:[],memoryState:{extractedThroughOrder:0}}),recordMemoryFailure:async()=>{const f=deferred();failures.push(f);return f.promise;}},
 }});
 const updater=await use('memory-updater.js');updater.configureMemoryUpdater({get:()=>live,busy:()=>false,prepare:hooks.prepare ?? (async()=>{}),waitIdle:async()=>{},patch:(_sid,...args)=>{patches.push(args);Object.assign(live.session.memoryState,args[0]);}});
 return {updater,events,patches,providers,commits,failures,writes,live,switchOwner:(next='other')=>owner=next};
}
test('Sync cancellation detaches an unresponsive memory provider and ignores its late success without clearing a newer job',async()=>{
 const h=await fixture(),first=h.updater.updateNow('s');await tick();assert.equal(h.providers.length,1);
 await h.updater.stopAndWait('s');assert.equal(h.updater.isRunning('s'),false);
 const second=h.updater.updateNow('s');await tick();assert.equal(h.providers.length,2);const eventCount=h.events.length;
 h.providers[0].resolve({content:'Old notes'});assert.equal(await first,false);assert.equal(h.updater.isRunning('s'),true);
 assert.equal(h.events.length,eventCount);assert.equal(h.commits.length,0);assert.equal(h.updater.lastRawAnswer('s'),'');
 h.providers[1].resolve({content:'Fresh notes'});await tick();h.commits[0].resolve({entries:[],loreRevision:1});assert.equal(await second,true);assert.equal(h.patches.length,1);
});
for(const phase of ['extraction','failure'])test('Sync cancellation waits for an underway memory '+phase+' write and suppresses late patches',async()=>{
 const h=await fixture(),job=h.updater.updateNow('s');await tick();
 if(phase==='failure')h.providers[0].reject(Error('Provider failed'));else h.providers[0].resolve({content:'Notes'});
 await tick();assert.equal((phase==='failure'?h.failures:h.commits).length,1);
 let finished=false;const stopped=h.updater.stopAndWait('s').then(()=>finished=true);await tick();assert.equal(finished,false);
 (phase==='failure'?h.failures:h.commits)[0].resolve({entries:[],failureStreak:1});await stopped;assert.equal(await job,false);
 assert.equal(h.patches.length,0);assert.equal(h.events.some(e=>e.status==='success' || e.status==='failed'),false);assert.equal(h.updater.isRunning('s'),false);
});
test('memory completion from a previous account cannot patch the active account',async()=>{
 const h=await fixture(),job=h.updater.updateNow('s');await tick();h.providers[0].resolve({content:'Notes'});await tick();h.switchOwner();h.commits[0].resolve({entries:[]});assert.equal(await job,false);assert.equal(h.patches.length,0);
});

const manualActions={
 update:h=>h.updater.updateNow('s',{retry:true}),
 rebuild:h=>h.updater.rebuild('s'),
 rebuildFrom:h=>h.updater.rebuildFrom('s',1),
 catchUp:h=>h.updater.catchUp('s'),
};
for(const [action,run] of Object.entries(manualActions))for(const change of ['account','sign-out','epoch','story'])test('manual '+action+' rejects '+change+' after successful preparation before any side effect',async()=>{
 const prepared=deferred(),h=await fixture({prepare:()=>prepared.promise});
 const pending=run(h);prepared.resolve();
 if(change==='account')h.switchOwner();
 if(change==='sign-out')h.switchOwner(null);
 if(change==='epoch')h.live.storyEpoch++;
 if(change==='story')h.live.session.id='another-story';
 await assert.rejects(pending,/Account or story changed/);
 assert.equal(h.providers.length,0);assert.equal(h.commits.length,0);assert.equal(h.failures.length,0);
 assert.equal(h.writes.length,0);assert.equal(h.patches.length,0);assert.equal(h.updater.isRunning('s'),false);
});
for(const action of ['rebuild','rebuildFrom'])for(const phase of ['mark','clear'])test(action+' stops after '+phase+' completes under a changed account',async()=>{
 const held=deferred(),h=await fixture({[phase]:()=>held.promise});const pending=manualActions[action](h);await tick();
 assert.ok(h.writes.some(w=>w.kind===phase));h.switchOwner();held.resolve(phase==='mark'?[]:{memoryInvalidations:[],memoryState:{extractedThroughOrder:0}});
 await assert.rejects(pending,/Account or story changed/);
 assert.ok(h.writes.every(w=>w.owner==='u'));assert.equal(h.writes.length,phase==='mark'?1:2);
 assert.equal(h.patches.length,0);assert.equal(h.providers.length,0);assert.equal(h.failures.length,0);
});
test('retry reset cannot patch or start a request for the next account',async()=>{
 const reset=deferred(),h=await fixture({reset:()=>reset.promise});const pending=manualActions.update(h);await tick();
 assert.equal(h.writes.length,1);assert.equal(h.writes[0].owner,'u');h.switchOwner();reset.resolve();
 await assert.rejects(pending,/Account or story changed/);assert.equal(h.patches.length,0);assert.equal(h.providers.length,0);
});
test('catch up rechecks its initiating owner after a progress callback',async()=>{
 const h=await fixture();await assert.rejects(h.updater.catchUp('s',{onProgress:()=>h.switchOwner()}),/Account or story changed/);
 assert.equal(h.providers.length,0);assert.equal(h.writes.length,0);assert.equal(h.failures.length,0);
});
test('manual preparation cannot reset a newer running job',async()=>{
 const gate=deferred();let prepares=0;const h=await fixture({prepare:()=>++prepares===1?gate.promise:Promise.resolve()});
 const older=h.updater.updateNow('s',{retry:true}),newer=h.updater.updateNow('s');await tick();assert.equal(h.providers.length,1);
 gate.resolve();assert.equal(await older,false);assert.equal(h.writes.length,0);assert.equal(h.updater.isRunning('s'),true);
 h.providers[0].resolve({content:'NONE'});await tick();h.commits[0].resolve({entries:[]});assert.equal(await newer,true);
});
test('same-owner catch up completes a batch and advances its checkpoint normally',async()=>{
 const h=await fixture(),pending=h.updater.catchUp('s');await tick();assert.equal(h.providers.length,1);
 h.providers[0].resolve({content:'NONE'});await tick();h.commits[0].resolve({entries:[]});assert.equal(await pending,true);
 assert.equal(h.live.session.memoryState.extractedThroughOrder,2);assert.equal(h.commits.length,1);
});
test('manual work completing after a story change cannot commit into the active story',async()=>{
 const h=await fixture(),pending=h.updater.updateNow('s');await tick();h.live.session.id='another-story';h.providers[0].resolve({content:'NONE'});
 assert.equal(await pending,false);assert.equal(h.commits.length,0);assert.equal(h.patches.length,0);assert.equal(h.failures.length,0);
});

test('an in-flight memory update safely detaches when the auth helper throws after sign-out',async()=>{
 const h=await fixture(),pending=h.updater.updateNow('s');await tick();h.switchOwner(null);h.providers[0].resolve({content:'NONE'});
 assert.equal(await pending,false);assert.equal(h.commits.length,0);assert.equal(h.patches.length,0);assert.equal(h.failures.length,0);assert.equal(h.updater.isRunning('s'),false);
});
