import { computeTurns } from './turns.js';
import { canonicalScene } from './scene.js';
import { assertSource, revisionOf } from './continuity.js';
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
    const batch = writeBatch(db);
    for (const group of groups.slice(i, i + 6)) {
      batch.set(chunkRef(sessionId, chunkId(group[0].order), owner), chunkRecord(group));
    }
    await batch.commit();
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
    if (!sessionSnap.exists()) throw new Error("Session not found.");
    if (sessionSnap.data().storageVersion !== 2) {
      const old = await getDocsFromServer(query(legacyMessagesCol(sessionId, owner), orderBy("order", "asc")));
      const messages = old.docs.map((d) => ({ id: d.id, ...d.data() }));
      const groups = packMessages(messages);
      await writePackedChunks(sessionId, groups, owner);
      const last = groups.at(-1);
      await updateDoc(sessionRef(sessionId, owner), {
        storageVersion: 2,
        nextOrder: Math.max(sessionSnap.data().nextOrder ?? 0, messages.at(-1)?.order ?? 0),
        activeChunkId: last ? chunkId(last[0].order) : null,
        activeChunkBytes: last ? chunkBytes(last) : 0,
        activeChunkCount: last?.length ?? 0,
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
  if (snap.data().continuityVersion === 2) { metadataReady.add(key); return; }
  const chunks = await getDocsFromServer(query(chunksCol(sessionId, owner),orderBy('firstOrder','asc')));
  const source = flatten(chunks), turns = computeTurns(source), ids = chunks.docs.map(d => d.id);
  await runTransaction(db,async tx => {
    const sessionSnap = await tx.get(target);
    const fresh = []; for (const id of ids) fresh.push(await tx.get(chunkRef(sessionId,id, owner)));
    if ((sessionSnap.data().historyRevision ?? 0) !== (snap.data().historyRevision ?? 0) || sessionSnap.data().nextOrder !== snap.data().nextOrder) throw new Error('History changed during migration; try again.');
    for (const chunk of fresh) {
      const data = chunk.data(), messages = data.messages.map(m => ({ ...m,revision:m.revision ?? 0,...(m.role !== 'summary' ? { narratorTurn:m.narratorTurn ?? turns.turnById.get(m.id) } : {}) }));
      tx.update(chunkRef(sessionId,chunk.id, owner),{ messages,byteSize:chunkBytes(messages) });
    }
    tx.update(target,{ continuityVersion:2,historyRevision:sessionSnap.data().historyRevision ?? 0,nextNarratorTurn:Math.max(0,...source.map(m => m.narratorTurn ?? turns.turnById.get(m.id) ?? 0))+ (source.at(-1)?.role === 'user' ? 0 : 1),...(sessionSnap.data().activeChunkId ? { activeChunkBytes:chunkBytes((fresh.find(d => d.id === sessionSnap.data().activeChunkId)?.data().messages ?? []).map(m => ({ ...m,revision:m.revision ?? 0,...(m.role !== 'summary' ? { narratorTurn:m.narratorTurn ?? turns.turnById.get(m.id) } : {}) }))) } : {}) });
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
    if (!snap.exists()) throw new Error("Session not found.");
    const data = snap.data();
    assertSource(data,opts.expectedSource);
    const order = (data.nextOrder ?? 0) + 1;
    const item = makeMessage(id, order, { ...message,...(message.role !== "summary" ? { narratorTurn:data.nextNarratorTurn ?? 1 } : {}) }, tokenCount);
    const size = messageBytes(item);
    packMessages([item]); // validates an oversized single reply
    const append = data.activeChunkId && data.activeChunkCount < MAX_MESSAGES_PER_CHUNK &&
      data.activeChunkBytes + size <= TARGET_CHUNK_BYTES;
    const activeId = append ? data.activeChunkId : chunkId(order);
    const bytes = append ? data.activeChunkBytes + size : chunkBytes([item]);
    const count = append ? data.activeChunkCount + 1 : 1;
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
    return { ...item,historyRevision:(data.historyRevision ?? 0)+1 };
  });
}

// Imports begin with a new empty session. Write all chunks, then expose the
// final order counter so an interrupted import can be retried safely.
export async function addMessagesBulk(sessionId, items) {
  if (!items.length) return [];
  await ensureChunked(sessionId);
  const snap = await getDocFromServer(sessionRef(sessionId));
  if (!snap.exists()) throw new Error("Session not found.");
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
  await updateDoc(sessionRef(sessionId), {
    nextOrder: messages.at(-1).order,
    historyRevision:(snap.data().historyRevision ?? 0)+1,continuityVersion:2,
    nextNarratorTurn:Math.max(0,...messages.map(m => m.narratorTurn ?? 0))+(messages.at(-1)?.role === "user" ? 0 : 1),
    updatedAt: serverTimestamp(),
    activeChunkId: chunkId(last[0].order),
    activeChunkBytes: chunkBytes(last),
    activeChunkCount: last.length,
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

async function changeMessage(sessionId, messageId, order, change, sessionUpdate = {}, expectedSource = null) {
  const owner = currentUid();
  await ensureContinuityMetadata(sessionId);
  const old = await findChunk(sessionId,messageId,order), target = sessionRef(sessionId,owner);
  if (owner !== currentUid()) throw new Error("Account changed; edit was cancelled.");
  return runTransaction(db,async tx => {
    const sessionSnap = await tx.get(target), chunkSnap = await tx.get(chunkRef(sessionId,old.id,owner));
    const data = sessionSnap.data(), previous = chunkSnap.data();
    assertSource(data,expectedSource);
    const current = previous.messages.find(m => m.id === messageId);
    if (!current) throw new Error('Message not found.');
    const changed = await change(current), replacement = changed ? { ...changed,revision:revisionOf(current)+1 } : null;
    const updated = previous.messages.flatMap(m => m.id === messageId ? (replacement ? [replacement] : []) : [m]);
    const groups = packMessages(updated);
    const records = groups.length ? groups.map((group,index) => ({ id:index === 0 ? old.id : chunkId(group[0].order),data:chunkRecord(group,index === 0 ? previous.firstOrder : group[0].order,index === groups.length-1 ? previous.lastOrder : group.at(-1).order) })) : [{ id:old.id,data:{ ...previous,messages:[],count:0,byteSize:chunkBytes([]) } }];
    const summaryReset = !!data.activeSummaryMessageId && (current.role !== 'summary' && order <= (data.breakpointOrder ?? 0) || current.id === data.activeSummaryMessageId);
    const historyRevision = (data.historyRevision ?? 0)+1;
    const patch = { historyRevision,updatedAt:serverTimestamp(),...(summaryReset ? { activeSummaryMessageId:null,breakpointOrder:0 } : {}),...sessionUpdate };
    if (current.role !== 'summary') {
      patch.memoryInvalidations = [...(data.memoryInvalidations ?? []),{ fromOrder:order,revision:historyRevision }];
      patch['memoryState.needsRebuild'] = true;
      patch['memoryState.paused'] = true;
      patch['memoryState.lastError'] = 'History changed; affected notes need review. Rebuild explicitly.';
    }
    if (data.activeChunkId === old.id) { const active = records.at(-1); Object.assign(patch,{ activeChunkId:active.id,activeChunkBytes:active.data.byteSize,activeChunkCount:active.data.count }); }
    for (const record of records) tx.set(chunkRef(sessionId,record.id,owner),record.data);
    tx.update(target,patch);
    return { replacement,summaryReset,historyRevision,memoryInvalidations:patch.memoryInvalidations };
  });
}

export async function editMessage(sessionId, messageId, content, order, metadata = {}) {
  const { expectedRevision,...replacementMetadata } = metadata;
  const tokenCount = await countTokens(content);
  const result = await changeMessage(sessionId, messageId, order, (message) => { if (expectedRevision != null && revisionOf(message) !== expectedRevision) throw new Error('This message was edited elsewhere. Reopen it before saving.'); return { ...message,content,truncated:false,...(message.acceptance==='pending' ? {scene:message.sceneCandidate?.scene ?? message.scene,sceneMeta:message.sceneCandidate?.sceneMeta ?? message.sceneMeta,sceneCandidate:null,acceptance:'accepted'} : {}),reviewWarnings:[],...replacementMetadata,tokenCount,editedAt:Timestamp.now() }; });
  return { tokenCount,...result };
}

export async function overwriteMessage(sessionId, messageId, { content, thinking, planThread = null, planBefore = null, scene = null, ooc = false,sceneMeta = null,sceneCandidate = null,acceptance,reviewWarnings = [],truncated = false }, order, sessionUpdate = {}, expectedSource = null) {
  const tokenCount = await countTokens(contextText({ content, planThread }));
  const result = await changeMessage(sessionId,messageId,order,message => {
    const {editedAt,acceptance:oldAcceptance,reviewWarnings:oldWarnings,sceneCandidate:oldCandidate,truncated:oldTruncated,...rest}=message;
    return {...rest,content,thinking:thinking ?? null,planThread,planBefore,scene,ooc,tokenCount,sceneMeta,
      ...(acceptance!==undefined ? {acceptance,reviewWarnings,sceneCandidate} : {}),truncated};
  },sessionUpdate,expectedSource);
  return { tokenCount,...result };
}

export async function deleteMessage(sessionId, messageId, order) {
  return changeMessage(sessionId, messageId, order, () => null);
}

export async function updateMessageScene(sessionId, messageId, order, scene, prior = null) {
  if (String(scene ?? '').length > 2000) throw new Error('The scene line exceeds 2000 characters. Shorten it before saving.');
  const raw = scene?.trim() ? canonicalScene(scene) : null;
  if (scene?.trim() && !raw) throw new Error('Could not read that scene. Use: date: … · time: … · place: … · present: …');
  return changeMessage(sessionId, messageId, order, message => ({ ...message, scene:raw,sceneMeta:raw ? {kind:'manual',stale:false} : {kind:'carried',stale:true,fromId:prior?.fromId ?? null,fromOrder:prior?.fromOrder ?? null},sceneCandidate:null }));
}

export function acceptMessage(sessionId,messageId,order,expectedRevision) {
  return changeMessage(sessionId,messageId,order,message => {
    if (revisionOf(message) !== expectedRevision) throw new Error('This reply changed. Review it again before accepting.');
    return { ...message,acceptance:'accepted',reviewWarnings:[],
      ...(message.sceneCandidate ? { scene:message.sceneCandidate.scene,sceneMeta:message.sceneCandidate.sceneMeta } : {}),sceneCandidate:null };
  });
}
