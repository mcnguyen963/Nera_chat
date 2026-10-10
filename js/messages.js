import { maxOf } from './math-utils.js';
import { assertStory } from './errors.js';
import { computeTurns } from './turns.js';
import { canonicalScene } from './scene.js';
import { assertSource, revisionOf, trimInvalidations } from './continuity.js';
import {
  doc, getDocFromServer, getDocsFromServer, query, orderBy, where, startAfter, limit,
  limitToLast, updateDoc, collection, runTransaction, writeBatch, serverTimestamp,
  Timestamp, arrayUnion, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";
import { currentUid } from "./auth.js";
import { countTokens } from "./tokenizer.js";
import {
  TARGET_CHUNK_BYTES, MAX_MESSAGES_PER_CHUNK, messageBytes, packMessages,
  chunkBytes, chunkId, chunkRecord,
} from "./message-chunks.js";

export class HistoryConflict extends Error {
  constructor(message = 'Story history changed while the reply was generated. Copy the reply or save it at the end.') {
    super(message); this.name = 'HistoryConflict';
  }
}
function assertReplySource(session, expected) {
  if (expected && 'historyRevision' in expected && (session?.historyRevision ?? 0) !== expected.historyRevision) throw new HistoryConflict();
  assertSource(session, expected);
}

function sessionRef(sessionId, owner = currentUid()) {
  return doc(db, "users", owner, "sessions", sessionId);
}
function legacyMessagesCol(sessionId, owner = currentUid()) {
  return collection(db, "users", owner, "sessions", sessionId, "messages");
}
function chunksCol(sessionId, owner = currentUid()) {
  return collection(db, "users", owner, "sessions", sessionId, "messageChunks");
}
function chunkRef(sessionId, id, owner = currentUid()) {
  return doc(db, "users", owner, "sessions", sessionId, "messageChunks", id);
}

function newMsgId() {
  return "msg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
export const newMessageId = newMsgId;

function makeMessage(id, order, message, tokenCount) {
  const { role,content,thinking = null,planThread = null,planBefore = null,scene = null } = message;
  return { ...message,id,order,role,content,thinking,planThread,planBefore,scene,revision:message.revision ?? 0,tokenCount,createdAt:message.createdAt ?? Timestamp.now(),editedAt:message.editedAt ?? null };
}

function contextText(message) {
  return message.planThread ? `${message.content}\n<plan_thread>${message.planThread}</plan_thread>` : message.content;
}

const readySessions = new Set();
const metadataReady = new Set();
const migrations = new Map();

async function writePackedChunks(sessionId, groups, owner = currentUid()) {
  // Six worst-case oversized chunks stay below Firestore's 10 MiB request cap.
  for (let i = 0; i < groups.length; i += 6) {
    await runTransaction(db,async tx => {
      assertStory((await tx.get(sessionRef(sessionId,owner))).data());
      for (const group of groups.slice(i, i + 6)) tx.set(chunkRef(sessionId, chunkId(group[0].order), owner), chunkRecord(group));
    });
  }
}

// Legacy message documents remain untouched. Chunk writes finish before the
// session marker changes, so an interrupted migration can safely run again.
export function ensureChunked(sessionId) {
  const owner = currentUid(), key = owner+':'+sessionId;
  if (readySessions.has(key)) return Promise.resolve();
  if (migrations.has(key)) return migrations.get(key);
  const pending = (async () => {
    const sessionSnap = await getDocFromServer(sessionRef(sessionId, owner));
    assertStory(sessionSnap.data());
    if (sessionSnap.data().storageVersion !== 2) {
      const old = await getDocsFromServer(query(legacyMessagesCol(sessionId, owner), orderBy("order", "asc")));
      const messages = old.docs.map((d) => ({ id: d.id, ...d.data() }));
      const groups = packMessages(messages);
      await writePackedChunks(sessionId, groups, owner);
      const last = groups.at(-1);
      await runTransaction(db,async tx => {
        assertStory((await tx.get(sessionRef(sessionId,owner))).data());
        tx.update(sessionRef(sessionId, owner), {
        storageVersion: 2,
        nextOrder: Math.max(sessionSnap.data().nextOrder ?? 0, messages.at(-1)?.order ?? 0),
        activeChunkId: last ? chunkId(last[0].order) : null,
        activeChunkBytes: last ? chunkBytes(last) : 0,
        activeChunkCount: last?.length ?? 0,
        });
      });
    }
    readySessions.add(key);
  })().finally(() => migrations.delete(key));
  migrations.set(key, pending);
  return pending;
}

export async function ensureContinuityMetadata(sessionId) {
  const owner = currentUid();
  await ensureChunked(sessionId);
  if (owner !== currentUid()) throw new Error('Account changed during migration.');
  const key = owner+':'+sessionId;
  if (metadataReady.has(key)) return;
  const target = sessionRef(sessionId, owner), snap = await getDocFromServer(target);
  assertStory(snap.data());
  if (snap.data().continuityVersion === 2) { metadataReady.add(key); return; }
  const chunks = await getDocsFromServer(query(chunksCol(sessionId, owner),orderBy('firstOrder','asc')));
  const source = flatten(chunks), turns = computeTurns(source);
  const sourceRevision = snap.data().historyRevision ?? 0, sourceOrder = snap.data().nextOrder;
  const assertMigrationSource = session => {
    assertStory(session);
    if (!session || (session.historyRevision ?? 0) !== sourceRevision || session.nextOrder !== sourceOrder) throw new Error('History changed during migration; try again.');
  };
  const migrateMessages = messages => messages.map(m => ({ ...m,revision:m.revision ?? 0,...(m.role !== 'summary' ? { narratorTurn:m.narratorTurn ?? turns.turnById.get(m.id) } : {}) }));
  // A resumable per-chunk marker bounds each request even for very long stories.
  // Metadata-only writes do not advance historyRevision.
  for (const chunk of chunks.docs) {
    if (chunk.data().continuityVersion === 2) continue;
    await runTransaction(db,async tx => {
      const sessionSnap = await tx.get(target);
      assertMigrationSource(sessionSnap.data());
      const fresh = await tx.get(chunkRef(sessionId,chunk.id,owner));
      if (!fresh.exists()) throw new Error('History changed during migration; try again.');
      if (fresh.data().continuityVersion === 2) return;
      const messages = migrateMessages(fresh.data().messages ?? []);
      tx.update(chunkRef(sessionId,chunk.id,owner),{ messages,byteSize:chunkBytes(messages),continuityVersion:2 });
    });
  }
  await runTransaction(db,async tx => {
    const sessionSnap = await tx.get(target);
    const session = sessionSnap.data();
    assertMigrationSource(session);
    const active = chunks.docs.find(chunk => chunk.id === session.activeChunkId);
    if (session.activeChunkId && !active) throw new Error('Active history chunk is missing; migration was not completed.');
    tx.update(target,{ continuityVersion:2,historyRevision:sourceRevision,nextNarratorTurn:Math.max(0,maxOf(source.map(m => m.narratorTurn ?? turns.turnById.get(m.id) ?? 0)))+ (source.at(-1)?.role === 'user' ? 0 : 1),...(active ? { activeChunkBytes:chunkBytes(migrateMessages(active.data().messages ?? [])) } : {}) });
  });
  metadataReady.add(key);
}

// The session transaction assigns a unique order and appends to one bounded
// chunk. Only the session document is read on each new message.
export async function addMessage(sessionId, message, opts = {}) {
  const owner = currentUid();
  await ensureContinuityMetadata(sessionId);
  const tokenCount = await countTokens(contextText(message));
  if (owner !== currentUid()) throw new Error('Account changed; message was not saved.');
  const id = opts.id ?? newMsgId();
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(sessionRef(sessionId, owner));
    assertStory(snap.data());
    const data = assertStory(snap.data());
    if (message.role === 'assistant') assertReplySource(data,opts.expectedSource);
    else assertSource(data,opts.expectedSource);
    if(opts.signal?.aborted)throw Object.assign(new Error('Summary stopped; checkpoint was not changed.'),{name:'AbortError'});
    const order = (data.nextOrder ?? 0) + 1;
    const item = makeMessage(id, order, { ...message,...(message.role !== "summary" ? { narratorTurn:data.nextNarratorTurn ?? 1 } : {}) }, tokenCount);
    const size = messageBytes(item);
    packMessages([item]); // validates an oversized single reply
    const append = data.activeChunkId && data.activeChunkCount < MAX_MESSAGES_PER_CHUNK &&
      data.activeChunkBytes + size <= TARGET_CHUNK_BYTES;
    const activeId = append ? data.activeChunkId : chunkId(order);
    const bytes = append ? data.activeChunkBytes + size : chunkBytes([item]);
    const count = append ? data.activeChunkCount + 1 : 1;
    if(!append && (await tx.get(chunkRef(sessionId,activeId,owner))).exists())throw new Error('The next message chunk already exists. Refresh the story before sending.');
    if(opts.signal?.aborted)throw Object.assign(new Error('Summary stopped; checkpoint was not changed.'),{name:'AbortError'});
    tx.update(sessionRef(sessionId, owner), {
      nextOrder: order,
      historyRevision:(data.historyRevision ?? 0)+1,
      nextNarratorTurn:(data.nextNarratorTurn ?? 1)+(message.role === "assistant" ? 1 : 0),
      updatedAt: serverTimestamp(),
      activeChunkId: activeId,
      activeChunkBytes: bytes,
      activeChunkCount: count,
      ...(opts.sessionUpdate ?? {}),
    });
    if (append) {
      tx.update(chunkRef(sessionId, activeId, owner), {
        messages: arrayUnion(item), lastOrder: order, byteSize: bytes, count,
      });
    } else {
      tx.set(chunkRef(sessionId, activeId, owner), chunkRecord([item]));
    }
    return {message:{...item,historyRevision:(data.historyRevision ?? 0)+1},...item,historyRevision:(data.historyRevision ?? 0)+1,session:{id:sessionId,...data,nextOrder:order,historyRevision:(data.historyRevision ?? 0)+1,nextNarratorTurn:(data.nextNarratorTurn ?? 1)+(message.role==='assistant' ? 1 : 0),activeChunkId:activeId,activeChunkBytes:bytes,activeChunkCount:count,...(opts.sessionUpdate ?? {})}};
  });
}

