import {
  doc, getDocFromServer, setDoc, updateDoc, deleteDoc, collection, getDocs, getDocsFromServer, query, orderBy,
  writeBatch, serverTimestamp, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "./db.js";
import { currentUid } from "./auth.js";
import { ensureChunked } from "./messages.js";

// Every session lives under users/{uid}/sessions/... so each user's chat history
// is isolated — enforced both by path scoping and by Firestore rules.

function sessionDoc(sessionId) {
  return doc(db, "users", currentUid(), "sessions", sessionId);
}
function sessionsCol() {
  return collection(db, "users", currentUid(), "sessions");
}

async function copyCollection(sourcePath, destinationPath, include = () => true) {
  const snap = await getDocsFromServer(collection(db, ...sourcePath));
  const docs = snap.docs.filter(include);
  for (let i = 0; i < docs.length; i += 20) {
    const batch = writeBatch(db);
    docs.slice(i, i + 20).forEach((item) => {
      batch.set(doc(db, ...destinationPath, item.id), item.data());
    });
    await batch.commit();
  }
}

async function deleteCollection(path) {
  const snap = await getDocsFromServer(collection(db, ...path));
  for (let i = 0; i < snap.docs.length; i += 400) {
    const batch = writeBatch(db);
    snap.docs.slice(i, i + 400).forEach((item) => batch.delete(item.ref));
    await batch.commit();
  }
}

function newId(prefix) {
  return prefix + "_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export async function listSessions() {
  const q = query(sessionsCol(), orderBy("updatedAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((session) => session.migrationStatus !== "staging");
}

export async function getSession(sessionId) {
  const snap = await getDocFromServer(sessionDoc(sessionId));
  return snap.exists() ? { id: snap.id, ...snap.data() } : null;
}

export async function createSession(title, options = {}) {
  const id = newId("sess");
  const data = {
    title: title || "New Session",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    longTermPlan: "",
    shortMemory: "",
    shortMemoryThroughOrder: 0,
    continuityEnabled: false,
    continuityBranchId: null,
    continuityMode: "balanced",
    continuitySaverReviewEveryTurn: false,
    continuityPendingTurnId: null,
    activeSummaryMessageId: null,
    breakpointOrder: 0,
    nextOrder: 0, // transactionally incremented per added message; messages start at order 1
    storageVersion: 2,
    activeChunkId: null,
    activeChunkBytes: 0,
    activeChunkCount: 0,
    ...(options.migrationStatus === "staging" ? { migrationStatus: "staging" } : {}),
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
  const owner = currentUid();
  // Migrated sessions retain their legacy docs for recovery. Delete both trees.
  for (const name of ["messageChunks", "messages"]) {
    const snap = await getDocsFromServer(collection(db, "users", owner, "sessions", sessionId, name));
    for (let i = 0; i < snap.docs.length; i += 450) {
      const batch = writeBatch(db);
      snap.docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
  }
  const branchesPath = ["users", owner, "sessions", sessionId, "continuityBranches"];
  const branches = await getDocsFromServer(collection(db, ...branchesPath));
  for (const branch of branches.docs) {
    for (const group of ["checkpoints", "events", "messages", "records", "recordChunks", "turns"]) {
      await deleteCollection([...branchesPath, branch.id, group]);
    }
    await deleteDoc(doc(db, ...branchesPath, branch.id));
  }
  await deleteDoc(sessionDoc(sessionId));
}

export function subscribeSessions(callback, onError) {
  const q = query(sessionsCol(), orderBy("updatedAt", "desc"));
  return onSnapshot(
    q,
    // Map the QuerySnapshot to plain objects — the UI expects an array of sessions.
    (snap) => callback(snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((session) => session.migrationStatus !== "staging")),
    onError
  );
}

// Duplicate session metadata, chunks, and optional continuity branches.
export async function duplicateSession(sourceId) {
  await ensureChunked(sourceId);
  const sourceSnap = await getDocFromServer(sessionDoc(sourceId));
  const source = sourceSnap.exists() ? { id: sourceSnap.id, ...sourceSnap.data() } : null;
  if (!source) throw new Error("Session not found.");
  const msgsSnap = await getDocsFromServer(
    collection(db, "users", currentUid(), "sessions", sourceId, "messageChunks")
  );

  const id = newId("sess");
  const { id: _omit, createdAt: _c, updatedAt: _u, ...fields } = source;
  const docs = msgsSnap.docs;
  // Chunk payloads can be large; keep each commit well below the 10 MiB cap.
  for (let i = 0; i < docs.length; i += 6) {
    const batch = writeBatch(db);
    docs.slice(i, i + 6).forEach((d) => {
      batch.set(doc(db, "users", currentUid(), "sessions", id, "messageChunks", d.id), d.data());
    });
    await batch.commit();
  }
  const sourceBranchesPath = ["users", currentUid(), "sessions", sourceId, "continuityBranches"];
  const destinationBranchesPath = ["users", currentUid(), "sessions", id, "continuityBranches"];
  const branches = await getDocsFromServer(collection(db, ...sourceBranchesPath));
  for (const branch of branches.docs) {
    if (branch.data().status !== "ready") continue;
    for (const group of ["checkpoints", "events", "messages", "records", "recordChunks", "turns"]) {
      if (group === "records" && branch.data().recordStorageVersion === 2) continue;
      await copyCollection([...sourceBranchesPath, branch.id, group], [...destinationBranchesPath, branch.id, group],
        (item) => group !== "turns" || item.data().status === "accepted");
    }
    const after = await getDocFromServer(branch.ref);
    if (!after.exists() || after.data().status !== "ready" || after.data().revision !== branch.data().revision ||
        after.data().recordStorageVersion !== branch.data().recordStorageVersion)
      throw new Error("Continuity branch changed while duplicating; retry the copy.");
    await setDoc(doc(db, ...destinationBranchesPath, branch.id), branch.data());
  }
  await setDoc(sessionDoc(id), {
    ...fields,
    title: (source.title || "Session") + " (copy)",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    nextOrder: source.nextOrder ?? 0,
  });
  return id;
}
