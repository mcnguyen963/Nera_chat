import test from 'node:test';
import assert from 'node:assert/strict';
import {appHarness} from './app-harness.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
async function fixture(){
  const use=appHarness(),{makeEntry}=await use('lore-lines.js');
  let owner='u';const pending=new Map(),events=[],calls=[];
  const live={storyEpoch:1,historyComplete:true,session:{id:'s',loreRevision:1,memory:{semanticLore:true}},messages:[],entries:[makeEntry('characters','Mira',{id:'mira'})]};
  const storage={load:async(o,s)=>pending.get(o+':'+s),save:async(o,s,value,check=()=>{})=>{check();pending.set(o+':'+s,value);return true;}};
  const create=(await use('lore-index-updater.js')).createLoreIndexUpdater;
  const options={getSnapshot:()=>live,ownerNow:()=>owner,storage,onStatus:e=>events.push(e),index:async options=>{const result=deferred();calls.push({options,...result});return result.promise;}};
  return {use,live,pending,events,calls,options,worker:create(options),create,switchOwner:()=>owner='other'};
}
test('lore refresh persists intent, coalesces repeated edits and rejects stale completion',async()=>{
  const h=await fixture(),first=h.worker.request(h.live);await tick();
  assert.equal(h.pending.get('u:s'),true);assert.equal(h.calls.length,1);
  h.live.session.loreRevision=2;const second=h.worker.request(h.live);await tick();
  h.live.session.loreRevision=3;const third=h.worker.request(h.live);await tick();
  assert.equal(h.calls[0].options.signal.aborted,true);assert.throws(h.calls[0].options.check,/resume/);
  h.calls[0].resolve({});await tick();assert.equal(h.calls.length,2);
  h.calls[1].options.check();h.calls[1].resolve({});await Promise.all([first,second,third]);
  assert.equal(h.calls.length,2);assert.equal(h.pending.get('u:s'),false);assert.equal(h.worker.status('u','s'),'success');
});
test('failed lore indexing preserves saved lore and resumes durable intent in a new worker',async()=>{
  const h=await fixture(),job=h.worker.request(h.live);await tick();h.calls[0].reject(Error('Provider offline'));await job;
  assert.equal(h.live.entries[0].name,'Mira');assert.equal(h.pending.get('u:s'),true);assert.equal(h.worker.status('u','s'),'failed');
  const reloaded=h.create(h.options),retry=reloaded.resume(h.live);await tick();assert.equal(h.calls.length,2);
  h.calls[1].resolve({});await retry;assert.equal(h.pending.get('u:s'),false);
});
test('summary checkpoint movement does not cancel an ongoing lore refresh',async()=>{
  const h=await fixture(),job=h.worker.request(h.live);await tick();
  h.live.session.breakpointOrder=100;h.live.session.activeSummaryMessageId='summary';h.live.session.historyRevision=8;
  h.calls[0].options.check();h.calls[0].resolve({});await job;assert.equal(h.pending.get('u:s'),false);
});
test('reopening recovers a save that happened before the durable marker was written',async()=>{
  const h=await fixture(),worker=h.create({...h.options,needsRefresh:async()=>true}),job=worker.resume(h.live);await tick();
  assert.equal(h.calls.length,1);assert.equal(h.pending.get('u:s'),true);h.calls[0].resolve({});await job;
  assert.equal(h.pending.get('u:s'),false);
});
test('stopping an index worker cannot publish its late completion',async()=>{
  const h=await fixture(),job=h.worker.request(h.live);await tick();h.worker.stop('u','s');h.calls[0].resolve({});await job;
  assert.equal(h.worker.status('u','s'),'idle');assert.equal(h.pending.get('u:s'),true);assert.ok(!h.events.some(e=>e.status==='success'));
});
test('account changes and source edits cannot publish a stale lore refresh',async()=>{
  for(const change of ['account','edit']){
    const h=await fixture(),job=h.worker.request(h.live);await tick();
    if(change==='account')h.switchOwner();else h.live.session.contentEdits=[{order:1,revision:9}];
    assert.throws(h.calls[0].options.check);h.calls[0].resolve({});await job;
    assert.equal(h.pending.get('u:s'),true);assert.ok(!h.events.some(e=>e.status==='success'));
  }
});
test('disabled semantic search sends no lore to a provider; incomplete history retains pending work',async()=>{
  const h=await fixture();h.live.session.memory.semanticLore=false;await h.worker.request(h.live);assert.equal(h.calls.length,0);assert.equal(h.pending.size,0);
  h.live.session.memory.semanticLore=true;h.live.historyComplete=false;await h.worker.request(h.live);assert.equal(h.calls.length,0);assert.equal(h.pending.get('u:s'),true);
  h.live.historyComplete=true;const retry=h.worker.resume(h.live);await tick();h.calls[0].resolve({});await retry;assert.equal(h.pending.get('u:s'),false);
});
test('late summary receipts preserve newer memory state and lore while updating their own history metadata',async()=>{
  const merge=(await appHarness()('summary-state.js')).mergeSummaryResult;
  const current={historyRevision:4,loreRevision:9,memoryState:{extractedThroughOrder:80},memory:{semanticLore:true},nextOrder:100,updatedAt:200};
  const saved={historyRevision:5,loreRevision:2,memoryState:{extractedThroughOrder:20},memory:{semanticLore:false},nextOrder:101,updatedAt:100};
  const next=merge(current,{summaryId:'summary',newBreakpointOrder:90,historyRevision:5,session:saved});
  assert.equal(next.loreRevision,9);assert.equal(next.memoryState.extractedThroughOrder,80);assert.equal(next.memory.semanticLore,true);
  assert.equal(next.nextOrder,101);assert.equal(next.activeSummaryMessageId,'summary');assert.equal(next.breakpointOrder,90);
  assert.equal(next.updatedAt,200);
  const later=merge({...next,historyRevision:6,breakpointOrder:95,activeSummaryMessageId:'newer'},{summaryId:'old',newBreakpointOrder:10,historyRevision:5,session:saved});
  assert.equal(later.activeSummaryMessageId,'newer');assert.equal(later.breakpointOrder,95);assert.equal(later.historyRevision,6);
});
test('embedding spaces require matching models and formats, not just vector dimensions',async()=>{
  const {compatibleEmbedding}=await appHarness()('embedding-space.js'),row={vector:[1,0],modelId:'model-a',dimensions:2,formatVersion:'v1'};
  assert.equal(compatibleEmbedding(row,{model:'model-b',key:'b'},'v1'),false);
  assert.equal(compatibleEmbedding(row,{model:'model-a',key:'different-endpoint'},'v1'),true);
  assert.equal(compatibleEmbedding(row,{model:'model-a'},'v2'),false);
  assert.equal(compatibleEmbedding({...row,dimensions:3},{model:'model-a'},'v1'),false);
});