// Imports begin with a new empty session. Write all chunks, then expose the
// final order counter so an interrupted import can be retried safely.
export async function addMessagesBulk(sessionId, items) {
  if (!items.length) return [];
  await ensureChunked(sessionId);
  const snap = await getDocFromServer(sessionRef(sessionId));
  assertStory(snap.data());
  if (snap.data().nextOrder) {
    const results = [];
    for (const item of items) results.push(await addMessage(sessionId, item));
    return results;
  }
  const counts = await Promise.all(items.map((item) => countTokens(item.content)));
  const messages = items.map((item,index) => makeMessage(item.id ?? newMsgId(),item.order ?? index+1,item,counts[index]));
  if (new Set(messages.map(m => m.id)).size !== messages.length || messages.some((m,i) => !Number.isSafeInteger(m.order) || m.order < 1 || i > 0 && m.order <= messages[i-1].order)) throw new Error('Imported message IDs and orders must be unique and ordered.');
  const turns = computeTurns(messages);
  for (const m of messages) if (m.role !== 'summary') m.narratorTurn ??= turns.turnById.get(m.id);
  const groups = packMessages(messages);
  await writePackedChunks(sessionId, groups);
  const last = groups.at(-1);
  await runTransaction(db,async tx=>{
    assertStory((await tx.get(sessionRef(sessionId))).data());
    tx.update(sessionRef(sessionId), {
    nextOrder: messages.at(-1).order,
    historyRevision:(snap.data().historyRevision ?? 0)+1,continuityVersion:2,
    nextNarratorTurn:Math.max(0,maxOf(messages.map(m => m.narratorTurn ?? 0)))+(messages.at(-1)?.role === "user" ? 0 : 1),
    updatedAt: serverTimestamp(),
    activeChunkId: chunkId(last[0].order),
    activeChunkBytes: chunkBytes(last),
    activeChunkCount: last.length,
    });
  });
  return messages.map(({ id, order, tokenCount }) => ({ id, order, tokenCount }));
}

