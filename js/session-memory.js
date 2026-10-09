import { doc, runTransaction, increment, serverTimestamp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { db } from './db.js';
import { currentUid } from './auth.js';
import { assertStory } from './errors.js';

const sessionRef = (sid,owner) => doc(db,'users',owner,'sessions',sid);
function assertOwner(owner) { if (owner !== currentUid()) throw new Error('Account changed; this memory action was cancelled.'); }

// Clear only edits covered by the explicitly requested rebuild. Later revisions
// belong to a concurrent edit and must remain pending even on the same range.
export async function clearMemoryInvalidations(sid,{seenRevision,fromOrder=0,pointer=0}) {
  const owner=currentUid();
  return runTransaction(db,async tx => {
    assertOwner(owner);
    const target=sessionRef(sid,owner),snap=await tx.get(target),session=assertStory(snap.exists() ? snap.data() : null);
    assertOwner(owner);
    const remaining=(session.memoryInvalidations ?? []).filter(i => i.revision>seenRevision || i.fromOrder<fromOrder);
    const rebuildFromOrder=remaining.length ? Math.min(...remaining.map(i=>i.fromOrder)) : null;
    const memoryState={extractedThroughOrder:pointer,needsRebuild:remaining.length>0,rebuildFromOrder,paused:false,failureStreak:0};
    tx.update(target,{memoryInvalidations:remaining,...Object.fromEntries(Object.entries(memoryState).map(([key,value])=>['memoryState.'+key,value])),updatedAt:serverTimestamp()});
    return {memoryInvalidations:remaining,memoryState};
  });
}

export async function recordMemoryFailure(sid,lastError) {
  const owner=currentUid();
  return runTransaction(db,async tx => {
    assertOwner(owner);
    const target=sessionRef(sid,owner),snap=await tx.get(target),session=assertStory(snap.exists() ? snap.data() : null);
    assertOwner(owner);
    const failureStreak=(session.memoryState?.failureStreak ?? 0)+1,paused=failureStreak>=3;
    tx.update(target,{'memoryState.failureStreak':increment(1),'memoryState.lastError':lastError,'memoryState.paused':paused,updatedAt:serverTimestamp()});
    return {failureStreak,lastError,paused};
  });
}

// Leaf updates preserve unrelated memory choices changed by another device.
export function diffMemorySettings(original,next) {
  const partial={};
  function visit(before,after,path) {
    if (JSON.stringify(before)===JSON.stringify(after)) return;
    if (after && typeof after==='object' && !Array.isArray(after)) {
      for (const [key,value] of Object.entries(after)) visit(before?.[key],value,path+'.'+key);
    } else partial[path]=after;
  }
  visit(original,next,'memory');
  return partial;
}

// Dismiss only the invalidations the user has seen; preserve extraction state.
export async function dismissRebuild(sid,seenRevision) {
  const owner=currentUid();
  return runTransaction(db,async tx=>{
    assertOwner(owner);
    const target=sessionRef(sid,owner),snap=await tx.get(target),session=assertStory(snap.exists()?snap.data():null);
    assertOwner(owner);
    const remaining=(session.memoryInvalidations ?? []).filter(i=>i.revision>seenRevision);
    let order=Infinity;for(const i of remaining)order=Math.min(order,i.fromOrder);
    const memoryState={needsRebuild:remaining.length>0,rebuildFromOrder:remaining.length?order:null};
    tx.update(target,{memoryInvalidations:remaining,'memoryState.needsRebuild':memoryState.needsRebuild,'memoryState.rebuildFromOrder':memoryState.rebuildFromOrder,updatedAt:serverTimestamp()});
    return {memoryInvalidations:remaining,memoryState};
  });
}
