import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, orderBy,
  runTransaction, writeBatch, serverTimestamp, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";

function newId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function listSessions() {
  const q = query(collection(db, "sessions"), orderBy("updatedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function getSession(sessionId) {
  const snap = await getDoc(doc(db, "sessions", sessionId));
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
  await setDoc(doc(db, "sessions", id), data);
  return id;
}

export async function updateSession(sessionId, partial) {
  await updateDoc(doc(db, "sessions", sessionId), { ...partial, updatedAt: serverTimestamp() });
}

export async function renameSession(sessionId, title) {
  await updateSession(sessionId, { title });
}

export async function deleteSession(sessionId) {
  // Firestore has no recursive delete from the client — batch the messages subcollection.
  const snap = await getDocs(collection(db, "sessions", sessionId, "messages"));
  const docs = snap.docs;
  for (let i = 0; i < docs.length; i += 450) {
    const batch = writeBatch(db);
    docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
    await batch.commit();
  }
  await deleteDoc(doc(db, "sessions", sessionId));
}

export function subscribeSessions(callback, onError) {
  const q = query(collection(db, "sessions"), orderBy("updatedAt", "desc"));
  return onSnapshot(q, callback, onError);
}