function flatten(snap) {
  return snap.docs.flatMap((d) => d.data().messages ?? []).sort((a, b) => a.order - b.order);
}

export async function getMessages(sessionId) {
  await ensureChunked(sessionId);
  return flatten(await getDocsFromServer(query(chunksCol(sessionId), orderBy("firstOrder", "asc"))));
}

// Server discovery runs before retrying a potentially committed save.
export async function findSavedMessage(sessionId,messageId,minOrder,{overwrite=false}={}) {
  const constraints=overwrite && Number.isFinite(minOrder)
    ? [where('firstOrder','<=',minOrder),orderBy('firstOrder','desc'),limit(1)]
    : Number.isFinite(minOrder)
      ? [where('lastOrder','>=',minOrder),orderBy('lastOrder','asc')]
      : [orderBy('firstOrder','asc'),limitToLast(3)];
  const snap=await getDocsFromServer(query(chunksCol(sessionId),...constraints));
  return flatten(snap).find(message=>message.id===messageId) ?? null;
}

export async function getMessagesAfterOrder(sessionId, breakpointOrder) {
  await ensureChunked(sessionId);
  const snap = await getDocsFromServer(query(
    chunksCol(sessionId), where("lastOrder", ">", breakpointOrder), orderBy("lastOrder", "asc")
  ));
  return flatten(snap).filter((message) => message.order > breakpointOrder);
}

