import { prepareBalancedContext, BALANCED_TOOLS, balancedPreparationSettings, balancedPreparationPolicy, balancedDirectoryMessage } from "./balanced.js";
import { DELTA_OUTPUT_SCHEMA, expandDeltaProposal, equalData, applyFieldChange, parseStateOutput } from "./deltas.js";
import { chatCompletion } from "../llm-client.js";
import { countTokens } from "../tokenizer.js";
import { buildContinuityContext, selectContinuity, requestTokenCount, inputBudget, completionBudgetInstruction } from "./context.js";
import { SAVER_POLICY, REVIEWER_CONTRACT } from "./prompts.js";
import { sourceMessage, sourceRef } from "./state.js";
import { prepareCommit, validateReview, acceptedReceipt } from "./store.js";
import { object, list, string, text, id, RECORD_SCHEMA, EVENT_SCHEMA, REVIEW_SCHEMA, validate } from "./schema.js";

const evidence = object({ from: { type: "string", enum: ["input", "narration"] }, quote: string(8000) });
const saverEvent = object({ id, kind: EVENT_SCHEMA.properties.kind, description: string(),
  entityIds: list(id), evidence: { ...list(evidence, 10), minItems: 1 }, supersedes: list(id) });
const operationEvidence = { reason: string(), eventIds: { ...list(id), minItems: 1 },
  evidence: { ...list(evidence, 10), minItems: 1 } };
const fieldChange = object({ action: { type: "string", enum: ["set", "add", "remove", "append"] },
  field: string(100), value: { anyOf: [text, list(string())] } });
const saverOperation = { anyOf: [object({ record: RECORD_SCHEMA, ...operationEvidence }),
  object({ update: object({ id, changes: { ...list(fieldChange, 30), minItems: 1 } }), ...operationEvidence })] };
const LEGACY_SAVER_OUTPUT_SCHEMA = object({ narration: string(50000), events: list(saverEvent),
  operations: list(saverOperation) });

export const SAVER_OUTPUT_SCHEMA = DELTA_OUTPUT_SCHEMA;

export function saverOutputPolicy(settings) {
  return `${SAVER_POLICY}\n\n${completionBudgetInstruction(settings, "narration")}\nJSON SCHEMA:\n${JSON.stringify(SAVER_OUTPUT_SCHEMA)}`;
}

export function expandSaverOperation(operation, state) {
  if (!operation.update) return operation;
  const old = state.records.find((record) => record.id === operation.update.id);
  if (!old) throw new Error("Compact update requires an existing supplied record.");
  const data = structuredClone(old.data);
  for (const change of operation.update.changes) applyFieldChange(data, change);
  const record = { id: old.id, kind: old.kind, data };
  validate(RECORD_SCHEMA, record);
  const { update, ...rest } = operation;
  return { ...rest, record };
}

export function compileSaverProposal(output, state, turnId, user, assistant) {
  if (Object.hasOwn(output, "changes")) return expandDeltaProposal(output, state, turnId, user, assistant);
  validate(LEGACY_SAVER_OUTPUT_SCHEMA, output);
  if (output.narration !== assistant.content) throw new Error("Saver proposal does not match saved narration.");
  const ref = (item) => {
    const message = item.from === "input" ? user : assistant;
    if (!message.content.includes(item.quote)) throw new Error("Saver evidence quote is absent from its source.");
    return sourceRef(message, item.quote);
  };
  return { branchId: state.branchId, baseRevision: state.revision, turnId,
    events: output.events.map(({ evidence: items, ...event }) => ({ ...event, sources: items.map(ref) })),
    operations: output.operations.map((operation) => expandSaverOperation(operation, state)).filter((operation) => {
      const old = state.records.find((record) => record.id === operation.record.id);
      return !old || old.kind !== operation.record.kind || !equalData(old.data, operation.record.data);
    }).map(({ evidence: items, ...operation }) => ({
      type: "put_record", ...operation, expectedVersion: state.records.find((r) => r.id === operation.record.id)?.version ?? 0,
      sources: items.map(ref),
    })) };
}

