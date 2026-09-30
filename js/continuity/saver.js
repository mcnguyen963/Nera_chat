import { chatCompletion } from "../llm-client.js";
import { countTokens } from "../tokenizer.js";
import { buildContinuityContext, selectContinuity, requestTokenCount, inputBudget } from "./context.js";
import { SAVER_POLICY, REVIEWER_CONTRACT } from "./prompts.js";
import { sourceMessage, sourceRef } from "./state.js";
import { prepareCommit, validateReview, acceptedReceipt } from "./store.js";
import { object, list, string, id, RECORD_SCHEMA, EVENT_SCHEMA, REVIEW_SCHEMA, validate } from "./schema.js";

const evidence = object({ from: { type: "string", enum: ["input", "narration"] }, quote: string(8000) });
const saverEvent = object({ id, kind: EVENT_SCHEMA.properties.kind, description: string(),
  entityIds: list(id), evidence: { ...list(evidence, 10), minItems: 1 }, supersedes: list(id) });
const saverOperation = object({ record: RECORD_SCHEMA, reason: string(), eventIds: { ...list(id), minItems: 1 },
  evidence: { ...list(evidence, 10), minItems: 1 } });
export const SAVER_OUTPUT_SCHEMA = object({ narration: string(50000), events: list(saverEvent),
  operations: list(saverOperation) });

function compileProposal(output, state, turnId, user, assistant) {
  validate(SAVER_OUTPUT_SCHEMA, output);
  if (output.narration !== assistant.content) throw new Error("Saver proposal does not match saved narration.");
  const ref = (item) => {
    const message = item.from === "input" ? user : assistant;
    if (!message.content.includes(item.quote)) throw new Error("Saver evidence quote is absent from its source.");
    return sourceRef(message, item.quote);
  };
  return { branchId: state.branchId, baseRevision: state.revision, turnId,
    events: output.events.map(({ evidence: items, ...event }) => ({ ...event, sources: items.map(ref) })),
    operations: output.operations.map(({ evidence: items, ...operation }) => ({
      type: "put_record", ...operation, expectedVersion: state.records.find((r) => r.id === operation.record.id)?.version ?? 0,
      sources: items.map(ref),
    })) };
}

function protectedChange(state, patch, mode) {
  if (mode === "author") return false;
  const open = state.records.filter((r) => r.kind === "consequence" && r.data.status === "open" &&
    ["grievance", "promise", "loyalty", "conflict"].includes(r.data.category));
  for (const op of patch.operations) {
    const old = state.records.find((r) => r.id === op.record.id);
    if (!old) continue;
    if (old.kind === "consequence" && open.some((r) => r.id === old.id) &&
        JSON.stringify(op.record.data) !== JSON.stringify(old.data)) return true;
    if (old.kind === "relationship" && JSON.stringify(old.data) !== JSON.stringify(op.record.data) &&
        open.some((r) => (r.data.holder === old.data.from && r.data.target === old.data.to) ||
          (r.data.holder === old.data.to && r.data.target === old.data.from))) return true;
  }
  return false;
}