export async function getCheckpointMessages(session) {
  if (!session.activeSummaryMessageId) return getMessages(session.id);
  const recent = await getMessagesAfterOrder(session.id, session.breakpointOrder ?? 0);
  return recent.some((message) => message.id === session.activeSummaryMessageId)
    ? recent : getMessages(session.id);
}

export async function getEarlierMessages(sessionId, beforeOrder, pageSize) {
  await ensureChunked(sessionId);
  let cursor = null;
  const found = [];
  while (found.length < pageSize) {
    const constraints = [where("firstOrder", "<", beforeOrder), orderBy("firstOrder", "desc")];
    if (cursor) constraints.push(startAfter(cursor));
    constraints.push(limit(10));
    const snap = await getDocsFromServer(query(chunksCol(sessionId), ...constraints));
    for (const d of snap.docs) {
      found.push(...(d.data().messages ?? []).filter((m) => m.order < beforeOrder));
    }
    if (snap.empty || snap.docs.length < 10) break;
    cursor = snap.docs.at(-1);
  }
  return found.sort((a, b) => a.order - b.order).slice(-pageSize);
}

export function subscribeLatestMessages(sessionId, callback, onError) {
  let closed = false;
  let unsubscribe = null;
  ensureChunked(sessionId).then(() => {
    if (closed) return;
    unsubscribe = onSnapshot(
      query(chunksCol(sessionId), orderBy("firstOrder", "asc"), limitToLast(3)),
      (snap) => callback({
        messages: flatten(snap),
        hasEarlier: snap.docs.length > 0 && snap.docs[0].data().firstOrder > 1,
      }),
      onError
    );
  }).catch((error) => { if (!closed) onError?.(error); });
  return () => { closed = true; unsubscribe?.(); };
}

export async function getMessage(sessionId, messageId) {
  return (await getMessages(sessionId)).find((message) => message.id === messageId) ?? null;
}

async function findChunk(sessionId, messageId, order) {
  const snap = await getDocsFromServer(query(
    chunksCol(sessionId), where("firstOrder", "<=", order), orderBy("firstOrder", "desc"), limit(1)
  ));
  const chunk = snap.docs[0];
  if (!chunk || chunk.data().lastOrder < order ||
      !chunk.data().messages.some((message) => message.id === messageId)) {
    throw new Error("Message not found.");
  }
  return chunk;
}