function protectedChange(state, patch, mode) {
  if (mode === "author") return false;
  const open = state.records.filter((r) => r.kind === "consequence" && r.data.status === "open" &&
    ["grievance", "promise", "loyalty", "conflict"].includes(r.data.category));
  const ranks = {
    trust: { "deep distrust": 0, distrust: 1, low: 1, guarded: 2, neutral: 3, friendly: 4, trusting: 5, "deep trust": 6 },
    affection: { none: 0, low: 1, mild: 1, moderate: 2, strong: 3, high: 3, deep: 4 },
    hostility: { none: 0, low: 1, mild: 1, moderate: 2, strong: 3, high: 3, deep: 4, extreme: 5 },
  };
  const restrictive = (field, old, next) => {
    if (old === next) return true;
    const previous = ranks[field][old.trim().toLowerCase()];
    const current = ranks[field][next.trim().toLowerCase()];
    // Unrecognized free text cannot safely be classified as reconciliation or escalation.
    return previous !== undefined && current !== undefined &&
      (field === "hostility" ? current > previous : current < previous);
  };
  for (const op of patch.operations) {
    const old = state.records.find((r) => r.id === op.record.id);
    if (!old) continue;
    const next = op.record.data;
    if (old.kind === "consequence" && open.some((r) => r.id === old.id)) {
      if (["holder", "target", "category", "status"].some((field) => old.data[field] !== next[field]) ||
          (next.description !== old.data.description && !next.description.startsWith(old.data.description + "\n"))) return true;
    }
    if (old.kind === "relationship" && open.some((r) =>
      (r.data.holder === old.data.from && r.data.target === old.data.to) ||
      (r.data.holder === old.data.to && r.data.target === old.data.from))) {
      if (old.data.from !== next.from || old.data.to !== next.to ||
          !["trust", "affection", "hostility"].every((field) => restrictive(field, old.data[field], next[field])) ||
          !old.data.boundaries.every((boundary) => next.boundaries.includes(boundary))) return true;
    }
  }
  return false;
}

function stateError(error) {
  const message = error.message;
  const category = /schema|JSON|expected|allowed record|field|array|requires an array|length/i.test(message) ? "State format"
    : /target|reference|identify|ID|superseded/i.test(message) ? "State reference"
    : /evidence|source|quote|acquisition|knowledge/i.test(message) ? "State evidence"
    : /relationship|consequence|Baseline|Player inner|author direction/i.test(message) ? "Continuity review" : "State validation";
  return `${category}: ${message}`;
}

function invalidOutputError(response, cause) {
  const content = typeof response.content === "string" ? response.content : "";
  const reasoning = typeof response.thinking === "string" ? response.thinking : "";
  const tokens = response.usage?.completion_tokens;
  const details = [`final text: ${content.length} characters`, `thinking: ${reasoning.length} characters`];
  if (Number.isFinite(tokens)) details.push(`provider output: ${tokens} tokens`);
  if (response.finishReason) details.push(`finish: ${response.finishReason}`);
  if (!content.trim()) return new Error(`Saver received no final answer (${details.join(", ")}). Check the narrator profile's thinking and max output settings.`);
  const excerpt = content.length <= 320 ? content : `${content.slice(0, 160)} … ${content.slice(-160)}`;
  return new Error(`Saver final answer is not valid JSON (${details.join(", ")}; ${cause.message}). Model text excerpt: ${JSON.stringify(excerpt)}`);
}