export async function runSaverTurn({ store, branchId, turnId, input, settings, mode = "player",
  stylePrompt = "", reviewEveryTurn = false, expectedActiveBranchId = branchId, complete = chatCompletion,
  count = countTokens, onStatus = () => {}, signal }) {
  if (!["player", "author"].includes(mode) || !input?.trim()) throw new Error("Invalid Saver input.");
  const existing = await store.readTurn(branchId, turnId);
  if (existing && (existing.user.content !== input || existing.user.role !== (mode === "author" ? "author" : "user")))
    throw new Error("Turn ID was already used for different input.");
  if (existing?.status === "accepted") return acceptedReceipt(existing);
  if (existing?.status === "needs_state_review") return { status: existing.status, turnId,
    user: existing.user, assistant: existing.assistant, error: existing.error };
  const pendingOther = await store.readPending(branchId);
  if (pendingOther) throw new Error("Resolve the pending Saver turn before continuing.");
  const snapshot = await store.load(branchId);
  const user = await sourceMessage({ id: `${turnId}_user`, role: mode === "author" ? "author" : "user",
    content: input, order: snapshot.state.throughOrder + 1 });
  const request = { branchId, turnId, baseRevision: snapshot.state.revision,
    expectedActiveBranchId, user };
  await store.beginTurn(request);
  try {
    signal?.throwIfAborted();
    onStatus("building_context");
    const policy = `${SAVER_POLICY}\nJSON SCHEMA:\n${JSON.stringify(SAVER_OUTPUT_SCHEMA)}`;
    const built = await buildContinuityContext({ state: snapshot.state, messages: snapshot.messages,
      input, mode, settings, stylePrompt, policy, tools: [], count });
    onStatus("generating");
    const response = await complete({ settings: { ...settings, streaming: false }, messages: built.apiMessages, signal });
    if (response.finishReason !== "stop" || response.toolCalls?.length) throw new Error("Saver response is incomplete.");
    let output;
    try { output = JSON.parse(response.content); }
    catch { throw new Error("Saver did not return parseable narration and state JSON."); }
    if (typeof output.narration !== "string" || !output.narration.trim())
      throw new Error("Saver returned no complete narration.");
    const assistant = await sourceMessage({ id: `${turnId}_assistant`, role: "assistant",
      content: output.narration, order: user.order + 1 });
    const trace = { ...built.trace, mode: "saver", model: settings.modelId, modelUsage: response.usage ?? null };
    let review;
    try {
      const patch = compileProposal(output, snapshot.state, turnId, user, assistant);
      const supplied = new Set([...built.trace.recordIds, ...built.selection.futurePossibilities.map((record) => record.id)]);
      if (patch.operations.some((op) => snapshot.state.records.some((r) => r.id === op.record.id) && !supplied.has(op.record.id)))
        throw new Error("Saver changed an existing record absent from its context.");
      if (mode === "author" && (!patch.events.length || !patch.operations.length))
        throw new Error("Author note produced no state change.");
      if (protectedChange(snapshot.state, patch, mode))
        throw new Error("A lasting relationship or consequence change needs your review.");
      review = { verdict: "accept", violations: [], patch };
      prepareCommit({ ...snapshot, messages: snapshot.messages }, request,
        { ...request, assistant, review });
    } catch (error) {
      await store.savePendingDraft(request, assistant, output, error.message, trace);
      onStatus("needs_state_review");
      return { status: "needs_state_review", turnId, user, assistant, error: error.message };
    }
    if (reviewEveryTurn) {
      const reason = "Review every Saver turn is enabled for this story.";
      await store.savePendingDraft(request, assistant, output, reason, trace);
      onStatus("needs_state_review");
      return { status: "needs_state_review", turnId, user, assistant, error: reason };
    }
    onStatus("saving");
    const receipt = await store.commitTurn({ ...request, assistant, review,
      trace });
    onStatus("accepted");
    return receipt;
  } catch (error) {
    await store.failTurn(branchId, turnId, error.message).catch(() => {});
    onStatus("failed");
    throw error;
  }
}

export async function acceptSaverPending({ store, branchId, turnId }) {
  const pending = await store.readTurn(branchId, turnId);
  if (pending?.status !== "needs_state_review") throw new Error("No Saver turn needs approval.");
  const snapshot = await store.load(branchId);
  const patch = compileProposal(pending.proposal, snapshot.state, turnId,
    pending.user, pending.assistant);
  const request = { branchId, turnId, baseRevision: pending.baseRevision,
    expectedActiveBranchId: pending.expectedActiveBranchId, user: pending.user,
    assistant: pending.assistant, review: { verdict: "accept", violations: [], patch },
    trace: { mode: "saver_manual_approval" } };
  prepareCommit(snapshot, pending, request);
  return store.commitTurn(request);
}

export async function repairSaverTurn({ store, branchId, turnId, settings,
  complete = chatCompletion, count = countTokens }) {
  const pending = await store.readTurn(branchId, turnId);
  if (pending?.status !== "needs_state_review") throw new Error("No Saver turn needs repair.");
  const snapshot = await store.load(branchId);
  if (snapshot.state.revision !== pending.baseRevision) throw new Error("Story changed since the pending turn.");
  const selected = selectContinuity(snapshot.state, `${pending.user.content}\n${pending.assistant.content}`);
  const records = [...selected.records, ...selected.futurePossibilities];
  const sourceIds = [...new Set([...records, ...selected.events].flatMap((item) =>
    item.sources.map((source) => source.messageId)))];
  const oldSources = await store.readSources(branchId, sourceIds);
  const sources = [...oldSources, pending.user, pending.assistant].map((item) => ({
    id: item.id, role: item.role, revision: item.revision, order: item.order,
    contentHash: item.contentHash, context: [pending.user.id, pending.assistant.id].includes(item.id)
      ? item.content : item.content.slice(-4000),
    quotes: [...new Set([...records, ...selected.events].flatMap((record) => record.sources)
      .filter((source) => source.messageId === item.id).map((source) => source.quote))],
  }));
  const reviewInput = { branchId, baseRevision: pending.baseRevision, turnId,
    priorState: { records, events: selected.events }, sources,
    narration: pending.assistant.content, proposed: pending.proposal,
    previousError: pending.error, planProposals: [] };
  const messages = [{ role: "system", content: REVIEWER_CONTRACT +
    "\nRepair the saved narration's state only. Do not rewrite narration.\nSCHEMA:\n" + JSON.stringify(REVIEW_SCHEMA) },
  { role: "user", content: JSON.stringify(reviewInput) }];
  if (await requestTokenCount(messages, [], count) > inputBudget({ ...settings,
    maxResponseTokens: settings.continuityReviewMaxTokens ?? 4096 }))
    throw new Error("State repair exceeds the context budget.");
  const response = await complete({ settings: { ...settings, streaming: false,
    maxResponseTokens: settings.continuityReviewMaxTokens ?? 4096,
    reasoning: { ...settings.reasoning, enabled: false } }, messages });
  if (response.finishReason !== "stop" || response.toolCalls?.length)
    throw new Error("State repair response is incomplete.");
  let review;
  try { review = JSON.parse(response.content); validateReview(review, pending); }
  catch (error) { throw new Error("State repair failed: " + error.message); }
  for (const operation of review.patch.operations) {
    if (snapshot.state.records.some((record) => record.id === operation.record.id) &&
        !records.some((record) => record.id === operation.record.id))
      throw new Error("State repair changed an unseen existing record.");
  }
  const request = { branchId, turnId, baseRevision: pending.baseRevision,
    expectedActiveBranchId: pending.expectedActiveBranchId, user: pending.user };
  return store.commitTurn({ ...request, assistant: pending.assistant, review,
    trace: { mode: "saver_repair", repairModel: settings.modelId, repairUsage: response.usage ?? null } });
}