async function changeMessage(sessionId, messageId, order, change, sessionUpdate = {}, expectedSource = null, requireLatestReply = false, deletingMessage = false) {
  const owner = currentUid();
  await ensureContinuityMetadata(sessionId);
  const target = sessionRef(sessionId,owner);
  // Older direct callers omit expectedSource. Capture a revision before the
  // discovery query so the transaction cannot trust a stale chunk list.
  if (requireLatestReply && !expectedSource) {
    const source = await getDocFromServer(target);
    assertStory(source.data());
    expectedSource = { historyRevision:source.data().historyRevision ?? 0 };
  }
  let old;
  try { old = await findChunk(sessionId,messageId,order); }
  catch (error) {
    if (requireLatestReply && error.message === 'Message not found.') throw new HistoryConflict('This reply was deleted. Copy the generated text or save it at the end.');
    throw error;
  }
  const deletingAssistant = deletingMessage && old.data().messages.find(m => m.id === messageId)?.role === 'assistant';
  let summaryChunks = null;
  {
    const source = await getDocFromServer(target),session = assertStory(source.data());

    const current = old.data().messages.find(m => m.id === messageId);
    if (current.role!=='summary' || current.id===session.activeSummaryMessageId) {
      // Discover documents before the transaction, then guard the revision and
      // reread every candidate chunk inside it before selecting a fallback.
      const all = await getDocsFromServer(query(chunksCol(sessionId,owner),orderBy('firstOrder','asc')));
      summaryChunks = all.docs.filter(chunk => (chunk.data().messages ?? []).some(m => m.role === 'summary' && !m.retired));
      expectedSource ??= {...(summaryChunks.length || session.activeSummaryMessageId ? {historyRevision:session.historyRevision ?? 0} : {}),activeSummaryMessageId:session.activeSummaryMessageId ?? null,breakpointOrder:session.breakpointOrder ?? 0};
    }
  }
  const later = requireLatestReply || deletingAssistant ? await getDocsFromServer(query(chunksCol(sessionId,owner), where('lastOrder','>',order), orderBy('lastOrder','asc'))) : null;
  if (owner !== currentUid()) throw new Error("Account changed; edit was cancelled.");
  return runTransaction(db,async tx => {
    const sessionSnap = await tx.get(target), chunkSnap = await tx.get(chunkRef(sessionId,old.id,owner));
    const data = assertStory(sessionSnap.data()), previous = chunkSnap.data();
    const freshChunks = new Map([[old.id,previous]]);
    if (summaryChunks?.length && expectedSource && (data.historyRevision ?? 0) !== expectedSource.historyRevision) throw new HistoryConflict('Story changed while finding earlier summaries. Try this change again.');
    if (requireLatestReply) assertReplySource(data,expectedSource);
    else assertSource(data,expectedSource);
    const current = previous?.messages?.find(m => m.id === messageId);
    if (!current) throw requireLatestReply ? new HistoryConflict('This reply was deleted.') : new Error('Message not found.');
    let resetNarratorTurn = false;
    if (requireLatestReply || deletingAssistant) {
      const chunks = [previous];
      for (const candidate of later.docs) if (candidate.id !== old.id) {
        const fresh = await tx.get(chunkRef(sessionId,candidate.id,owner));
        if (fresh.exists()) { chunks.push(fresh.data()); freshChunks.set(candidate.id,fresh.data()); }
      }
      if (requireLatestReply && (current.role !== 'assistant' || chunks.some(chunk => (chunk.messages ?? []).some(m => m.role !== 'summary' && m.order > current.order)))) throw new HistoryConflict('Newer story messages exist. Copy this reply or save it at the end.');
      resetNarratorTurn = deletingAssistant && current.role === 'assistant' && !chunks.some(chunk => (chunk.messages ?? []).some(m => ['assistant','user'].includes(m.role) && m.order > current.order));
    }
    const changed=await change(current),contentChanged=!changed || changed.content!==current.content || canonicalScene(changed.scene)!==canonicalScene(current.scene) || JSON.stringify(changed.sceneMeta ?? null)!==JSON.stringify(current.sceneMeta ?? null);
    const replacement=changed ? {...changed,revision:revisionOf(current)+(contentChanged ? 1 : 0)} : null;
    const updated = previous.messages.flatMap(m => m.id === messageId ? (replacement ? [replacement] : []) : [m]);
    const groups = packMessages(updated);
    const records = groups.length ? groups.map((group,index) => ({ id:index === 0 ? old.id : chunkId(group[0].order),data:chunkRecord(group,index === 0 ? previous.firstOrder : group[0].order,index === groups.length-1 ? previous.lastOrder : group.at(-1).order) })) : [{ id:old.id,data:{ ...previous,messages:[],count:0,byteSize:chunkBytes([]) } }];
    const summaryReset=!!data.activeSummaryMessageId && contentChanged && (current.role!=='summary' && order<=(data.breakpointOrder ?? 0) || !replacement && current.id===data.activeSummaryMessageId);
    let fallback = null;
    if(contentChanged && current.role!=='summary' && summaryChunks)for(const candidate of summaryChunks)if(!freshChunks.has(candidate.id)){const fresh=await tx.get(chunkRef(sessionId,candidate.id,owner));if(fresh.exists())freshChunks.set(candidate.id,fresh.data());}
    if (summaryReset) {
      if (!summaryChunks) throw new HistoryConflict('The summary checkpoint changed. Try this change again.');
      for (const candidate of summaryChunks) if (!freshChunks.has(candidate.id)) {
        const fresh = await tx.get(chunkRef(sessionId,candidate.id,owner));
        if (fresh.exists()) freshChunks.set(candidate.id,fresh.data());
      }
      const candidates = [...freshChunks.values()].flatMap(chunk => chunk?.messages ?? []).filter(m => {
        const cutoff = m.coveredRange?.toOrder ?? m.coveredRange?.to;
        const start = m.coveredRange?.fromOrder ?? m.coveredRange?.from;
        return m.role === 'summary' && !m.retired && m.id !== messageId && m.content?.trim() && Number.isSafeInteger(cutoff) && cutoff > 0 && cutoff < order && cutoff < m.order && (start == null || Number.isSafeInteger(start) && start >= 0 && start <= cutoff);
      });
      fallback = candidates.sort((a,b) => b.order-a.order)[0] ?? null;
    }
    const historyRevision = (data.historyRevision ?? 0)+1;
    const patch = { historyRevision,updatedAt:serverTimestamp(),...(resetNarratorTurn ? {nextNarratorTurn:current.narratorTurn} : {}),...(summaryReset ? { activeSummaryMessageId:fallback?.id ?? null,breakpointOrder:fallback?.coveredRange?.toOrder ?? fallback?.coveredRange?.to ?? 0 } : {}),...sessionUpdate };
    const pointer=data.memoryState?.extractedThroughOrder;
    if(contentChanged && current.role!=='summary' && pointer!=null) {
      const edits=[...(data.contentEdits ?? []),{order,revision:historyRevision}];
      patch.contentEdits=edits.slice(-20);
      if(edits.length>20)patch.contentEditsFloor=Math.max(data.contentEditsFloor ?? 0,...edits.slice(0,-20).map(e=>e.revision));
      if(order<=pointer) {
        patch.memoryInvalidations=trimInvalidations([...(data.memoryInvalidations ?? []),{fromOrder:order,toOrder:pointer,revision:historyRevision}]);
        patch['memoryState.needsRebuild']=true;
        patch['memoryState.rebuildFromOrder']=Math.min(data.memoryState?.rebuildFromOrder ?? Infinity,order);
      }
    }
    if (data.activeChunkId === old.id) { const active = records.at(-1); Object.assign(patch,{ activeChunkId:active.id,activeChunkBytes:active.data.byteSize,activeChunkCount:active.data.count }); }
    if (summaryReset || contentChanged && current.role!=='summary') {
      const retiredId=summaryReset ? data.activeSummaryMessageId : null;
      const retire=m=>m.role==='summary' && (m.id===retiredId || (m.coveredRange?.toOrder ?? m.coveredRange?.to ?? Infinity)>=order);
      for (const [id,chunk] of freshChunks) {
        if (!chunk?.messages?.some(retire)) continue;
        const record=records.find(r=>r.id===id);
        if(record) record.data=chunkRecord(record.data.messages.map(m=>retire(m) ? {...m,retired:true} : m),record.data.firstOrder,record.data.lastOrder);
        else tx.set(chunkRef(sessionId,id,owner),chunkRecord(chunk.messages.map(m=>retire(m) ? {...m,retired:true} : m),chunk.firstOrder,chunk.lastOrder));
      }
    }
    for (const record of records) tx.set(chunkRef(sessionId,record.id,owner),record.data);
    tx.update(target,patch);
    const after={id:sessionId,...data};
    for(const [key,value] of Object.entries(patch)) {if(key==='updatedAt')continue;if(key.startsWith('memoryState.'))after.memoryState={...after.memoryState,[key.slice(12)]:value};else after[key]=value;}
    return {session:after,replacement,summaryReset,historyRevision,memoryInvalidations:patch.memoryInvalidations,memoryStatePatch:Object.fromEntries(Object.entries(patch).filter(([k])=>k.startsWith('memoryState.')).map(([k,v])=>[k.slice(12),v])) };
  });
}

