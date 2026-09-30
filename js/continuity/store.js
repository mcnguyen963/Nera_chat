import { createStoryState, assertUsableState, applyContinuityPatch, sourceMessage, verifyStateSources } from "./state.js";
import { REVIEW_SCHEMA, MIGRATION_REVIEW_SCHEMA, validate, id } from "./schema.js";

export async function verifyMessages(messages) {
  if (new Set(messages.map((m) => m.id)).size !== messages.length) throw new Error("Duplicate source message IDs.");
  for (const message of messages) {
    const rebuilt = await sourceMessage(message);
    if (rebuilt.contentHash !== message.contentHash) throw new Error("Source content hash mismatch.");
  }
}

export function validateReview(review, { branchId, baseRevision, turnId, migrationReview = false }) {
  validate(migrationReview ? MIGRATION_REVIEW_SCHEMA : REVIEW_SCHEMA, review);
  if (review.verdict !== "accept" || review.violations.length) throw new Error("Continuity review rejected the draft.");
  if (review.patch.branchId !== branchId || review.patch.baseRevision !== baseRevision || review.patch.turnId !== turnId)
    throw new Error("Review does not match this turn and branch.");
}

export function checkPending(snapshot, pending, request) {
  validate(id, request.turnId);
  if (!pending || pending.turnId !== request.turnId || pending.user.contentHash !== request.user.contentHash ||
      pending.user.role !== request.user.role || pending.user.id !== request.user.id ||
      pending.user.revision !== request.user.revision || pending.user.order !== request.user.order)
    throw new Error("Pending turn does not match this request.");
  if (snapshot.state.revision !== request.baseRevision || snapshot.state.branchId !== request.branchId)
    throw new Error("Stale branch revision; reload before continuing.");
}

export function prepareCommit(snapshot, pending, request) {
  checkPending(snapshot, pending, request);
  validateReview(request.review, request);
  if (request.user.order !== snapshot.state.throughOrder + 1 || request.assistant.order !== request.user.order + 1 ||
      request.assistant.role !== "assistant") throw new Error("Invalid turn message order.");
  if (request.authorCorrection && (request.authorCorrection.role !== "author" ||
      request.authorCorrection.order !== request.assistant.order + 1))
    throw new Error("Invalid manual author correction order.");
  const messages = [...snapshot.messages, request.user, request.assistant,
    ...(request.authorCorrection ? [request.authorCorrection] : [])];
  if (new Set(messages.map((m) => m.id)).size !== messages.length) throw new Error("Duplicate message IDs.");
  const state = applyContinuityPatch(snapshot.state, request.review.patch, { messages,
    throughOrder: request.authorCorrection?.order ?? request.assistant.order,
    currentAuthorOrder: request.authorCorrection?.order, currentInputOrder: request.user.order });
  const turn = { turnId: request.turnId, branchId: state.branchId, baseRevision: request.baseRevision,
    revision: state.revision, status: "accepted", user: request.user, assistant: request.assistant,
    review: request.review, authorCorrection: request.authorCorrection ?? null,
    trace: pending.trace || request.trace ? { ...pending.trace, ...request.trace } : null };
  return { state, messages, turn };
}

export function acceptedReceipt(turn) {
  return structuredClone({ status: "accepted", turnId: turn.turnId, branchId: turn.branchId,
    revision: turn.revision, assistant: turn.assistant });
}

export function checkRetry(existing, request) {
  if (existing && (existing.user.contentHash !== request.user.contentHash || existing.user.role !== request.user.role ||
      existing.user.id !== request.user.id || existing.baseRevision !== request.baseRevision))
    throw new Error("Turn ID was already used for a different request.");
}