async function summaryMemoryRace({indexHistoryBatch}={}){
  const turns=await appHarness()('turns.js'),requests={memory:deferred(),summary:deferred()},seen=[];
  const messages=Array.from({length:20},(_,i)=>({id:'m'+i,order:i+1,role:i%2?'assistant':'user',content:'Story event '+i,revision:0}));
  const range={messages:messages.slice(2,10),fromTurn:2,toTurn:5,endOrder:10};
  const session={id:'s',historyRevision:1,loreRevision:0,memory:{autoUpdate:true,lorebooks:true},memoryState:{extractedThroughOrder:0}};
  const live={session,messages,entries:[],storyEpoch:1,historyComplete:true,settings:{maxContextTokens:50000}};
  let continuity;
  const use=appHarness({globals:{document:{dispatchEvent(){}},CustomEvent:class{constructor(type,options){Object.assign(this,{type,...options});}}},stubs:{
    'auth.js':{currentUid:()=> 'u'},'sessions.js':{updateSession:async()=>{}},
    'turns.js':{...turns,dueRange:()=>range},
    'memory-prompts.js':{buildExtractionMessages:async()=>({range,messages:[{role:'user',content:'extract'}]})},
    'lore-lines.js':{parseMemoryLines:()=>({valid:true,ops:[],skipped:[]}),applyOps:()=>({entries:[],appends:[{}],creates:[],skipped:[]})},
    'lore-store.js':{commitExtraction:async(_sid,_changes,{guard})=>{continuity.assertExtractionSource(session,guard);session.loreRevision++;session.memoryState={...session.memoryState,extractedThroughOrder:10};return {entries:[],notes:1,loreRevision:session.loreRevision};},markGeneratedForReview:async()=>[]},
    'session-memory.js':{recordMemoryFailure:async()=>{throw Error('Unexpected memory failure');},clearMemoryInvalidations:async()=>({})},
    'messages.js':{newMessageId:()=> 'sum',getMessages:async()=>messages,getCheckpointMessages:async()=>messages,addMessage:async(_sid,message,options)=>{continuity.assertSource(session,options.expectedSource);Object.assign(session,options.sessionUpdate,{historyRevision:session.historyRevision+1,nextOrder:21});messages.push({...message,order:21});return {id:message.id,message:messages.at(-1),session:structuredClone(session),historyRevision:session.historyRevision};}},
    'context-builder.js':{buildContextForRequest:async()=>({usedTokens:100,report:{warnings:[]}}),computeContextUsage:async()=>({}),MESSAGE_FRAME_TOKENS:8,REQUEST_FRAME_TOKENS:8},
    'tokenizer.js':{countTokens:async text=>Math.ceil(text.length/4)},
    'llm-client.js':{chatCompletion:async request=>{const kind=request.messages.length===1?'memory':'summary';seen.push(kind);return requests[kind].promise;}},
  }});
  continuity=await use('continuity.js');const updater=await use('memory-updater.js'),summary=await use('summarizer.js');
  updater.configureMemoryUpdater({get:()=>live,busy:()=>false,prepare:async()=>{},flush:async()=>{},waitIdle:async(_signal,options)=>assert.equal(options.allowSummary,true),patch:(_sid,patch)=>Object.assign(session.memoryState,patch),...(indexHistoryBatch?{indexHistoryBatch}:{})});
  return {live,session,messages,requests,seen,updater,summary};
}
for(const first of ['summary','memory'])test('real summary and extraction commits preserve both checkpoints when '+first+' finishes first',async()=>{
  const h=await summaryMemoryRace(),memoryJob=h.updater.updateNow('s');await tick();
  const summaryJob=h.summary.runSummarization(h.session,{maxContextTokens:50000,summarizerMaxTokens:1000,summarizerThinkingTokens:0,keepRecentMessagesAfterSummary:2},{messages:h.messages});await tick();
  assert.deepEqual(h.seen,['memory','summary']);
  h.requests[first].resolve({content:first==='summary'?'Saved story summary':'Saved notes',finishReason:'stop'});
  if(first==='summary')await summaryJob;else assert.equal(await memoryJob,true);
  const second=first==='summary'?'memory':'summary';h.requests[second].resolve({content:second==='summary'?'Saved story summary':'Saved notes',finishReason:'stop'});
  assert.equal(await memoryJob,true);assert.equal((await summaryJob).skipped,false);
  assert.equal(h.session.memoryState.extractedThroughOrder,10);assert.equal(h.session.breakpointOrder,18);assert.equal(h.session.loreRevision,1);
  assert.equal(h.messages.find(m=>m.id==='m2').content,'Story event 2');assert.equal(h.messages.length,21);
});
test('stopping a concurrent summary preserves its old checkpoint and lets memory commit',async()=>{
  const h=await summaryMemoryRace(),memoryJob=h.updater.updateNow('s');await tick();const controller=new AbortController();
  const summaryJob=h.summary.runSummarization(h.session,{maxContextTokens:50000,summarizerMaxTokens:1000,summarizerThinkingTokens:0,keepRecentMessagesAfterSummary:2},{messages:h.messages,signal:controller.signal});await tick();
  const stopped=assert.rejects(summaryJob,/Summary stopped/);controller.abort();h.requests.summary.resolve({content:'Late summary',finishReason:'stop'});await stopped;
  h.requests.memory.resolve({content:'Saved notes'});assert.equal(await memoryJob,true);assert.equal(h.session.memoryState.extractedThroughOrder,10);assert.equal(h.session.breakpointOrder,undefined);assert.equal(h.messages.length,20);
});
test('saved memory leaves extraction status while its independent historical index is still finishing',async()=>{
  const index=deferred(),h=await summaryMemoryRace({indexHistoryBatch:()=>index.promise});h.session.memory.historyRecall=true;h.session.memory.semanticRecall=true;
  const job=h.updater.updateNow('s');await tick();assert.equal(h.updater.isExtracting('s'),true);
  h.requests.memory.resolve({content:'Saved notes'});while(h.session.memoryState.extractedThroughOrder!==10)await tick();
  assert.equal(h.updater.isExtracting('s'),false);assert.equal(h.updater.isRunning('s'),true);
  index.resolve({persisted:true,indexedMessages:8});assert.equal(await job,true);assert.equal(h.updater.isRunning('s'),false);
});
