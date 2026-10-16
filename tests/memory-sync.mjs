import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function fixture(){
 const events=[],patches=[],providers=[],commits=[],failures=[];let owner='u';
 const messages=[{id:'u1',role:'user',content:'Begin',order:1},{id:'a1',role:'assistant',content:'Reply',order:2}];
 const range={messages,endOrder:2,fromTurn:1,toTurn:1};
 const live={session:{id:'s',historyRevision:0,loreRevision:0,memory:{autoUpdate:true},memoryState:{extractedThroughOrder:0}},messages,entries:[],settings:{}};
 const use=appHarness({globals:{document:{dispatchEvent:e=>events.push(e.detail)},CustomEvent:class{constructor(_type,{detail}){this.detail=detail;}}},stubs:{
  'auth.js':{currentUid:()=>owner},'sessions.js':{updateSession:async()=>{}},
  'turns.js':{dueRange:()=>range},'continuity.js':{requestSource:()=>({}),usableLore:entries=>({entries}),effectivelyPaused:()=>false,StaleSourceError:class extends Error{},SupersededError:class extends Error{},assertExtractionSource(){}},
  'lore-lines.js':{parseMemoryLines:()=>({valid:true,ops:[],skipped:[]}),applyOps:()=>({entries:[],appends:[],creates:[],skipped:[]})},
  'memory-prompts.js':{buildExtractionMessages:async()=>({range,messages:[]})},'tokenizer.js':{countTokens:async()=>1},
  'llm-client.js':{chatCompletion:async()=>{const p=deferred();providers.push(p);return p.promise;}},
  'lore-store.js':{markGeneratedForReview:async()=>[],commitExtraction:async()=>{const c=deferred();commits.push(c);return c.promise;}},
  'session-memory.js':{clearMemoryInvalidations:async()=>{},recordMemoryFailure:async()=>{const f=deferred();failures.push(f);return f.promise;}},
 }});
 const updater=await use('memory-updater.js');updater.configureMemoryUpdater({get:()=>live,busy:()=>false,prepare:async()=>{},waitIdle:async()=>{},patch:(_sid,...args)=>patches.push(args)});
 return {updater,events,patches,providers,commits,failures,switchOwner:()=>owner='other'};
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
