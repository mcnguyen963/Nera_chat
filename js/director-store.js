import * as firestore from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
const {doc,collection,getDocFromServer,getDocsFromServer,runTransaction,serverTimestamp,writeBatch}=firestore;
import { db } from './db.js';
import { currentUid } from './auth.js';
import { assertStory } from './errors.js';
import { requestSource, assertSource } from './continuity.js';
import { validateDirectorState, activeDirectorState } from './director-state.js';
const parent=(sid,uid=currentUid())=>doc(db,'users',uid,'sessions',sid);
export const directorTurnRef=(sid,id,uid=currentUid())=>doc(db,'users',uid,'sessions',sid,'directorTurns',id);
const check=uid=>{if(uid!==currentUid())throw new Error('Account changed during Director operation.');};
export async function getDirectorTurn(sid,id) {
  if(!id)return null;
  const uid=currentUid(),snap=await getDocFromServer(directorTurnRef(sid,id,uid));check(uid);
  const turn=snap.exists()?snap.data():null;
  if(turn && turn.version!==1)throw new Error('Unsupported Director turn version.');
  return turn;
}
export async function savePendingDirectorTurn(sid,turn,source) {
  const uid=currentUid();
  return runTransaction(db,async tx=>{
    check(uid);const ref=parent(sid,uid),s=assertStory((await tx.get(ref)).data());assertSource(s,source);
    if(s.directorPending && s.directorPending!==turn.id) {
      const previous=(await tx.get(directorTurnRef(sid,s.directorPending,uid))).data();
      if(turn.replaces!==s.directorPending && previous?.source && JSON.stringify(previous.source)===JSON.stringify(source))throw new Error('Another Director turn is pending. Refresh and retry.');
    }
    check(uid);const saved={...turn,version:1,status:'pending',source,createdAt:Date.now()};
    tx.set(directorTurnRef(sid,turn.id,uid),saved);tx.update(ref,{directorPending:turn.id,updatedAt:serverTimestamp()});
    return saved;
  });
}
// Read before any transaction writes. The caller saves this patch with narration.
export async function directorReplyPatch(tx,sid,session,message,order,uid=currentUid()) {
  if(!message.directorTurnId)return null;
  const ref=directorTurnRef(sid,message.directorTurnId,uid),snap=await tx.get(ref),turn=snap.data();
  if(!snap.exists() || turn.version!==1)throw new Error('Director contract is missing. Re-plan the reply.');
  if(turn.status==='discarded')throw new Error('This Director contract was discarded. Re-plan the turn.');
  const rewrite=turn.status==='completed' && session.directorCheckpoint===turn.id;
  if(!rewrite){
    if(session.directorPending!==turn.id)throw new Error('The pending Director contract changed.');
    assertSource(session,turn.source);
  }
  const completed=!message.truncated;
  const patch=completed && !rewrite ? {directorState:validateDirectorState(turn.after),directorRevision:(session.directorRevision ?? 0)+1,directorCheckpoint:turn.id,directorPending:null,directorNeedsReview:false,directorStateHistoryOrder:order} : !completed ? {directorPending:turn.id} : {};
  const source=requestSource({...session,...patch,historyRevision:(session.historyRevision ?? 0)+1});
  return {patch,write:()=>tx.update(ref,{status:completed?'completed':'pending',assistantId:message.id,order,source,updatedAt:Date.now()})};
}
export async function resetDirectorState(sid,value,expected) {
  const uid=currentUid(),state=activeDirectorState(value),id='manual_'+Date.now().toString(36)+'_'+Math.random().toString(36).slice(2,8);
  return runTransaction(db,async tx=>{
    check(uid);const ref=parent(sid,uid),s=assertStory((await tx.get(ref)).data());assertSource(s,expected);
    if(s.directorPending)throw new Error('Finish or discard the pending narration before editing live state.');
    const revision=(s.directorRevision ?? 0)+1;
    tx.set(directorTurnRef(sid,id,uid),{version:1,id,status:'completed',manual:true,createdAt:Date.now(),previousCheckpoint:s.directorCheckpoint ?? null,order:s.nextOrder ?? 0,before:s.directorState ?? state,after:state});
    tx.update(ref,{directorState:state,directorRevision:revision,directorCheckpoint:id,directorStateHistoryOrder:s.nextOrder ?? 0,directorNeedsReview:false,updatedAt:serverTimestamp()});
    return state;
  });
}
export async function discardPendingDirector(sid,expected) {
  const uid=currentUid();return runTransaction(db,async tx=>{check(uid);const ref=parent(sid,uid),s=assertStory((await tx.get(ref)).data());assertSource(s,expected);if(s.directorPending){const pendingRef=directorTurnRef(sid,s.directorPending,uid);const pending=await tx.get(pendingRef);if(pending.exists())tx.update(pendingRef,{status:'discarded'});}tx.update(ref,{directorAbandonedTurnIds:[...(s.directorAbandonedTurnIds ?? []),...(s.directorPending ? [s.directorPending] : [])].slice(-200),directorPending:null,directorRevision:(s.directorRevision ?? 0)+1,updatedAt:serverTimestamp()});});
}
export async function exportDirectorTurns(sid,uid=currentUid()) {
  const snap=await getDocsFromServer(collection(db,'users',uid,'sessions',sid,'directorTurns'));check(uid);
  return snap.docs.map(d=>({id:d.id,...d.data()}));
}
export async function importDirectorTurns(sid,turns,uid=currentUid()) {
  for(const turn of turns){if(turn.version!==1 || typeof turn.id!=='string' || !/^[\w-]+$/.test(turn.id))throw new Error('Unsupported Director backup.');validateDirectorState(turn.before);validateDirectorState(turn.after);}
  for(let i=0;i<turns.length;i+=100){check(uid);const batch=writeBatch(db);for(const turn of turns.slice(i,i+100))batch.set(directorTurnRef(sid,turn.id,uid),turn);await batch.commit();}
}