// Executable reference repository for tests and local integration. The Firestore
// adapter has the same interface. No global app state or localStorage authority.
export function createMemoryStoryStore() {
  const branches = new Map();
  const branch = (branchId) => {
    const value = branches.get(branchId);
    if (!value) throw new Error("Continuity branch not found.");
    return value;
  };
  return {
    async initialize({ state = createStoryState(), messages = [], parent = null } = {}) {
      assertUsableState(state);
      await verifyMessages(messages);
      verifyStateSources(state, messages);
      if (branches.has(state.branchId)) throw new Error("Continuity branch already exists.");
      const initial = structuredClone({ state, messages, parent });
      branches.set(state.branchId, { ...structuredClone(initial), initial, turns: new Map() });
    },
    async load(branchId) {
      const data = branch(branchId);
      return structuredClone({ state: data.state, messages: data.messages });
    },
    async readSources(branchId, sourceIds) {
      const wanted = new Set(sourceIds);
      return structuredClone(branch(branchId).messages.filter((message) => wanted.has(message.id)));
    },
    async readTurn(branchId, turnId) { return structuredClone(branch(branchId).turns.get(turnId) ?? null); },
    async readPending(branchId) {
      return structuredClone([...branch(branchId).turns.values()].find((turn) => turn.status === "needs_state_review") ?? null);
    },
    async beginTurn(request) {
      await verifyMessages([request.user]);
      const data = branch(request.branchId);
      if ([...data.turns.values()].some((turn) => turn.status === "needs_state_review" && turn.turnId !== request.turnId))
        throw new Error("Resolve the pending Saver turn before continuing.");
      const existing = data.turns.get(request.turnId);
      checkRetry(existing, request);
      if (existing?.status === "accepted") return acceptedReceipt(existing);
      if (existing?.status === "needs_state_review")
        throw new Error("Resolve the pending Saver turn before continuing.");
      if (data.state.revision !== request.baseRevision) throw new Error("Stale branch revision.");
      validate(id, request.turnId);
      data.turns.set(request.turnId, structuredClone({ ...request, status: "pending" }));
      return { status: "pending" };
    },
    async savePendingDraft(request, assistant, proposal, error, trace = null) {
      const data = branch(request.branchId);
      const pending = data.turns.get(request.turnId);
      checkPending({ state: data.state }, pending, request);
      if (pending.status === "accepted") throw new Error("Saver turn was resolved on another device.");
      if (pending.status === "needs_state_review" && pending.assistant?.contentHash !== assistant.contentHash)
        throw new Error("A different Saver draft is already pending.");
      data.turns.set(request.turnId, structuredClone({ ...pending, expectedActiveBranchId: request.branchId, assistant,
        proposal, trace, error: String(error).slice(0, 2000), status: "needs_state_review" }));
    },
    async commitTurn(request) {
      await verifyMessages([request.user, request.assistant]);
      const data = branch(request.branchId);
      const existing = data.turns.get(request.turnId);
      checkRetry(existing, request);
      if (existing?.status === "accepted") return acceptedReceipt(existing);
      if (existing?.assistant && existing.assistant.contentHash !== request.assistant.contentHash)
        throw new Error("Pending narration changed during resolution.");
      const sourceIds = [...new Set(request.review.patch.events.flatMap((event) => event.sources.map((ref) => ref.messageId))
        .concat(request.review.patch.operations.flatMap((operation) => operation.sources.map((ref) => ref.messageId))))];
      const wanted = new Set(sourceIds);
      const sourceMessages = data.messages.filter((message) => wanted.has(message.id));
      const allMessages = new Map([...data.messages, ...sourceMessages].map((message) => [message.id, message]));
      const prepared = prepareCommit({ ...data, messages: [...allMessages.values()] }, existing, request);
      data.state = prepared.state;
      data.messages = prepared.messages;
      data.turns.set(request.turnId, prepared.turn);
      return acceptedReceipt(prepared.turn);
    },
    async failTurn(branchId, turnId, error) {
      const pending = branch(branchId).turns.get(turnId);
      if (pending && !["accepted", "needs_state_review"].includes(pending.status))
        Object.assign(pending, { status: "failed", error: String(error).slice(0, 2000) });
    },
    async history(branchId) {
      const data = branch(branchId);
      return structuredClone({ initial: data.initial, turns: [...data.turns.values()].filter((t) => t.status === "accepted").sort((a, b) => a.revision - b.revision) });
    },
  };
}

// An earlier edit or regeneration starts a separate branch. Accepted patches
// replay without LLM calls, so future plans, beliefs, and messages cannot leak.
export async function forkAtRevision(store, sourceBranchId, revision, newBranchId) {
  validate(id, newBranchId);
  const { initial, turns } = await store.history(sourceBranchId);
  if (!Number.isSafeInteger(revision) || revision < initial.state.revision || revision > (turns.at(-1)?.revision ?? initial.state.revision))
    throw new Error("Revision is outside the available history.");
  let state = structuredClone(initial.state);
  let messages = structuredClone(initial.messages);
  for (const turn of turns.filter((t) => t.revision <= revision)) {
    messages.push(turn.user, turn.assistant);
    if (turn.authorCorrection) messages.push(turn.authorCorrection);
    state = applyContinuityPatch(state, turn.review.patch, { messages,
      throughOrder: turn.authorCorrection?.order ?? turn.assistant.order,
      currentAuthorOrder: turn.authorCorrection?.order, currentInputOrder: turn.user.order });
  }
  state.branchId = newBranchId;
  await store.initialize({ state, messages, parent: { branchId: sourceBranchId, revision } });
  return store.load(newBranchId);
}
