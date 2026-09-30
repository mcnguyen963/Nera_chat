import * as firestore from "https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js";
import { db } from "../db.js";
import { currentUid } from "../auth.js";
import { createStoryState } from "./state.js";
import { createFirestoreStoryStore } from "./firestore-store.js";

export function storyStore(sessionId) {
  return createFirestoreStoryStore({ api: firestore, db, uid: currentUid(), sessionId });
}

export async function enableContinuity(sessionId) {
  const ref = firestore.doc(db, "users", currentUid(), "sessions", sessionId);
  const snap = await firestore.getDocFromServer(ref);
  if (!snap.exists()) throw new Error("Story not found.");
  if (snap.data().continuityEnabled) return;
  if ((snap.data().nextOrder ?? 0) !== 0)
    throw new Error("Continuity can be enabled only before this story's first message.");
  const store = storyStore(sessionId);
  try {
    await store.initialize({ state: createStoryState("main"), initializationId: `init_${sessionId}` });
  } catch (error) {
    // A previous attempt may have created the branch before updating the
    // session. Only a ready branch can be adopted.
    const existing = await store.load("main").catch(() => { throw error; });
    if (existing.state.revision !== 0 || existing.state.throughOrder !== 0 ||
        existing.state.records.length || existing.state.events.length || existing.messages.length)
      throw new Error("An existing continuity branch needs manual recovery.");
  }
  await firestore.runTransaction(db, async (tx) => {
    const current = await tx.get(ref);
    if (!current.exists() || (current.data().nextOrder ?? 0) !== 0)
      throw new Error("Story changed during continuity setup.");
    tx.update(ref, { continuityEnabled: true, continuityBranchId: "main",
      updatedAt: firestore.serverTimestamp() });
  });
}

export function watchContinuityHead(sessionId, branchId, onChange, onError) {
  const ref = firestore.doc(db, "users", currentUid(), "sessions", sessionId,
    "continuityBranches", branchId);
  return firestore.onSnapshot(ref, (snap) => {
    if (snap.exists() && snap.data().status === "ready") onChange(snap.data());
  }, onError);
}

export async function switchContinuityBranch(sessionId, expectedBranchId, nextBranchId, expectedRevision) {
  const sessionRef = firestore.doc(db, "users", currentUid(), "sessions", sessionId);
  const previousRef = firestore.doc(db, "users", currentUid(), "sessions", sessionId,
    "continuityBranches", expectedBranchId);
  const nextRef = firestore.doc(db, "users", currentUid(), "sessions", sessionId,
    "continuityBranches", nextBranchId);
  await firestore.runTransaction(db, async (tx) => {
    const current = await tx.get(sessionRef);
    const previous = await tx.get(previousRef);
    const next = await tx.get(nextRef);
    if (!current.exists() || !current.data().continuityEnabled ||
        current.data().continuityBranchId !== expectedBranchId)
      throw new Error("The active story branch changed on another device.");
    if (current.data().continuityPendingTurnId)
      throw new Error("Resolve the pending Saver turn before switching branches.");
    if (!next.exists() || next.data().status !== "ready")
      throw new Error("The revised story branch is unavailable.");
    if (!previous.exists() || previous.data().revision !== expectedRevision)
      throw new Error("The story changed while this revision was being prepared.");
    tx.update(sessionRef, { continuityBranchId: nextBranchId,
      updatedAt: firestore.serverTimestamp() });
  });
}
