import {
  doc, getDoc, getDocs, query, orderBy, updateDoc, deleteDoc,
  collection, runTransaction, serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";
import { countTokens } from "./tokenizer.js";

function newMsgId() {
  return "msg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Adds a message with a monotonically increasing per-session `order`, taken
// transactionally from the session doc's `nextOrder` counter (spec §2).
export async function addMessage(sessionId, { role, content, thinking = null }) {
  const tokenCount = await countTokens(content);
  const msgId = newMsgId();
  const sessionRef = doc(db, "sessions", sessionId);
  const msgRef = doc(db, "sessions", sessionId, "messages", msgId);

  const order = await runTransaction(db, async (tx) => {
    const snap = await tx.get(sessionRef);
    const next = (snap.data()?.nextOrder ?? 0) + 1;
    tx.update(sessionRef, { nextOrder: next, updatedAt: serverTimestamp() });
    tx.set(msgRef, {
      role,
      content,
      thinking,
      tokenCount,
      order: next,
      createdAt: serverTimestamp(),
      editedAt: null,
    });
    return next;
  });

  return { id: msgId, order, tokenCount };
}

export async function getMessages(sessionId) {
  const q = query(collection(db, "sessions", sessionId, "messages"), orderBy("order", "asc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getMessage(sessionId, messageId) {
  const snap = await getDoc(doc(db, "sessions", sessionId, "messages", messageId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

// Edit: overwrite content in place, recompute tokenCount. No cascade (spec §9).
export async function editMessage(sessionId, messageId, content) {
  const tokenCount = await countTokens(content);
  await updateDoc(doc(db, "sessions", sessionId, "messages", messageId), {
    content,
    tokenCount,
    editedAt: serverTimestamp(),
  });
}

// Regenerate: overwrite content/thinking/tokenCount in place (spec §9).
export async function overwriteMessage(sessionId, messageId, { content, thinking }) {
  const tokenCount = await countTokens(content);
  await updateDoc(doc(db, "sessions", sessionId, "messages", messageId), {
    content,
    thinking: thinking ?? null,
    tokenCount,
  });
}

// The only path that truly loses data (spec §9).
export async function deleteMessage(sessionId, messageId) {
  await deleteDoc(doc(db, "sessions", sessionId, "messages", messageId));
}
