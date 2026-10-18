import {flushStory} from './story-sync.js';
import { exportDirectorTurns, importDirectorTurns } from './director-store.js';
import * as loreStore from './lore-store.js';
import {writeInitialStorySettings,ensureStorySettings} from './story-settings-store.js';
import {assertSnapshotRevisions} from './story-settings.js';
import { maxOf } from './math-utils.js';
import { assertStory } from './errors.js';
import { deleteChatCache } from './chat-cache.js';
import { loadUnsavedReply, storeUnsavedReply } from './unsaved-replies.js';
import { copyLore, waitForStoryWrites } from './lore-store.js';
import {
  doc, getDoc, getDocFromServer, setDoc, updateDoc, deleteDoc, collection, getDocs, getDocsFromServer, query, orderBy,
  writeBatch, runTransaction, serverTimestamp, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";
import { currentUid } from "./auth.js";
import { ensureChunked, ensureContinuityMetadata } from "./messages.js";
import { packMessages, chunkId, chunkRecord, chunkBytes, summaryLookup } from "./message-chunks.js";

// Every session lives under users/{uid}/sessions/... so each user's chat history
// is isolated — enforced both by path scoping and by Firestore rules.

function sessionDoc(sessionId, owner = currentUid()) {
  return doc(db, "users", owner, "sessions", sessionId);
}
function sessionsCol() {
  return collection(db, "users", currentUid(), "sessions");
}

function newId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function listSessions() {
  const q = query(sessionsCol(), orderBy("updatedAt", "desc"));
  const snap = await getDocs(q);
  return visibleSessions(snap);
}

export async function getSession(sessionId) {
  const snap = await getDoc(sessionDoc(sessionId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function getSessionFromServer(sessionId) {
  const snap = await getDocFromServer(sessionDoc(sessionId));
  return snap.exists() ? { id:snap.id,...snap.data() } : null;
}

export async function createSession(title, { importing = false } = {}) {
  const id = newId("sess"),owner=currentUid();
  const data = {
    title: title || "New Session",
    ...(importing ? {importing:true} : {}),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    longTermPlan: "",
    historyRevision:0,continuityVersion:2,lookupVersion:1,...summaryLookup([]),nextNarratorTurn:1,loreRevision:0,
    activeSummaryMessageId: null,
    breakpointOrder: 0,
    nextOrder: 0, // transactionally incremented per added message; messages start at order 1
    storageVersion: 2,
    activeChunkId: null,
    activeChunkBytes: 0,
    activeChunkCount: 0,
  };
  await setDoc(sessionDoc(id,owner), {...data,importing:true});
  await loreStore.initializeLoreCache(owner,id);
  if(owner!==currentUid())throw new Error('Account changed; story creation cancelled.');
  try {await writeInitialStorySettings(id);if(!importing)await updateSession(id,{importing:false});}catch(error){await deleteSession(id);throw error;}
  return id;
}

export async function updateSession(sessionId, partial) {
  await flushStory(sessionId);
  const target=sessionDoc(sessionId);
  await runTransaction(db,async tx=>{
    assertStory((await tx.get(target)).data());
    tx.update(target,{ ...partial,updatedAt:serverTimestamp() });
  });
  if(typeof document!=='undefined')document.dispatchEvent(new CustomEvent('memory-session-saved',{detail:{sessionId,partial}}));
}

export async function renameSession(sessionId, title) {
  await updateSession(sessionId, { title });
}

const pendingDeletions = new Map();
let deletionQueue = Promise.resolve();
function deletionNotice(sessionId) {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('memory-session-deleting', { detail: { sessionId } }));
}
export function resumeSessionDeletion(sessionId, owner = currentUid()) {
  const key=owner+':'+sessionId;
  if(pendingDeletions.has(key))return pendingDeletions.get(key);
  const task=deletionQueue.catch(()=>{}).then(async()=>{
    const target=sessionDoc(sessionId,owner),snap=await getDocFromServer(target);
    if(snap.exists() && !snap.data().deleting)throw new Error('This story is not marked for deletion.');
    // Drop local persisted state before any server subtree disappears.
    await deleteChatCache(owner,sessionId);
    await loreStore.forgetLoreCache(owner,sessionId);
    await storeUnsavedReply(owner,sessionId,null);
    deletionNotice(sessionId);
    await waitForStoryWrites(sessionId);
    // An already-committed write may have acknowledged while deletion drained.
    await loreStore.forgetLoreCache(owner,sessionId);
    for(const name of ['messageChunks','messages','lore','loreBackups','loreMeta','storySettings','directorTurns','operationReceipts']) {
      const snap=await getDocsFromServer(collection(db,'users',owner,'sessions',sessionId,name));
      for(let i=0;i<snap.docs.length;i+=450) {
        const batch=writeBatch(db);
        for(const d of snap.docs.slice(i,i+450))batch.delete(d.ref);
        await batch.commit();
      }
    }
    await loreStore.deleteRecordGenerations?.({id:sessionId,uid:owner});
    if(snap.exists() && snap.data().loreSchemaVersion===3)await updateDoc(target,{loreGenerationsDeleted:true});
    // The tombstone stays until every subtree sweep has completed.
    await deleteDoc(target);
  });
  pendingDeletions.set(key,task);
  deletionQueue=task.catch(()=>{});
  task.then(()=>pendingDeletions.delete(key),()=>pendingDeletions.delete(key));
  return task;
}
const queuedDeletes=new Map(),retryingDeletes=new Set();
async function queuedFor(owner){
  if(!queuedDeletes.has(owner)){
    const saved=await loadUnsavedReply(owner,'__delete_queue');
    if(!queuedDeletes.has(owner))queuedDeletes.set(owner,new Set(Array.isArray(saved?.ids)?saved.ids.filter(id=>typeof id==='string'):[]));
  }
  return queuedDeletes.get(owner);
}
async function rememberDelete(owner,sid,keep){const ids=await queuedFor(owner);if(keep)ids.add(sid);else ids.delete(sid);await storeUnsavedReply(owner,'__delete_queue',ids.size?{ids:[...ids]}:null);}
export async function resumeQueuedDeletions(owner=currentUid()){
  if(retryingDeletes.has(owner))return;retryingDeletes.add(owner);
  try{for(const id of await queuedFor(owner)){if(owner!==currentUid())break;try{await deleteSession(id);}catch(error){console.error('Deletion will retry after reconnecting:',error);break;}}}finally{retryingDeletes.delete(owner);}
}
export async function deleteSession(sessionId) {
  await flushStory(sessionId);
  const owner=currentUid(),target=sessionDoc(sessionId,owner);
  try{
    await runTransaction(db,async tx=>{
      const snap=await tx.get(target);
      if(snap.exists() && !snap.data().deleting)tx.update(target,{deleting:true,deletingAt:serverTimestamp(),historyRevision:(snap.data().historyRevision ?? 0)+1});
    });
  }catch(error){await rememberDelete(owner,sessionId,true);error.deletionPending=true;throw error;}
  await rememberDelete(owner,sessionId,false);
  deletionNotice(sessionId);
  return resumeSessionDeletion(sessionId,owner).catch(error=>{error.deletionPending=true;throw error;});
}
const sweptImports=new Set();
function visibleSessions(snap,onError) {
  const owner=currentUid(),sessions=snap.docs.map(d=>({id:d.id,...d.data()}));
  for(const s of sessions)if(s.deleting)void resumeSessionDeletion(s.id,owner).catch(error=>{error.deletionPending=true;if(onError)onError(error);else console.error('Story deletion will resume on the next connection:',error);});
  for(const s of sessions) {
    const createdAt=s.createdAt?.toMillis?.() ?? (Number.isFinite(s.createdAt?.seconds) ? s.createdAt.seconds*1000 : null);
    const key=owner+':'+s.id;
    if(s.importing && !s.deleting && createdAt!=null && Date.now()-createdAt>24*60*60*1000 && !sweptImports.has(key)) {
      sweptImports.add(key);
      void deleteSession(s.id).catch(error=>{if(onError)onError(error);else console.error('Incomplete story cleanup will resume on the next connection:',error);});
    }
  }
  return sessions.filter(s=>!s.deleting && !s.importing);
}
export function subscribeSessions(callback,onError) {
  const owner=currentUid();const retry=()=>{if(owner===currentUid())void resumeQueuedDeletions(owner).catch(error=>onError?.(error));};
  retry();if(typeof window!=='undefined')window.addEventListener('online',retry);
  const unsubscribe=onSnapshot(query(sessionsCol(),orderBy('updatedAt','desc')),snap=>{retry();callback(visibleSessions(snap,onError),{fromCache:!!snap.metadata?.fromCache,hasPendingWrites:!!snap.metadata?.hasPendingWrites});},onError);
  return ()=>{unsubscribe();if(typeof window!=='undefined')window.removeEventListener('online',retry);};
}

// Copy the first N stored messages (including summary messages), or all when
// omitted. Keep message ids, timestamps, orders, and hidden reply data intact.
export async function duplicateSession(sourceId, messageCount = null, throughMessageId = null) {
  await flushStory(sourceId);
  const owner = currentUid();
  if (messageCount !== null && (!Number.isSafeInteger(messageCount) || messageCount < 0)) {
    throw new Error("Message count must be a whole number of 0 or more.");
  }
  await ensureContinuityMetadata(sourceId);
  const sourceSnap = await getDocFromServer(sessionDoc(sourceId,owner));
  const source = sourceSnap.exists() ? { id: sourceSnap.id, ...sourceSnap.data() } : null;
  assertStory(source);
  const capturedLore=await loreStore.getLoreSnapshot({id:sourceId,uid:owner});
  const msgsSnap = messageCount === 0 ? { docs: [] } : await getDocsFromServer(
    collection(db,"users",owner,"sessions",sourceId,"messageChunks")
  );
  const messages = msgsSnap.docs.flatMap((d) => d.data().messages ?? [])
    .sort((a, b) => a.order - b.order);
  if (messageCount !== null && messageCount > messages.length) {
    throw new Error(`This session has only ${messages.length} messages. Choose 0–${messages.length}.`);
  }
  let selected = messageCount === null ? messages : messages.slice(0, messageCount);
  if (throughMessageId !== null) {
    const index = messages.findIndex((m) => m.id === throughMessageId);
    if (index < 0) throw new Error("This message no longer exists. Refresh the session and try again.");
    selected = messages.slice(0, index + 1);
  }
  const sourceSettings=await ensureStorySettings(sourceId,owner);
  const capturedSource={...source,storySettingsRevision:source.storySettingsRevision ?? sourceSettings.revision};
  const groups = packMessages(selected);
  const last = groups.at(-1);
  const hasSummary = selected.some((m) => m.id === source.activeSummaryMessageId && m.role === "summary");

  const id = newId("sess");
  const { id: _omit, createdAt: _c, updatedAt: _u, ...fields } = source;
  const data = {
    ...fields,
    title: (source.title || "Session") + " (copy)",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    nextOrder: selected.at(-1)?.order ?? 0,
    nextNarratorTurn:Math.max(0,maxOf(selected.map(m => m.narratorTurn ?? 0)))+(selected.at(-1)?.role === "user" ? 0 : 1),
    storageVersion: 2,lookupVersion:1,...summaryLookup(selected),
    activeChunkId: last ? chunkId(last[0].order) : null,
    activeChunkBytes: last ? chunkBytes(last) : 0,
    activeChunkCount: last?.length ?? 0,
    activeSummaryMessageId: hasSummary ? source.activeSummaryMessageId : null,
    breakpointOrder: hasSummary ? source.breakpointOrder ?? 0 : 0,
  };

  data.loreSchemaVersion=capturedLore.schemaVersion===3 || capturedLore.entries.some(e=>e.schemaVersion===3)?3:2;data.loreRevision=0;
  data.loreMigration={active:false};data.loreGeneration=data.loreSchemaVersion===3?newId('generation'):null;
  if (source.memoryState) {
    const lastAssistant = selected.filter(m => m.role === 'assistant').at(-1)?.order ?? 0;
    data.memoryState = { ...source.memoryState, extractedThroughOrder: source.memoryState.extractedThroughOrder == null ? null : Math.min(source.memoryState.extractedThroughOrder, lastAssistant), failureStreak: 0, paused: false, lastError: null };
  }

  const lastSelectedOrder=selected.at(-1)?.order ?? 0;
  const directorTurns=source.directorState || selected.some(m=>m.directorTurnId) ? (await exportDirectorTurns(sourceId,owner)).filter(t=>t.status==='completed' && (t.order ?? Infinity)<=lastSelectedOrder) : [];
  const lastDirectorId=selected.filter(m=>m.directorTurnId && !m.directorIncomplete).at(-1)?.directorTurnId;
  const directorCheckpoint=directorTurns.find(t=>t.id===source.directorCheckpoint && t.manual && (t.order ?? Infinity)<=lastSelectedOrder) ?? directorTurns.find(t=>t.id===lastDirectorId);
  if(source.directorState || source.directorPending || selected.some(m=>m.directorTurnId)){
    data.directorState=directorCheckpoint?.after ?? null;data.directorCheckpoint=directorCheckpoint?.id ?? null;data.directorPending=null;data.directorRevision=0;data.directorStateHistoryOrder=directorCheckpoint?.order ?? lastSelectedOrder;data.directorAbandonedTurnIds=[...(source.directorAbandonedTurnIds ?? []),...selected.filter(m=>m.directorIncomplete).map(m=>m.directorTurnId)].filter(Boolean);
    data.directorNeedsReview=!!source.directorNeedsReview || selected.some(m=>m.directorIncomplete);
  }

  data.memoryInvalidations=(source.memoryInvalidations ?? []).filter(i=>(i.fromOrder ?? i.order ?? Infinity)<=lastSelectedOrder);
  data.contentEdits=(source.contentEdits ?? []).filter(i=>i.order<=lastSelectedOrder);
  if(data.memoryState){
    const rebuild=data.memoryState.rebuildFromOrder;
    const retainedRebuild=rebuild!=null && rebuild<=lastSelectedOrder;
    data.memoryState={...data.memoryState,needsRebuild:data.memoryInvalidations.length>0 || retainedRebuild,rebuildFromOrder:retainedRebuild ? rebuild : data.memoryInvalidations.length ? Math.min(...data.memoryInvalidations.map(i=>i.fromOrder)) : null};
  }
  // Publish the session only once all chunks are ready, so the sidebar never
  // selects an incomplete copy. Remove partial chunks if a write fails.
  try {
    await setDoc(sessionDoc(id,owner),{...data,importing:true});
    await loreStore.initializeLoreCache(owner,id,{schemaVersion:data.loreSchemaVersion,generation:data.loreGeneration ?? null});
    for (let i = 0; i < groups.length; i += 6) {
      await runTransaction(db,async tx=>{
        assertStory((await tx.get(sessionDoc(sourceId,owner))).data());
        assertStory((await tx.get(sessionDoc(id,owner))).data());
        for(const group of groups.slice(i,i+6))tx.set(doc(db,"users",owner,"sessions",id,"messageChunks",chunkId(group[0].order)),chunkRecord(group));
      });
    }
    if (owner !== currentUid()) throw new Error('Account changed; session copy cancelled.');
    await writeInitialStorySettings(id,sourceSettings.values,owner);
    await copyLore(sourceId,id,selected.at(-1)?.order ?? 0,capturedLore);
    if(directorTurns.length)await importDirectorTurns(id,directorTurns,owner);
    await runTransaction(db,async tx=>{
      const fresh=assertStory((await tx.get(sessionDoc(sourceId,owner))).data());
      assertSnapshotRevisions(capturedSource,fresh,{cachedLore:true});
      const copied=await tx.get(sessionDoc(id,owner));
      assertStory(copied.data());
      tx.set(sessionDoc(id,owner),{...data,loreRevision:copied.data()?.loreRevision ?? 0,storySettingsRevision:1});
    });
  } catch (error) {
    try { if (owner === currentUid()) await deleteSession(id); } catch (cleanupError) {
      console.error("Could not remove incomplete session copy:", cleanupError);
    }
    throw error;
  }
  return id;
}