function entities(record) {
  const d = record.data;
  if (record.kind === "character") return [record.id];
  if (record.kind === "relationship") return [d.from, d.to];
  if (record.kind === "belief") return [d.holder];
  if (record.kind === "consequence") return [d.holder, d.target];
  if (record.kind === "scene") return d.present;
  if (record.kind === "agenda") return d.participants;
  if (record.kind === "world_fact") return d.entityIds;
  return [];
}

export async function saveManualState({ store, branchId, records, pendingTurnId = null, expectedRevision }) {
  if (!Array.isArray(records)) throw new Error("State table is invalid.");
  records.forEach((record) => validate(RECORD_SCHEMA, record));
  const snapshot = await store.load(branchId);
  if (expectedRevision !== undefined && snapshot.state.revision !== expectedRevision)
    throw new Error("Story state changed on another device. Reload the state table before saving.");
  const changes = records.filter((record) => {
    const old = snapshot.state.records.find((item) => item.id === record.id);
    return !old || old.kind !== record.kind || JSON.stringify(old.data) !== JSON.stringify(record.data);
  });
  const pending = pendingTurnId ? await store.readTurn(branchId, pendingTurnId) : null;
  if (pendingTurnId && pending?.status !== "needs_state_review")
    throw new Error("Pending Saver turn is no longer available.");
  if (!pending && await store.readPending(branchId))
    throw new Error("Resolve the pending Saver turn first.");
  if (!changes.length && !pending) throw new Error("No state changes to save.");
  const turnId = pending?.turnId ?? `manual_${crypto.randomUUID().replaceAll("-", "")}`;
  const note = changes.length
    ? changes.map((record) => `Author correction for ${record.id}: ${JSON.stringify(record)}`).join("\n")
    : "Author reviewed the pending narration and approved no state changes.";
  const user = pending?.user ?? await sourceMessage({ id: `${turnId}_user`, role: "author",
    content: note, order: snapshot.state.throughOrder + 1 });
  const assistant = pending?.assistant ?? await sourceMessage({ id: `${turnId}_assistant`, role: "assistant",
    content: "Story state updated by the author.", order: user.order + 1 });
  const authorCorrection = pending && changes.length ? { ...await sourceMessage({ id: `${turnId}_author`,
    role: "author", content: note, order: assistant.order + 1 }), audit: true } : null;
  const authorSource = authorCorrection ?? user;
  const events = changes.map((record, index) => ({
    id: `manual_event_${crypto.randomUUID().replaceAll("-", "")}_${index}`,
    kind: snapshot.state.records.some((item) => item.id === record.id) ? "author_correction" : "author_setup",
    description: `Author correction for ${record.id}.`, entityIds: [...new Set(entities(record))],
    sources: [sourceRef(authorSource, `Author correction for ${record.id}`)], supersedes: [],
  }));
  const operations = changes.map((record, index) => ({ type: "put_record", record,
    expectedVersion: snapshot.state.records.find((item) => item.id === record.id)?.version ?? 0,
    reason: "Manual author correction.", eventIds: [events[index].id],
    sources: events[index].sources }));
  const request = pending ? { branchId, turnId, baseRevision: pending.baseRevision,
    expectedActiveBranchId: pending.expectedActiveBranchId, user }
    : { branchId, turnId, baseRevision: snapshot.state.revision,
      expectedActiveBranchId: branchId, user };
  if (!pending) await store.beginTurn(request);
  return store.commitTurn({ ...request, assistant, authorCorrection,
    review: { verdict: "accept", violations: [], patch: { branchId,
      baseRevision: request.baseRevision, turnId, events, operations } },
    trace: { mode: "manual_author_correction" } });
}