export async function editMessage(sessionId, messageId, content, order, metadata = {}) {
  const { expectedRevision,...replacementMetadata } = metadata;
  const tokenCount = await countTokens(content);
  const result = await changeMessage(sessionId, messageId, order, (message) => { if (expectedRevision != null && revisionOf(message) !== expectedRevision) throw new Error('This message was edited elsewhere. Reopen it before saving.'); return { ...message,content,lastContinuation:null,truncated:false,...(message.acceptance==='pending' ? {scene:message.sceneCandidate?.scene ?? message.scene,sceneMeta:message.sceneCandidate?.sceneMeta ?? message.sceneMeta,sceneCandidate:null,acceptance:'accepted'} : {}),reviewWarnings:[],...replacementMetadata,tokenCount,editedAt:Timestamp.now() }; });
  return { tokenCount,...result };
}

export async function overwriteMessage(sessionId, messageId, { content, thinking, planThread = null, planBefore = null, scene = null, ooc = false,sceneMeta = null,sceneCandidate = null,acceptance,reviewWarnings = [],truncated = false,lastContinuation = null,responseDiagnostics = null }, order, sessionUpdate = {}, expectedSource = null) {
  const tokenCount = await countTokens(contextText({ content, planThread }));
  const result = await changeMessage(sessionId,messageId,order,message => {
    const {editedAt,acceptance:oldAcceptance,reviewWarnings:oldWarnings,sceneCandidate:oldCandidate,truncated:oldTruncated,...rest}=message;
    return {...rest,lastContinuation,responseDiagnostics,content,thinking:thinking ?? null,planThread,planBefore,scene,ooc,tokenCount,sceneMeta,
      ...(acceptance!==undefined ? {acceptance,reviewWarnings,sceneCandidate} : {}),...(truncated || oldTruncated ? {truncated} : {})};
  },sessionUpdate,expectedSource,true);
  return { tokenCount,...result };
}

