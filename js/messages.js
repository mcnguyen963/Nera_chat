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

function sessionRef(sessionId) {
  return doc(db, "users", currentUid(), "sessions", sessionId);
}
function legacyMessagesCol(sessionId) {
  return collection(db, "users", currentUid(), "sessions", sessionId, "messages");
}
function chunksCol(sessionId) {
  return collection(db, "users", currentUid(), "sessions", sessionId, "messageChunks");
}
function chunkRef(sessionId, id) {
  return doc(db, "users", currentUid(), "sessions", sessionId, "messageChunks", id);
}

function newMsgId() {
  return "msg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
export const newMessageId = newMsgId;

function makeMessage(id, order, { role, content, thinking = null }, tokenCount) {
  return { id, order, role, content, thinking, tokenCount, createdAt: Timestamp.now(), editedAt: null };
}

const readySessions = new Set();
const migrations = new Map();

async function writePackedChunks(sessionId, groups) {
  // Six worst-case oversized chunks stay below Firestore's 10 MiB request cap.
  for (let i = 0; i < groups.length; i += 6) {
    const batch = writeBatch(db);
    for (const group of groups.slice(i, i + 6)) {
      batch.set(chunkRef(sessionId, chunkId(group[0].order)), chunkRecord(group));
    }
    await batch.commit();
  }
}

// Legacy message documents remain untouched. Chunk writes finish before the
// session marker changes, so an interrupted migration can safely run again.
export function ensureChunked(sessionId) {
  if (readySessions.has(sessionId)) return Promise.resolve();
  if (migrations.has(sessionId)) return migrations.get(sessionId);
  const pending = (async () => {
    const sessionSnap = await getDocFromServer(sessionRef(sessionId));
    if (!sessionSnap.exists()) throw new Error("Session not found.");
    if (sessionSnap.data().storageVersion !== 2) {
      const old = await getDocsFromServer(query(legacyMessagesCol(sessionId), orderBy("order", "asc")));
      const messages = old.docs.map((d) => ({ id: d.id, ...d.data() }));
      const groups = packMessages(messages);
      await writePackedChunks(sessionId, groups);
      const last = groups.at(-1);
      await updateDoc(sessionRef(sessionId), {
        storageVersion: 2,
        nextOrder: Math.max(sessionSnap.data().nextOrder ?? 0, messages.at(-1)?.order ?? 0),
        activeChunkId: last ? chunkId(last[0].order) : null,
        activeChunkBytes: last ? chunkBytes(last) : 0,
        activeChunkCount: last?.length ?? 0,
      });
    }
    readySessions.add(sessionId);
  })().finally(() => migrations.delete(sessionId));
  migrations.set(sessionId, pending);
  return pending;
}

// The session transaction assigns a unique order and appends to one bounded
// chunk. Only the session document is read on each new message.
export async function addMessage(sessionId, message, opts = {}) {
  await ensureChunked(sessionId);
  const tokenCount = await countTokens(message.content);
  const id = opts.id ?? newMsgId();
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(sessionRef(sessionId));
    if (!snap.exists()) throw new Error("Session not found.");
    const data = snap.data();
    const order = (data.nextOrder ?? 0) + 1;
    const item = makeMessage(id, order, message, tokenCount);
    const size = messageBytes(item);
    packMessages([item]); // validates an oversized single reply
    const append = data.activeChunkId && data.activeChunkCount < MAX_MESSAGES_PER_CHUNK &&
      data.activeChunkBytes + size <= TARGET_CHUNK_BYTES;
    const activeId = append ? data.activeChunkId : chunkId(order);
    const bytes = append ? data.activeChunkBytes + size : chunkBytes([item]);
    const count = append ? data.activeChunkCount + 1 : 1;
    tx.update(sessionRef(sessionId), {
      nextOrder: order,
      updatedAt: serverTimestamp(),
      activeChunkId: activeId,
      activeChunkBytes: bytes,
      activeChunkCount: count,
      ...(opts.sessionUpdate ?? {}),
    });
    if (append) {
      tx.update(chunkRef(sessionId, activeId), {
        messages: arrayUnion(item), lastOrder: order, byteSize: bytes, count,
      });
    } else {
      tx.set(chunkRef(sessionId, activeId), chunkRecord([item]));
    }
    return { id, order, tokenCount };
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
  const messages = items.map((item, index) =>
    makeMessage(newMsgId(), index + 1, item, counts[index])
  );
  const groups = packMessages(messages);
  await writePackedChunks(sessionId, groups);
  const last = groups.at(-1);
  await updateDoc(sessionRef(sessionId), {
    nextOrder: messages.length,
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

async function changeMessage(sessionId, messageId, order, change) {
  await ensureChunked(sessionId);
  const old = await findChunk(sessionId, messageId, order);
  const previous = old.data();
  const current = previous.messages.find((message) => message.id === messageId);
  const replacement = await change(current);
  const updated = previous.messages.flatMap((message) =>
    message.id === messageId ? (replacement ? [replacement] : []) : [message]
  );
  const groups = packMessages(updated);
  const records = groups.length
    ? groups.map((group, index) => ({
      id: index === 0 ? old.id : chunkId(group[0].order),
      data: chunkRecord(
        group,
        index === 0 ? previous.firstOrder : group[0].order,
        index === groups.length - 1 ? previous.lastOrder : group.at(-1).order
      ),
    }))
    : [{ id: old.id, data: { ...previous, messages: [], count: 0, byteSize: chunkBytes([]) } }];
  const batch = writeBatch(db);
  for (const record of records) batch.set(chunkRef(sessionId, record.id), record.data);
  const sessionSnap = await getDocFromServer(sessionRef(sessionId));
  if (sessionSnap.data()?.activeChunkId === old.id) {
    const active = records.at(-1);
    batch.update(sessionRef(sessionId), {
      activeChunkId: active.id,
      activeChunkBytes: active.data.byteSize,
      activeChunkCount: active.data.count,
    });
  }
  await batch.commit();
  return replacement;
}

export async function editMessage(sessionId, messageId, content, order) {
  const tokenCount = await countTokens(content);
  await changeMessage(sessionId, messageId, order, (message) => ({
    ...message, content, tokenCount, editedAt: Timestamp.now(),
  }));
  return { tokenCount };
}

export async function overwriteMessage(sessionId, messageId, { content, thinking }, order) {
  const tokenCount = await countTokens(content);
  await changeMessage(sessionId, messageId, order, (message) => ({
    ...message, content, thinking: thinking ?? null, tokenCount,
  }));
  return { tokenCount };
}

export async function deleteMessage(sessionId, messageId, order) {
  await changeMessage(sessionId, messageId, order, () => null);
}
