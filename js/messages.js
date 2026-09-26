import {
  doc, getDoc, getDocs, query, orderBy, updateDoc, deleteDoc,
  collection, runTransaction, writeBatch, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";
import { currentUid } from "./auth.js";
import { countTokens } from "./tokenizer.js";

// Message paths are scoped to the signed-in user: users/{uid}/sessions/{id}/messages/...

function msgRef(sessionId, messageId) {
  return doc(db, "users", currentUid(), "sessions", sessionId, "messages", messageId);
}
function msgsCol(sessionId) {
  return collection(db, "users", currentUid(), "sessions", sessionId, "messages");
}
function sessionRef(sessionId) {
  return doc(db, "users", currentUid(), "sessions", sessionId);
}

function newMsgId() {
  return "msg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Exported so callers that need the message id BEFORE the write (e.g. summarization
// folding the summary pointer into the same transaction) can pre-generate one.
export const newMessageId = newMsgId;

function msgDoc({ role, content, thinking, tokenCount, order }) {
  return {
    role,
    content,
    thinking: thinking ?? null,
    tokenCount,
    order,
    createdAt: serverTimestamp(),
    editedAt: null,
  };
}

// Adds one message. `order` comes transactionally from the session doc's `nextOrder`
// counter (spec §2). `opts.sessionUpdate` folds extra session fields (e.g. summary
// pointer) into the SAME transaction, saving a separate write.
export async function addMessage(sessionId, { role, content, thinking = null }, opts = {}) {
  const tokenCount = await countTokens(content);
  const msgId = opts.id ?? newMsgId();
  const sessionDocRef = sessionRef(sessionId);
  const messageRef = msgRef(sessionId, msgId);

  const order = await runTransaction(db, async (tx) => {
    const snap = await tx.get(sessionDocRef);
    const next = (snap.data()?.nextOrder ?? 0) + 1;
    tx.update(sessionDocRef, {
      nextOrder: next,
      updatedAt: serverTimestamp(),
      ...(opts.sessionUpdate ?? {}),
    });
    tx.set(messageRef, msgDoc({ role, content, thinking, tokenCount, order: next }));
    return next;
  });

  return { id: msgId, order, tokenCount };
}

// Bulk add: ONE transaction bumps nextOrder by N, then batched writes (450/batch)
// for the message docs. Used by SillyTavern import (N messages = 1 read + ~2 writes
// per batch instead of N transactions).
export async function addMessagesBulk(sessionId, items) {
  if (items.length === 0) return [];
  const tokenCounts = await Promise.all(items.map((it) => countTokens(it.content)));
  const ids = items.map(() => newMsgId());
  const sessionDocRef = sessionRef(sessionId);

  const orders = await runTransaction(db, async (tx) => {
    const snap = await tx.get(sessionDocRef);
    let next = snap.data()?.nextOrder ?? 0;
    const out = [];
    for (let i = 0; i < items.length; i++) out.push(++next);
    tx.update(sessionDocRef, { nextOrder: next, updatedAt: serverTimestamp() });
    return out;
  });

  for (let i = 0; i < ids.length; i += 450) {
    const batch = writeBatch(db);
    for (let j = i; j < Math.min(i + 450, ids.length); j++) {
      batch.set(
        msgRef(sessionId, ids[j]),
        msgDoc({ role: items[j].role, content: items[j].content, thinking: items[j].thinking, tokenCount: tokenCounts[j], order: orders[j] })
      );
    }
    await batch.commit();
  }

  return ids.map((id, j) => ({ id, order: orders[j], tokenCount: tokenCounts[j] }));
}

export async function getMessages(sessionId) {
  const q = query(msgsCol(sessionId), orderBy("order", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getMessage(sessionId, messageId) {
  const snap = await getDoc(msgRef(sessionId, messageId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Edit: overwrite content in place, recompute tokenCount. No cascade (spec §9).
export async function editMessage(sessionId, messageId, content) {
  const tokenCount = await countTokens(content);
  await updateDoc(msgRef(sessionId, messageId), {
    content,
    tokenCount,
    editedAt: serverTimestamp(),
  });
  return { tokenCount };
}

// Regenerate: overwrite content/thinking/tokenCount in place (spec §9).
export async function overwriteMessage(sessionId, messageId, { content, thinking }) {
  const tokenCount = await countTokens(content);
  await updateDoc(msgRef(sessionId, messageId), {
    content,
    thinking: thinking ?? null,
    tokenCount,
  });
  return { tokenCount };
}

// The only path that truly loses data (spec §9).
export async function deleteMessage(sessionId, messageId) {
  await deleteDoc(msgRef(sessionId, messageId));
}