export async function deleteMessage(sessionId, messageId, order) {
  return changeMessage(sessionId, messageId, order, () => null, {}, null, false, true);
}

export async function updateMessageScene(sessionId, messageId, order, scene, prior = null) {
  if (String(scene ?? '').length > 2000) throw new Error('The scene line exceeds 2000 characters. Shorten it before saving.');
  const raw = scene?.trim() ? canonicalScene(scene) : null;
  if (scene?.trim() && !raw) throw new Error('Could not read that scene. Use: date: … · time: … · place: … · present: …');
  return changeMessage(sessionId, messageId, order, message => ({ ...message,lastContinuation:null, scene:raw,sceneMeta:raw ? {kind:'manual',stale:false} : {kind:'carried',stale:true,fromId:prior?.fromId ?? null,fromOrder:prior?.fromOrder ?? null},sceneCandidate:null }));
}

export function acceptMessage(sessionId,messageId,order,expectedRevision) {
  return changeMessage(sessionId,messageId,order,message => {
    if (revisionOf(message) !== expectedRevision) throw new Error('This reply changed. Review it again before accepting.');
    return { ...message,acceptance:'accepted',reviewWarnings:[],
      ...(message.sceneCandidate ? { scene:message.sceneCandidate.scene,sceneMeta:message.sceneCandidate.sceneMeta } : {}),sceneCandidate:null };
  });
}
