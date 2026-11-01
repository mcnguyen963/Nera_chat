import {createRecallEngine} from './history-recall-engine.js';
import {recallStorage} from './history-recall-storage.js';
import {embedTexts} from './history-embeddings.js';
import {semanticConnection} from './lore-semantic.js';
import {renderRecall} from './history-recall-core.js';
import {requestInputLimit,MESSAGE_FRAME_TOKENS} from './request-budget.js';
import {addHistoricalRecall} from './history-recall-context.js';
import {countTokens} from './tokenizer.js';
import {currentUid} from './auth.js';
import {recallText,contentHash,passages} from './history-recall-core.js';
import {embeddingSourcesUnchanged} from './embedding-source.js';

const engine=createRecallEngine({storage:recallStorage,embed:embedTexts});
const resumedBatches=new Map();
export function recallEnabled(snapshot) {return snapshot?.session?.memory?.historyRecall===true && snapshot.settings?.narrationMode!=='director';}
const connectionFor=snapshot=>snapshot.session.memory.semanticRecall===true ? semanticConnection(snapshot.session.memory,ownerNow()) : null;
const ownerNow=()=>{try{return currentUid();}catch{return null;}};

// Source messages are the already captured story history. Never read Firebase on Send.
export async function recallForRequest(snapshot,base,opts={}, {signal,check=()=>true,preview=false}={}) {
  if(!recallEnabled(snapshot))return base;
  const owner=ownerNow();if(!owner)return base;
  const memory=snapshot.session.memory,settings={...snapshot.settings,historyRecallBudget:memory.historyRecallBudget,historyRecallPassages:memory.historyRecallPassages};
  if(requestInputLimit(settings)-base.usedTokens<=await countTokens(renderRecall([]))+MESSAGE_FRAME_TOKENS || memory.historyRecallBudget===0)
    return addHistoricalRecall(base,{passages:[],status:'no-spare-context'},settings,countTokens);
  let connection=null,configurationError=false;
  try{if(!preview)connection=connectionFor(snapshot);}catch{configurationError=true;}
  // Fetch a bounded reserve so an oversized or redundant passage does not
  // prevent a later useful result from filling the configured allowance.
  const result=await engine.search({owner,sid:snapshot.session.id,messages:snapshot.messages,opts,excludeIds:(base.inspection?.messages ?? base.entries ?? []).map(m=>m.id),connection,signal,passageLimit:20,check:()=>ownerNow()===owner && check()});
  if(signal?.aborted || ownerNow()!==owner || !check())return base;
  if(configurationError)result.status='keyword-embedding-not-configured';
  if(preview)result.status='local-preview; semantic ranking runs only on Send';
  return addHistoricalRecall(base,result,settings,countTokens);
}

