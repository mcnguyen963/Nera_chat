import { packRecordChunks, unpackRecordChunks } from "./record-chunks.js";
import { assertUsableState, createStoryState, verifyStateSources } from "./state.js";
import { verifyMessages, prepareCommit, acceptedReceipt, checkRetry } from "./store.js";
import { validate, id } from "./schema.js";

export const MAX_DOCUMENT_BYTES = 250 * 1024;
const MAX_COMMIT_BYTES = 6 * 1024 * 1024;
function bounded(value) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_DOCUMENT_BYTES)
    throw new Error("Continuity document exceeds the scaffold storage limit.");
  return value;
}
export function validateInitialStoryStorage({ state, messages, parent = null }) {
  bounded({ state, parent });
  state.records.forEach(bounded);
  state.events.forEach(bounded);
  messages.forEach(bounded);
}
function metadata(state, recordChunkCount) {
  return { schemaVersion: state.schemaVersion, branchId: state.branchId, revision: state.revision,
    throughOrder: state.throughOrder, status: "ready", recordStorageVersion: 2, recordChunkCount };
}
async function fingerprint(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// SDK injection keeps the domain modules runnable in Node and allows emulator
// tests. Supply the Firebase SDK already used by the app; no second backend.
// Data is isolated from legacy messageChunks until a migration/UI adapter exists.
export function createFirestoreStoryStore({ api, db, uid, sessionId }) {
  if (!uid || !sessionId || [uid, sessionId].some((value) => typeof value !== "string" || value.includes("/")))
    throw new Error("An account and session are required.");
  const base = ["users", uid, "sessions", sessionId, "continuityBranches"];
  const session = api.doc(db, "users", uid, "sessions", sessionId);
  const root = (branchId) => { validate(id, branchId); return api.doc(db, ...base, branchId); };
  const child = (branchId, group, key) => { validate(id, key); return api.doc(db, ...base, branchId, group, key); };
  const all = async (branchId, group) => (await api.getDocsFromServer(api.collection(db, ...base, branchId, group))).docs.map((doc) => doc.data());
  const store = {
    async initialize({ state = createStoryState(), messages = [], parent = null,
      initializationId = crypto.randomUUID() } = {}) {
      assertUsableState(state);
      validate(id, initializationId);
      await verifyMessages(messages);
      verifyStateSources(state, messages);
      validateInitialStoryStorage({ state, messages, parent });
      const genesis = { state, parent };
      const recordChunks = packRecordChunks(state.records);
      const initializationHash = await fingerprint({ state, messages, parent });
      const entries = [
        ...recordChunks.map((chunk) => ["recordChunks", chunk.id, chunk]),
        ...state.events.map((event) => ["events", event.id, event]),
        ...messages.map((message) => ["messages", message.id, message]),
      ];
      // Reserve the branch before staging deterministic child IDs. A retry may
      // resume only with the same initialization ID and identical source data.
      await api.runTransaction(db, async (tx) => {
        const existing = await tx.get(root(state.branchId));
        if (existing.exists()) {
          const data = existing.data();
          if (data.status !== "initializing" || data.initializationId !== initializationId ||
              data.initializationHash !== initializationHash)
            throw new Error("Continuity branch already exists or has different initialization data.");
          return;
        }
        tx.set(root(state.branchId), { ...metadata(state, recordChunks.length), status: "initializing",
          initializationId, initializationHash });
      });
      for (let i = 0; i < entries.length; i += 20) {
        const batch = api.writeBatch(db);
        for (const [group, key, value] of entries.slice(i, i + 20))
          batch.set(child(state.branchId, group, key), value);
        await batch.commit();
      }
      await api.runTransaction(db, async (tx) => {
        const reserved = await tx.get(root(state.branchId));
        if (!reserved.exists() || reserved.data().status !== "initializing" ||
            reserved.data().initializationId !== initializationId ||
            reserved.data().initializationHash !== initializationHash)
          throw new Error("Continuity branch initialization changed.");
        tx.set(root(state.branchId), metadata(state, recordChunks.length));
        tx.set(child(state.branchId, "checkpoints", "initial"), genesis);
      });
    },
    async load(branchId) {
      // Collections and metadata are read separately, so verify the head again.
      // Every writer below increments the branch revision in the same commit.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await api.getDocFromServer(root(branchId));
        if (!before.exists() || before.data().status !== "ready") throw new Error("Continuity branch is not ready.");
        if (before.data().recordStorageVersion !== 2) {
          if (before.data().recordStorageVersion != null)
            throw new Error("Unsupported continuity record storage version.");
          // Legacy data remains intact; chunks and the format marker publish in
          // one revision-guarded transaction, so incomplete conversion is invisible.
          const legacyRecords = await all(branchId, "records");
          const chunks = packRecordChunks(legacyRecords);
          const totalBytes = chunks.reduce((size, chunk) => size + new TextEncoder().encode(JSON.stringify(chunk)).length, 0);
          if (chunks.length > 450 || totalBytes > MAX_COMMIT_BYTES)
            throw new Error("Legacy continuity state is too large for automatic chunk conversion.");
          await api.runTransaction(db, async (tx) => {
            const head = await tx.get(root(branchId));
            if (!head.exists() || head.data().status !== "ready" || head.data().revision !== before.data().revision)
              return;
            if (head.data().recordStorageVersion === 2) return;
            if (head.data().recordStorageVersion != null)
              throw new Error("Unsupported continuity record storage version.");
            for (const chunk of chunks) tx.set(child(branchId, "recordChunks", chunk.id), chunk);
            tx.set(root(branchId), { ...head.data(), recordStorageVersion: 2, recordChunkCount: chunks.length });
          });
          continue;
        }
        const [recordChunks, events, page] = await Promise.all([all(branchId, "recordChunks"), all(branchId, "events"),
          api.getDocsFromServer(api.query(api.collection(db, ...base, branchId, "messages"),
            api.orderBy("order", "desc"), api.limit(24)))]);
        const messages = page.docs.map((doc) => doc.data()).sort((a, b) => a.order - b.order);
        const after = await api.getDocFromServer(root(branchId));
        if (!after.exists() || after.data().status !== "ready") throw new Error("Continuity branch is not ready.");
        if (before.data().revision !== after.data().revision) continue;
        if (after.data().recordStorageVersion !== 2 || after.data().recordChunkCount !== before.data().recordChunkCount) continue;
        const records = unpackRecordChunks(recordChunks, after.data().recordChunkCount);
        const { status: _status, recordStorageVersion: _storage, recordChunkCount: _count, ...head } = after.data();
        const state = assertUsableState({ ...head, records,
          events: events.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)) });
        await verifyMessages(messages);
        return { state, messages: messages.sort((a, b) => a.order - b.order),
          recordChunks: recordChunks.sort((a, b) => a.id.localeCompare(b.id)) };
      }
      throw new Error("Story changed while loading; retry with the latest revision.");
    },
    async readTurn(branchId, turnId) {
      const result = await api.getDocFromServer(child(branchId, "turns", turnId));
      return result.exists() ? result.data() : null;
    },
    async readPending(branchId) {
      const active = await api.getDocFromServer(session);
      const turnId = active.exists() ? active.data().continuityPendingTurnId : null;
      return turnId ? store.readTurn(branchId, turnId) : null;
    },
    async listMessages(branchId, beforeOrder = Infinity, pageSize = 100) {
      const constraints = [api.orderBy("order", "desc")];
      if (Number.isFinite(beforeOrder)) constraints.push(api.where("order", "<", beforeOrder));
      constraints.push(api.limit(pageSize));
      const page = await api.getDocsFromServer(api.query(
        api.collection(db, ...base, branchId, "messages"), ...constraints));
      return page.docs.map((item) => item.data()).filter((item) => item.order > 0)
        .sort((a, b) => a.order - b.order);
    },
    async readSources(branchId, sourceIds) {
      const docs = await Promise.all([...new Set(sourceIds)].map(async (sourceId) => {
        validate(id, sourceId);
        const result = await api.getDocFromServer(child(branchId, "messages", sourceId));
        return result.exists() ? result.data() : null;
      }));
      const messages = docs.filter(Boolean);
      await verifyMessages(messages);
      return messages;
    },
    async beginTurn(request) {
      await verifyMessages([request.user]);
      bounded(request);
      return api.runTransaction(db, async (tx) => {
        const activeSession = await tx.get(session);
        const head = await tx.get(root(request.branchId));
        const run = await tx.get(child(request.branchId, "turns", request.turnId));
        const existing = run.exists() ? run.data() : null;
        checkRetry(existing, request);
        if (existing?.status === "accepted") return acceptedReceipt(existing);
        if (existing?.status === "needs_state_review")
          throw new Error("Resolve the pending Saver turn before continuing.");
        if (!activeSession.exists() || !activeSession.data().continuityEnabled ||
            activeSession.data().continuityBranchId !== request.expectedActiveBranchId)
          throw new Error("The active story branch changed on another device.");
        if (activeSession.data().continuityPendingTurnId &&
            activeSession.data().continuityPendingTurnId !== request.turnId)
          throw new Error("Resolve the pending Saver turn before continuing.");
        if (!head.exists() || head.data().status !== "ready" || head.data().revision !== request.baseRevision)
          throw new Error("Stale or unavailable branch revision.");
        tx.set(child(request.branchId, "turns", request.turnId), { ...request, status: "pending" });
        return { status: "pending" };
      });
    },
    async savePendingDraft(request, assistant, proposal, error, trace = null) {
      await verifyMessages([request.user, assistant]);
      const pending = { ...request, expectedActiveBranchId: request.branchId, assistant, proposal, trace,
        error: String(error).slice(0, 2000), status: "needs_state_review" };
      bounded(pending);
      await api.runTransaction(db, async (tx) => {
        const active = await tx.get(session);
        const head = await tx.get(root(request.branchId));
        const turn = await tx.get(child(request.branchId, "turns", request.turnId));
        if (!active.exists() || !active.data().continuityEnabled ||
            active.data().continuityBranchId !== request.expectedActiveBranchId ||
            (active.data().continuityPendingTurnId && active.data().continuityPendingTurnId !== request.turnId) ||
            !head.exists() || head.data().revision !== request.baseRevision || !turn.exists())
          throw new Error("Story changed while saving the pending Saver turn.");
        checkRetry(turn.data(), request);
        if (turn.data().status === "accepted")
          throw new Error("Saver turn was resolved on another device.");
        if (turn.data().assistant && turn.data().assistant.contentHash !== assistant.contentHash)
          throw new Error("A different Saver draft is already pending.");
        tx.set(child(request.branchId, "turns", request.turnId), pending);
        tx.update(session, { continuityBranchId: request.branchId,
          continuityPendingTurnId: request.turnId, updatedAt: api.serverTimestamp() });
      });
    },
    async commitTurn(request) {
      await verifyMessages([request.user, request.assistant,
        ...(request.authorCorrection ? [request.authorCorrection] : [])]);
      const pending = await store.readTurn(request.branchId, request.turnId);
      checkRetry(pending, request);
      if (pending?.status === "accepted") return acceptedReceipt(pending);
      if (pending?.assistant && pending.assistant.contentHash !== request.assistant.contentHash)
        throw new Error("Pending narration changed during resolution.");
      const snapshot = await store.load(request.branchId);
      const sourceIds = [...new Set(request.review.patch.events.flatMap((event) => event.sources.map((ref) => ref.messageId))
        .concat(request.review.patch.operations.flatMap((operation) => operation.sources.map((ref) => ref.messageId))))];
      const sourceMessages = await store.readSources(request.branchId, sourceIds);
      const uniqueSources = new Map([...snapshot.messages, ...sourceMessages].map((message) => [message.id, message]));
      const prepared = prepareCommit({ ...snapshot, messages: [...uniqueSources.values()] }, pending, request);
      const newEvents = prepared.state.events.filter((event) => request.review.patch.events.some((item) => item.id === event.id));
      const recordChunks = packRecordChunks(prepared.state.records, snapshot.recordChunks);
      const previousChunks = new Map(snapshot.recordChunks.map((chunk) => [chunk.id, JSON.stringify(chunk)]));
      const changedChunks = recordChunks.filter((chunk) => previousChunks.get(chunk.id) !== JSON.stringify(chunk));
      const writes = [metadata(prepared.state, recordChunks.length), prepared.turn, request.user, request.assistant,
        ...(request.authorCorrection ? [request.authorCorrection] : []),
        ...newEvents, ...changedChunks].map(bounded);
      if (writes.length + 1 > 450) throw new Error("Continuity turn has too many Firestore writes.");
      const size = writes.reduce((bytes, value) => bytes + new TextEncoder().encode(JSON.stringify(value)).length, 0);
      if (size > MAX_COMMIT_BYTES) throw new Error("Continuity turn exceeds the Firestore commit limit.");
      return api.runTransaction(db, async (tx) => {
        const activeSession = await tx.get(session);
        const head = await tx.get(root(request.branchId));
        const run = await tx.get(child(request.branchId, "turns", request.turnId));
        const existing = run.exists() ? run.data() : null;
        checkRetry(existing, request);
        if (existing?.status === "accepted") return acceptedReceipt(existing);
        if (!activeSession.exists() || !activeSession.data().continuityEnabled ||
            activeSession.data().continuityBranchId !== request.expectedActiveBranchId)
          throw new Error("The active story branch changed on another device.");
        if (activeSession.data().continuityPendingTurnId &&
            activeSession.data().continuityPendingTurnId !== request.turnId)
          throw new Error("Another Saver turn is awaiting state review.");
        if (!existing || !head.exists() || head.data().status !== "ready" || head.data().revision !== request.baseRevision)
          throw new Error("Stale or unavailable branch revision.");
        tx.set(root(request.branchId), metadata(prepared.state, recordChunks.length));
        tx.update(session, { continuityPendingTurnId: null, updatedAt: api.serverTimestamp() });
        tx.set(child(request.branchId, "turns", request.turnId), prepared.turn);
        for (const message of [request.user, request.assistant,
          ...(request.authorCorrection ? [request.authorCorrection] : [])])
          tx.set(child(request.branchId, "messages", message.id), bounded(message));
        for (const event of newEvents)
          tx.set(child(request.branchId, "events", event.id), event);
        for (const chunk of changedChunks)
          tx.set(child(request.branchId, "recordChunks", chunk.id), chunk);
        return acceptedReceipt(prepared.turn);
      });
    },
    async failTurn(branchId, turnId, error) {
      await api.runTransaction(db, async (tx) => {
        const run = await tx.get(child(branchId, "turns", turnId));
        if (run.exists() && !["accepted", "needs_state_review"].includes(run.data().status))
          tx.update(child(branchId, "turns", turnId), { status: "failed", error: String(error).slice(0, 2000) });
      });
    },
    async history(branchId) {
      const initial = await api.getDocFromServer(child(branchId, "checkpoints", "initial"));
      if (!initial.exists()) throw new Error("Initial checkpoint is missing.");
      const turns = (await all(branchId, "turns")).filter((turn) => turn.status === "accepted").sort((a, b) => a.revision - b.revision);
      const sourceMessages = await all(branchId, "messages");
      const initialMessages = sourceMessages.filter((message) => message.order <= initial.data().state.throughOrder)
        .sort((a, b) => a.order - b.order);
      return { initial: { ...initial.data(), messages: initialMessages }, turns };
    },
  };
  return store;
}
