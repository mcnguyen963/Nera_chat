import {createRecallEngine} from './history-recall-engine.js';
import {recallStorage} from './history-recall-storage.js';
import {embedTexts} from './history-embeddings.js';
import {semanticConnection} from './lore-semantic.js';
import {renderRecall} from './history-recall-core.js';
import {requestInputLimit,MESSAGE_FRAME_TOKENS} from './request-budget.js';
import {addHistoricalRecall} from './history-recall-context.js';
import {countTokens} from './tokenizer.js';
import {currentUid} from './auth.js';

const engine=createRecallEngine({storage:recallStorage,embed:embedTexts});
export function recallEnabled(snapshot) {return snapshot?.session?.memory?.historyRecall===true && snapshot.settings?.narrationMode!=='director';}
const connectionFor=snapshot=>snapshot.session.memory.semanticRecall===true ? semanticConnection(snapshot.session.memory) : null;
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
  const owner=ownerNow(),sid=snapshot.session.id,revision=snapshot.session.historyRevision,epoch=snapshot.storyEpoch,connection=connectionFor(snapshot);
  const check=()=>{const live=getLive();return owner===ownerNow() && recallEnabled(live) && live.session.id===sid && live.storyEpoch===epoch && live.session.historyRevision===revision;};
  if(!check())throw new Error('Story or account changed.');
  return engine.index({owner,sid,messages:structuredClone(snapshot.messages),session:snapshot.session,connection,signal,check,onProgress,force,replaceAll:true});
}
export async function indexHistoryBatch(snapshot,range,{signal,check=()=>true,onProgress=()=>{}}={}) {
  if(!recallEnabled(snapshot) || !snapshot.session.memory.semanticRecall)return null;
  const owner=ownerNow();if(!owner)return null;
  if(!snapshot.historyComplete)throw new Error('Complete local history is needed to update the search index.');
  const sid=snapshot.session.id,first=Math.min(...range.messages.map(m=>m.order));
  if(!Number.isFinite(first))throw new Error('The memory batch has no starting order.');
  const pending=await recallStorage.loadPendingBatch(owner,sid),fromOrder=Math.min(first,pending?.fromOrder ?? first);
  if(!await recallStorage.savePendingBatch(owner,sid,{fromOrder,throughOrder:range.endOrder}))throw new Error('Device storage is unavailable for search-update progress.');
  const through=snapshot.messages.filter(m=>m.role!=='summary' && m.order>=fromOrder && m.order<=range.endOrder);
  const result=await engine.index({owner,sid,messages:structuredClone(through),session:snapshot.session,connection:connectionFor(snapshot),signal,check:()=>ownerNow()===owner && check(),onProgress});
  if(result.persisted && ownerNow()===owner && check())await recallStorage.clearPendingBatch(owner,sid);
  return result;
}
export async function clearHistoryIndex(sid) {return engine.clear(currentUid(),sid);}
export async function exportHistoryVectors(sid) {return (await engine.load(currentUid(),sid)).rows.filter(r=>r.vector);}
export async function importHistoryVectors(snapshot,rows,{check=()=>true}={}) {
  if(!snapshot.historyComplete)throw new Error('Complete story history is required to verify downloaded vectors.');
  return engine.importRows({owner:currentUid(),sid:snapshot.session.id,messages:snapshot.messages,rows,check});
}
export async function historyIndexStatus(sid) {
  const record=await engine.load(currentUid(),sid);
  return {messages:record.indexedMessages,passages:record.rows.length,persisted:record.persisted ?? false};
}
globalThis.document?.addEventListener('history-recall-cleared',event=>engine.forget(event.detail.owner));