// Explicit migration operates on a complete captured history and does not fetch it.
export async function indexOlderHistory(snapshot,{getLive=()=>snapshot,signal,onProgress=()=>{},force=false}={}) {
  if(!recallEnabled(snapshot))throw new Error('Save Historical recall for this story in Classic mode first.');
  if(!snapshot.historyComplete)throw new Error('Complete story history is not available on this device.');
  const owner=ownerNow(),sid=snapshot.session.id,epoch=snapshot.storyEpoch,connection=connectionFor(snapshot),messages=structuredClone(snapshot.messages),source=structuredClone(snapshot.session);
  const config=mem=>JSON.stringify([mem?.semanticRecall,mem?.semanticEndpoint,mem?.semanticModel]);
  const check=()=>{const live=getLive();return owner===ownerNow() && recallEnabled(live) && live.session.id===sid && live.storyEpoch===epoch && config(live.session.memory)===config(source.memory) && JSON.stringify([live.session.contentEditsFloor,live.session.contentEdits])===JSON.stringify([source.contentEditsFloor,source.contentEdits]) && embeddingSourcesUnchanged(messages,live.messages);};
  if(!check())throw new Error('Story or account changed.');
  return engine.index({owner,sid,messages,session:source,connection,signal,check,onProgress,force,replaceAll:true});
}
export async function indexHistoryBatch(snapshot,range,{signal,check=()=>true,onProgress=()=>{}}={}) {
  if(!recallEnabled(snapshot) || !snapshot.session.memory.semanticRecall)return null;
  const owner=ownerNow();if(!owner)return null;
  if(!snapshot.historyComplete)throw new Error('Complete local history is needed to update the search index.');
  const sid=snapshot.session.id,first=Math.min(...range.messages.map(m=>m.order));
  if(!Number.isFinite(first))throw new Error('The memory batch has no starting order.');
  let pending;
  if(recallStorage.mergePendingBatch)pending=await recallStorage.mergePendingBatch(owner,sid,{fromOrder:first,throughOrder:range.endOrder},()=>ownerNow()===owner && check());
  else {const old=await recallStorage.loadPendingBatch(owner,sid);pending={fromOrder:Math.min(first,old?.fromOrder??first),throughOrder:Math.max(range.endOrder,old?.throughOrder??range.endOrder)};if(!await recallStorage.savePendingBatch(owner,sid,pending))pending=null;}
  if(!pending)throw new Error('Device storage is unavailable for search-update progress.');
  const fromOrder=pending.fromOrder;
  const through=snapshot.messages.filter(m=>m.role!=='summary' && m.order>=fromOrder && m.order<=range.endOrder);
  const result=await engine.index({owner,sid,messages:structuredClone(through),session:snapshot.session,connection:connectionFor(snapshot),signal,check:()=>ownerNow()===owner && check(),onProgress});
  if(result.persisted && pending.throughOrder<=range.endOrder && ownerNow()===owner && check())await recallStorage.clearPendingBatch(owner,sid,pending.version);
  return result;
}
export async function resumePendingHistory(snapshot,{getLive=()=>snapshot,onStatus=()=>{}}={}) {
  if(!recallEnabled(snapshot) || !snapshot.session.memory.semanticRecall || !snapshot.historyComplete)return null;
  const owner=ownerNow(),sid=snapshot.session.id;if(!owner)return null;
  const key=JSON.stringify([owner,sid]);if(resumedBatches.has(key))return resumedBatches.get(key);
  const job=(async()=>{
    const pending=await recallStorage.loadPendingBatch(owner,sid);if(!pending)return null;
    const source=structuredClone({session:snapshot.session,settings:snapshot.settings,messages:snapshot.messages,storyEpoch:snapshot.storyEpoch,historyComplete:snapshot.historyComplete}),range=source.messages.filter(m=>m.role!=='summary'&&m.order>=pending.fromOrder&&m.order<=pending.throughOrder);
    const stamp=messages=>JSON.stringify(messages.map(m=>[m.id,m.order,m.role,m.revision??0,m.content,m.ooc,m.acceptance,m.truncated,m.needsReview,m.directorIncomplete]));
    const captured=stamp(range),check=()=>{const live=getLive();return ownerNow()===owner && recallEnabled(live) && live.session.memory.semanticRecall && live.session.id===sid && live.storyEpoch===source.storyEpoch && stamp(live.messages.filter(m=>m.role!=='summary'&&m.order>=pending.fromOrder&&m.order<=pending.throughOrder))===captured;};
    if(!check())return null;
    onStatus({searchPhase:'running'});
    try {
      if(!range.length){await recallStorage.clearPendingBatch(owner,sid,pending.version);if(check())onStatus({searchPhase:'ready'});return null;}
      const result=await indexHistoryBatch(source,{messages:range,endOrder:pending.throughOrder},{check});
      if(check())onStatus({searchPhase:result.persisted?'ready':'failed',message:result.persisted?'Pending historical search update finished.':'Search is available in memory only; device storage is unavailable.'});
      return result;
    }catch(error){if(check())onStatus({searchPhase:'failed',message:'Historical search update pending: '+String(error.message).slice(0,180)});return null;}
  })();
  resumedBatches.set(key,job);try{return await job;}finally{if(resumedBatches.get(key)===job)resumedBatches.delete(key);}
}
export async function clearHistoryIndex(sid) {return engine.clear(currentUid(),sid);}
export async function exportHistoryVectors(sid,{messages}={}) {
  const rows=(await engine.load(currentUid(),sid)).rows.filter(r=>r.vector);
  if(!messages)return rows;
  const sources=new Map(messages.map(m=>[m.id,m])),hashes=new Map(),valid=[];
  for(const row of rows){const source=sources.get(row.messageId);if(!source || source.order!==row.order || source.role!==row.role || (source.revision ?? 0)!==row.revision)continue;
    if(!hashes.has(source.id))hashes.set(source.id,await contentHash(recallText(source)));
    if(row.sourceHash===hashes.get(source.id) && passages(source).some(p=>p.id===row.id && p.start===row.start && p.end===row.end))valid.push(row);
  }
  return valid;
}
export async function importHistoryVectors(snapshot,rows,{check=()=>true}={}) {
  if(!snapshot.historyComplete)throw new Error('Complete story history is required to verify downloaded vectors.');
  return engine.importRows({owner:currentUid(),sid:snapshot.session.id,messages:snapshot.messages,rows,connection:semanticConnection(snapshot.session.memory,ownerNow()),check});
}
export async function historyIndexStatus(sid) {
  const record=await engine.load(currentUid(),sid);
  return {messages:record.indexedMessages,passages:record.rows.length,persisted:record.persisted ?? false};
}
globalThis.document?.addEventListener('history-recall-cleared',event=>engine.forget(event.detail.owner,event.detail.sid));