export async function runSaverTurn({ store, branchId, turnId, input, settings, mode = "player",
  stylePrompt = "", reviewEveryTurn = false, expectedActiveBranchId = branchId, complete = chatCompletion,
  count = countTokens, onStatus = () => {}, signal, balanced = false, onContextStats = () => {} }) {
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
    const policy = saverOutputPolicy(settings);
    const contextSettings = balanced ? balancedPreparationSettings(settings) : settings;
    const built = await buildContinuityContext({ state: snapshot.state, messages: snapshot.messages,
      input, mode, settings: contextSettings, stylePrompt, policy: balanced ? balancedPreparationPolicy(contextSettings) : policy, tools: balanced ? BALANCED_TOOLS : [],
      extraReferences: balanced ? [balancedDirectoryMessage(snapshot.state)] : [],
      budgetCap: balanced ? inputBudget(settings) : Infinity, count });
    let preparation = null;
    if (balanced) {
      onStatus("preparing");
      preparation = await prepareBalancedContext({ built, state: snapshot.state, settings, policy, complete, count, signal });
      onContextStats(preparation.context);
    } else {
      const narrationInputTokens = await requestTokenCount(built.apiMessages, [], count);
      onContextStats({ narrationInputTokens, narrationContextLimit:
        Math.min(settings.maxContextTokens, settings.modelContextTokens ?? Infinity) });
    }
    onStatus("generating");
    const response = await complete({ settings: { ...settings, streaming: false }, messages: built.apiMessages, signal });
    if (response.finishReason !== "stop" || response.toolCalls?.length) throw new Error("Saver response is incomplete.");
    let output;
    try { output = parseStateOutput(response.content); }
    catch (error) { throw invalidOutputError(response, error); }
    if (typeof output.narration !== "string" || !output.narration.trim())
      throw new Error("Saver returned no complete narration.");
    const assistant = await sourceMessage({ id: `${turnId}_assistant`, role: "assistant",
      content: output.narration, order: user.order + 1 });
    const trace = { ...built.trace, mode: balanced ? "balanced" : "saver", preparation: preparation, model: settings.modelId, modelUsage: response.usage ?? null };
    let review;
    try {
      const patch = compileSaverProposal(output, snapshot.state, turnId, user, assistant);
      trace.outputFormat = Object.hasOwn(output, "changes") ? "changes" : "legacy";
      trace.changedRecords = patch.operations.length;
      if (output.operations) trace.ignoredUnchangedRecords = output.operations.length - patch.operations.length;
      const supplied = new Set([...built.trace.recordIds, ...built.selection.futurePossibilities.map((record) => record.id)]);
      if (patch.operations.some((op) => snapshot.state.records.some((r) => r.id === op.record.id) && !supplied.has(op.record.id)))
        throw new Error("Saver changed an existing record absent from its context.");
      if (mode === "author" && !patch.events.length && !patch.operations.length)
        throw new Error("Author note produced no state change.");
      if (protectedChange(snapshot.state, patch, mode))
        throw new Error("A lasting relationship or consequence change needs your review.");
      review = { verdict: "accept", violations: [], patch };
      prepareCommit({ ...snapshot, messages: snapshot.messages }, request,
        { ...request, assistant, review });
    } catch (error) {
      const reason = stateError(error);
      await store.savePendingDraft(request, assistant, output, reason, trace);
      onStatus("needs_state_review");
      return { status: "needs_state_review", turnId, user, assistant, error: reason };
    }
    if (reviewEveryTurn) {
      const reason = "Review every turn is enabled for this story.";
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

export async function editSaverPending({ store, branchId, turnId, narration, expectedAssistantHash,
  expectedActiveBranchId = branchId }) {
  const pending = await store.readTurn(branchId, turnId);
  if (pending?.status !== "needs_state_review") throw new Error("No pending narration to edit.");
  const assistant = await sourceMessage({ ...pending.assistant, content: narration,
    revision: pending.assistant.revision + 1 });
  return store.changePendingDraft({ branchId, turnId, action: "edit", assistant,
    expectedAssistantHash: expectedAssistantHash ?? pending.assistant.contentHash, expectedActiveBranchId });
}

export async function rejectSaverPending({ store, branchId, turnId, expectedAssistantHash,
  expectedActiveBranchId = branchId }) {
  const pending = await store.readTurn(branchId, turnId);
  if (pending?.status !== "needs_state_review") throw new Error("No pending draft to reject.");
  return store.changePendingDraft({ branchId, turnId, action: "reject",
    expectedAssistantHash: expectedAssistantHash ?? pending.assistant.contentHash, expectedActiveBranchId });
}

export async function acceptSaverPending({ store, branchId, turnId }) {
  const pending = await store.readTurn(branchId, turnId);
  if (pending?.status !== "needs_state_review") throw new Error("No Saver turn needs approval.");
  const snapshot = await store.load(branchId);
  const patch = compileSaverProposal(pending.proposal, snapshot.state, turnId,
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
  const simple = Object.hasOwn(pending.proposal, "changes");
  const repairSettings = { ...settings, streaming: false,
    maxResponseTokens: settings.continuityReviewMaxTokens ?? 4096,
    reasoning: { ...settings.reasoning, enabled: false } };
  const messages = [{ role: "system", content: simple ?
    "Repair state for the supplied saved narration. Return exactly one JSON object with a changes array and no other fields. The narration is already saved; do not repeat or rewrite it. Each change cites a short exact excerpt from the supplied current input or saved narration. Omit unchanged state. Do not invent a causal development to justify a rejected change. The app assigns IDs and merges valid changes.\nSCHEMA:\n" +
    JSON.stringify(object({ changes: DELTA_OUTPUT_SCHEMA.properties.changes })) : REVIEWER_CONTRACT +
    "\nRepair the saved narration's state only. Do not rewrite narration.\nSCHEMA:\n" + JSON.stringify(REVIEW_SCHEMA) },
  { role: "user", content: JSON.stringify(reviewInput) }];
  if (await requestTokenCount(messages, [], count) > inputBudget(repairSettings))
    throw new Error("State repair exceeds the context budget.");
  const response = await complete({ settings: repairSettings, messages });
  if (response.finishReason !== "stop" || response.toolCalls?.length)
    throw new Error("State repair response is incomplete.");
  let review;
  try {
    const parsed = parseStateOutput(response.content);
    review = simple ? { verdict: "accept", violations: [], patch: compileSaverProposal({ narration: pending.assistant.content, ...parsed }, snapshot.state,
      turnId, pending.user, pending.assistant) } : parsed;
    validateReview(review, pending);
    if (simple && protectedChange(snapshot.state, review.patch, pending.user.role === "author" ? "author" : "player"))
      throw new Error("A lasting relationship or consequence change still needs your review.");
    if (simple && pending.user.role === "author" && !review.patch.events.length && !review.patch.operations.length)
      throw new Error("Author note produced no state change.");
  }
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

// Shares atomic saves, protected-state checks, pending review, and retry handling.
export function runBalancedTurn(options) {
  return runSaverTurn({ ...options, balanced: true });
}
