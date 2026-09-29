import { assertUsableState, createStoryState, verifyStateSources } from "./state.js";
import { verifyMessages, prepareCommit, acceptedReceipt, checkRetry } from "./store.js";
import { validate, id } from "./schema.js";

const MAX_DOCUMENT_BYTES = 250 * 1024;
const MAX_COMMIT_BYTES = 6 * 1024 * 1024;
function bounded(value) {
  if (new TextEncoder().encode(JSON.stringify(value)).length > MAX_DOCUMENT_BYTES)
    throw new Error("Continuity document exceeds the scaffold storage limit.");
  return value;
}
function metadata(state) {
  return { schemaVersion: state.schemaVersion, branchId: state.branchId, revision: state.revision,
    throughOrder: state.throughOrder, status: "ready" };
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
      const genesis = bounded({ state, parent });
      const initializationHash = await fingerprint({ state, messages, parent });
      state.records.forEach(bounded); state.events.forEach(bounded); messages.forEach(bounded);
      const entries = [
        ...state.records.map((record) => ["records", record.id, record]),
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
        tx.set(root(state.branchId), { ...metadata(state), status: "initializing",
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
        tx.set(root(state.branchId), metadata(state));
        tx.set(child(state.branchId, "checkpoints", "initial"), genesis);
      });
    },
    async load(branchId) {
      // Collections and metadata are read separately, so verify the head again.
      // Every writer below increments the branch revision in the same commit.
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = await api.getDocFromServer(root(branchId));
        if (!before.exists() || before.data().status !== "ready") throw new Error("Continuity branch is not ready.");
        const [records, events, page] = await Promise.all([all(branchId, "records"), all(branchId, "events"),
          api.getDocsFromServer(api.query(api.collection(db, ...base, branchId, "messages"),
            api.orderBy("order", "desc"), api.limit(24)))]);
        const messages = page.docs.map((doc) => doc.data()).sort((a, b) => a.order - b.order);
        const after = await api.getDocFromServer(root(branchId));
        if (!after.exists() || after.data().status !== "ready") throw new Error("Continuity branch is not ready.");
        if (before.data().revision !== after.data().revision) continue;
        const { status: _status, ...head } = after.data();
        const state = assertUsableState({ ...head, records,
          events: events.sort((a, b) => a.sequence - b.sequence || a.id.localeCompare(b.id)) });
        await verifyMessages(messages);
        return { state, messages: messages.sort((a, b) => a.order - b.order) };
      }
      throw new Error("Story changed while loading; retry with the latest revision.");
    },
    async readTurn(branchId, turnId) {
      const result = await api.getDocFromServer(child(branchId, "turns", turnId));
      return result.exists() ? result.data() : null;
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
        const head = await tx.get(root(request.branchId));
        const run = await tx.get(child(request.branchId, "turns", request.turnId));
        const existing = run.exists() ? run.data() : null;
        checkRetry(existing, request);
        if (existing?.status === "accepted") return acceptedReceipt(existing);
        if (!head.exists() || head.data().status !== "ready" || head.data().revision !== request.baseRevision)
          throw new Error("Stale or unavailable branch revision.");
        tx.set(child(request.branchId, "turns", request.turnId), { ...request, status: "pending" });
        return { status: "pending" };
      });
    },
    async commitTurn(request) {
      await verifyMessages([request.user, request.assistant]);
      const pending = await store.readTurn(request.branchId, request.turnId);
      checkRetry(pending, request);
      if (pending?.status === "accepted") return acceptedReceipt(pending);
      const snapshot = await store.load(request.branchId);
      const sourceIds = [...new Set(request.review.patch.events.flatMap((event) => event.sources.map((ref) => ref.messageId))
        .concat(request.review.patch.operations.flatMap((operation) => operation.sources.map((ref) => ref.messageId))))];
      const sourceMessages = await store.readSources(request.branchId, sourceIds);
      const uniqueSources = new Map([...snapshot.messages, ...sourceMessages].map((message) => [message.id, message]));
      const prepared = prepareCommit({ ...snapshot, messages: [...uniqueSources.values()] }, pending, request);
      const newEvents = prepared.state.events.filter((event) => request.review.patch.events.some((item) => item.id === event.id));
      const changedRecords = prepared.state.records.filter((record) => request.review.patch.operations.some((op) => op.record.id === record.id));
      const writes = [metadata(prepared.state), prepared.turn, request.user, request.assistant,
        ...newEvents, ...changedRecords].map(bounded);
      const size = writes.reduce((bytes, value) => bytes + new TextEncoder().encode(JSON.stringify(value)).length, 0);
      if (size > MAX_COMMIT_BYTES) throw new Error("Continuity turn exceeds the Firestore commit limit.");
      return api.runTransaction(db, async (tx) => {
        const head = await tx.get(root(request.branchId));
        const run = await tx.get(child(request.branchId, "turns", request.turnId));
        const existing = run.exists() ? run.data() : null;
        checkRetry(existing, request);
        if (existing?.status === "accepted") return acceptedReceipt(existing);
        if (!existing || !head.exists() || head.data().status !== "ready" || head.data().revision !== request.baseRevision)
          throw new Error("Stale or unavailable branch revision.");
        tx.set(root(request.branchId), metadata(prepared.state));
        tx.set(child(request.branchId, "turns", request.turnId), prepared.turn);
        for (const message of [request.user, request.assistant]) tx.set(child(request.branchId, "messages", message.id), bounded(message));
        for (const event of newEvents)
          tx.set(child(request.branchId, "events", event.id), event);
        for (const record of changedRecords)
          tx.set(child(request.branchId, "records", record.id), record);
        return acceptedReceipt(prepared.turn);
      });
    },
    async failTurn(branchId, turnId, error) {
      await api.runTransaction(db, async (tx) => {
        const run = await tx.get(child(branchId, "turns", turnId));
        if (run.exists() && run.data().status !== "accepted")
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
