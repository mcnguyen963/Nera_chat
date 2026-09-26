import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, orderBy,
  runTransaction, writeBatch, serverTimestamp, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";
import { currentUid } from "./auth.js";

// Every session lives under users/{uid}/sessions/... so each user's chat history
// is isolated — enforced both by path scoping and by Firestore rules.

function sessionDoc(sessionId) {
  return doc(db, "users", currentUid(), "sessions", sessionId);
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
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getSession(sessionId) {
  const snap = await getDoc(sessionDoc(sessionId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createSession(title) {
  const id = newId("sess");
  const data = {
    title: title || "New Session",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    longTermPlan: "",
    activeSummaryMessageId: null,
    breakpointOrder: 0,
    nextOrder: 0, // transactionally incremented per added message; messages start at order 1
  };
  await setDoc(sessionDoc(id), data);
  return id;
}

export async function updateSession(sessionId, partial) {
  await updateDoc(sessionDoc(sessionId), { ...partial, updatedAt: serverTimestamp() });
}

export async function renameSession(sessionId, title) {
  await updateSession(sessionId, { title });
}

export async function deleteSession(sessionId) {
  // Firestore has no recursive delete from the client — batch the messages subcollection.
  const snap = await getDocs(collection(db, "users", currentUid(), "sessions", sessionId, "messages"));
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = writeBatch(db);
    docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await deleteDoc(sessionDoc(sessionId));
}

export function subscribeSessions(callback, onError) {
  const q = query(sessionsCol(), orderBy("updatedAt", "desc"));
  return onSnapshot(
    q,
    // Map the QuerySnapshot to plain objects — the UI expects an array of sessions.
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    onError
  );
}

// Duplicate a session: copies the session doc (title, long-term plan, breakpoint,
// summary pointer — i.e. all its "settings") and every message into a new session.
// Message docs are copied with their ORIGINAL ids and orders, so
// activeSummaryMessageId and breakpointOrder keep pointing at the right messages.
export async function duplicateSession(sourceId) {
  const source = await getSession(sourceId);
  if (!source) throw new Error("Session not found.");
  const msgsSnap = await getDocs(
    collection(db, "users", currentUid(), "sessions", sourceId, "messages")
  );

  const id = newId("sess");
  const { id: _omit, createdAt: _c, updatedAt: _u, ...fields } = source;
  await setDoc(sessionDoc(id), {
    ...fields,
    title: (source.title || "Session") + " (copy)",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    nextOrder: source.nextOrder ?? 0,
  });

  const docs = msgsSnap.docs;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = writeBatch(db);
    docs.slice(i, i + 450).forEach((d) => {
      batch.set(doc(db, "users", currentUid(), "sessions", id, "messages", d.id), d.data());
    });
    await batch.commit();
  }
  return id;
}
